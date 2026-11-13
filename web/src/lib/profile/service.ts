import { eq } from 'drizzle-orm';
import { auditEvents, companies } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { companySetupMissing } from '@/engine/company-setup';
import { PROFILE_FIELDS, type ProfileInput } from './schema';

// The company profile (S5a-4): the address, phone, email, licence and sign-off the four documents
// print, held on the company's own row (migration 0010). Every function runs inside withCompany for
// the company id of the verified sign-in, so row-level security limits it to that company; the
// owner-only rule is the route's (src/lib/profile/http.ts), as the plan says. A change writes one
// audit row in the same transaction, holding the actor and a count, never a value.

export const PROFILE_ERRORS = {
  // The caller's role does not manage the profile (the owner does).
  not_allowed: 403,
  // The company in the path is not the caller's, or does not exist.
  not_found: 404,
} as const;
export type ProfileErrorCode = keyof typeof PROFILE_ERRORS;

export class ProfileError extends Error {
  readonly status: number;
  constructor(readonly code: ProfileErrorCode) {
    super(`Profile request refused: ${code}`);
    this.name = 'ProfileError';
    this.status = PROFILE_ERRORS[code];
  }
}

export type ProfileView = ProfileInput & {
  companyId: string;
  // Read-only here: the platform operator sets it.
  name: string;
  // What the engine's setup check says is still missing before documents can be issued.
  setupMissing: string[];
};

export type ProfileService = {
  read(companyId: string): Promise<ProfileView>;
  save(companyId: string, actorId: string, input: ProfileInput): Promise<ProfileView>;
};

type Row = {
  id: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  license: string;
  signoff: string;
};

export function profileOf(row: Row): ProfileView {
  const { id, name, address, phone, email, license, signoff } = row;
  return { companyId: id, name, address, phone, email, license, signoff, setupMissing: companySetupMissing(row) };
}

const columns = {
  id: companies.id,
  name: companies.name,
  address: companies.profileAddress,
  phone: companies.profilePhone,
  email: companies.profileEmail,
  license: companies.profileLicense,
  signoff: companies.profileSignoff,
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
        const current = await rowOf(tx, companyId, true);
        const changed = PROFILE_FIELDS.filter((field) => current[field] !== input[field]);
        if (changed.length === 0) return profileOf(current);
        await tx
          .update(companies)
          .set({
            profileAddress: input.address,
            profilePhone: input.phone,
            profileEmail: input.email,
            profileLicense: input.license,
            profileSignoff: input.signoff,
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
        await tx.insert(auditEvents).values({
          companyId,
          actorId,
          operatorActorId: null,
          action: 'company_profile_saved',
          target: companyId,
          details: { fields_changed: changed.length },
        });
        return profileOf({ ...current, ...input });
      }),
  };
}
