import { eq } from 'drizzle-orm';
import { companies } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import type { SigningTexts } from '@/engine/company-setup';
import { readDocumentSettings, type CompanyClause, type DocumentSettings as StoredSettings } from './settings';

export type PhotoLogGrouping = StoredSettings['photo_log_grouping'];

// What the four documents take from the company (docs/plans/S5.md, S5a-9 and its 2026-11-13
// correction): the profile the owner sets on Company settings (S5a-4), the letterhead fields and the
// document settings (S5a-4b, migration 0013). This is the one reader the documents use. Since
// S5a-9b the proposal prints the letterhead fields that are set, in the company's chosen layout,
// with its own clauses; the photo log is grouped as the company chose (S5a-9c). The start-work
// authorization and the payment terms (S5a-11) print exactly as the owner entered them, above the
// signature, inside the bytes the signature binds.
// Nothing here is seeded with any company's own values; each company's identity comes only from its
// own row and prints exactly as entered.

export type CompanyIdentity = {
  companyId: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  license: string;
  signoff: string;
};

/** S5a-4b's letterhead fields, empty until set. A field that is empty is not printed. */
export type Letterhead = {
  emergencyPhone: string;
  fax: string;
  website: string;
  tagline: string;
  mailingAddress: string;
};

/**
 * The document settings the documents print: the proposal layout and the company's own clauses
 * (S5a-9b) and the photo log grouping (S5a-9c). Widening these types is what makes a later step
 * handle a new option (the compiler finds every place that prints a document).
 */
export type DocumentSettings = {
  proposalLayout: 'itemized' | 'letter';
  companyClauses: readonly CompanyClause[];
  photoLogGrouping: PhotoLogGrouping;
};

export type CompanyDocuments = {
  identity: CompanyIdentity;
  letterhead: Letterhead;
  settings: DocumentSettings;
  signing: SigningTexts;
  // S5b-6: a revised estimate's heading names the previous price before signing (off unless set).
  showPreviousPrice?: boolean;
};

export const NEUTRAL_LETTERHEAD: Letterhead = Object.freeze({ emergencyPhone: '', fax: '', website: '', tagline: '', mailingAddress: '' });

export const NEUTRAL_SETTINGS: DocumentSettings = Object.freeze({ proposalLayout: 'itemized', companyClauses: [] as const, photoLogGrouping: 'room' });

/**
 * The company's document inputs, read in the caller's transaction for its own company; null for no
 * such company. Stored settings that do not read through their schema throw (ZodError): they are
 * never printed, as the profile route answers 503 for them.
 */
export async function readCompanyDocuments(tx: CompanyTransaction, companyId: string): Promise<CompanyDocuments | null> {
  const [row] = await tx
    .select({
      companyId: companies.id,
      name: companies.name,
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
    })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!row) return null;
  const { documents, emergencyPhone, fax, website, tagline, mailingAddress, ...identity } = row;
  const settings = readDocumentSettings(documents);
  return {
    identity,
    letterhead: { emergencyPhone, fax, website, tagline, mailingAddress },
    settings: { proposalLayout: settings.proposal_layout, companyClauses: settings.company_clauses, photoLogGrouping: settings.photo_log_grouping },
    signing: { authorizationText: settings.authorization_text, paymentTermsText: settings.payment_terms_text },
    showPreviousPrice: settings.show_previous_price,
  };
}
