import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, companies } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { companySetupMissing } from '@/engine/company-setup';
import { LETTERHEAD_FIELDS, PROFILE_FIELDS, type LetterheadValues, type ProfileInput, type ProfileValues } from './schema';
import { changedDocumentSettings, readDocumentSettings, type DocumentSettings } from './settings';

// The company profile (S5a-4): the address, phone, email, licence and sign-off the four documents
// print, and since S5a-4b the letterhead lines and the document settings, held on the company's own
// row (migrations 0010 and 0013). Every function runs inside withCompany for the company id of the
// verified sign-in, so row-level security limits it to that company; the owner-only rule is the
// route's (src/lib/profile/http.ts), as the plan says. A change writes one audit row in the same
// transaction, holding the actor, the change id and a count, never a value. The company row's
// updated_at is the profile's revision: a save names the revision it was based on and changes the
// row only while that is still the stored one.

export const PROFILE_ERRORS = {
  // The caller's role does not manage the profile (the owner does).
  not_allowed: 403,
  // The company in the path is not the caller's, or does not exist.
  not_found: 404,
  // The profile changed since the revision the save was based on; the answer holds the current one.
  stale_revision: 409,
} as const;
export type ProfileErrorCode = keyof typeof PROFILE_ERRORS;

export class ProfileError extends Error {
  readonly status: number;
  constructor(
    readonly code: ProfileErrorCode,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(`Profile request refused: ${code}`);
    this.name = 'ProfileError';
    this.status = PROFILE_ERRORS[code];
  }
}

export type ProfileView = ProfileValues &
  LetterheadValues & {
    companyId: string;
    // What a save names as the revision it was based on.
    revision: string;
    // Read-only here: the platform operator sets it.
    name: string;
    // The document settings, read through their one schema (src/lib/profile/settings.ts).
    documents: DocumentSettings;
    // What the engine's setup check says is still missing before documents can be issued and signed.
    setupMissing: string[];
  };

export type ProfileService = {
  read(companyId: string): Promise<ProfileView>;
  save(companyId: string, actorId: string, input: ProfileInput): Promise<ProfileView>;
};

type Row = ProfileValues &
  LetterheadValues & {
    id: string;
    name: string;
    revision: string;
    // The stored settings as the database holds them, not yet read through the schema.
    documents: unknown;
  };

export function profileOf(row: Row): ProfileView {
  const { id, name, revision, address, phone, email, license, signoff, emergencyPhone, fax, website, tagline, mailingAddress } = row;
  const documents = readDocumentSettings(row.documents);
  const signing = { authorizationText: documents.authorization_text, paymentTermsText: documents.payment_terms_text };
  return {
    companyId: id,
    name,
    revision,
    address,
    phone,
    email,
    license,
    signoff,
    emergencyPhone,
    fax,
    website,
    tagline,
    mailingAddress,
    documents,
    setupMissing: companySetupMissing(row, signing),
  };
}

export type ProfileRecord = ProfileValues & LetterheadValues & { documents: DocumentSettings };

/**
 * What a save asks the profile to become, and which fields that changes. The five S5a-4 fields are
 * always sent; a letterhead line or the settings left out keep what is stored. The service and its
 * local stand-in both decide by this.
 */
export function nextProfile(current: ProfileView, input: ProfileInput): { values: ProfileRecord; changed: string[] } {
  const values: ProfileRecord = {
    address: input.address,
    phone: input.phone,
    email: input.email,
    license: input.license,
    signoff: input.signoff,
    emergencyPhone: input.emergencyPhone ?? current.emergencyPhone,
    fax: input.fax ?? current.fax,
    website: input.website ?? current.website,
    tagline: input.tagline ?? current.tagline,
    mailingAddress: input.mailingAddress ?? current.mailingAddress,
    documents: input.documents ?? current.documents,
  };
  const changed = [
    ...[...PROFILE_FIELDS, ...LETTERHEAD_FIELDS].filter((field) => current[field] !== values[field]),
    ...changedDocumentSettings(current.documents, values.documents),
  ];
  return { values, changed };
}

const revisionOf = sql<string>`to_char(${companies.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const columns = {
  id: companies.id,
  name: companies.name,
  revision: revisionOf,
  address: companies.profileAddress,
  phone: companies.profilePhone,
  email: companies.profileEmail,
  license: companies.profileLicense,
  signoff: companies.profileSignoff,
  emergencyPhone: companies.profileEmergencyPhone,
  fax: companies.profileFax,
  website: companies.profileWebsite,
  tagline: companies.profileTagline,
  mailingAddress: companies.profileMailingAddress,
  documents: companies.profileDocuments,
};

async function rowOf(tx: CompanyTransaction, companyId: string, lock: boolean): Promise<Row> {
  const query = tx.select(columns).from(companies).where(eq(companies.id, companyId));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new ProfileError('not_found');
  return row;
}

export function profileService(db: Database): ProfileService {
  return {
    read: (companyId) => withCompany(db, companyId, async (tx) => profileOf(await rowOf(tx, companyId, false))),

    save: (companyId, actorId, input) =>
      withCompany(db, companyId, async (tx) => {
        const current = profileOf(await rowOf(tx, companyId, true));
        const { values, changed } = nextProfile(current, input);
        // Already what is stored (a retry after a lost answer, or no change at all): not a conflict.
        if (changed.length === 0) return current;
        const [updated] = await tx
          .update(companies)
          .set({
            profileAddress: values.address,
            profilePhone: values.phone,
            profileEmail: values.email,
            profileLicense: values.license,
            profileSignoff: values.signoff,
            profileEmergencyPhone: values.emergencyPhone,
            profileFax: values.fax,
            profileWebsite: values.website,
            profileTagline: values.tagline,
            profileMailingAddress: values.mailingAddress,
            profileDocuments: values.documents,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(companies.id, companyId), sql`${revisionOf} = ${input.revision}`))
          .returning({ revision: revisionOf });
        if (!updated) throw new ProfileError('stale_revision', { profile: current });
        await tx.insert(auditEvents).values({
          companyId,
          actorId,
          operatorActorId: null,
          action: 'company_profile_saved',
          target: companyId,
          details: { fields_changed: changed.length, change_id: input.changeId },
        });
        return profileOf({ id: companyId, name: current.name, revision: updated.revision, ...values });
      }),
  };
}
