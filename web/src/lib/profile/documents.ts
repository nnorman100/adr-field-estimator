import { eq } from 'drizzle-orm';
import { companies } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { readDocumentSettings, type DocumentSettings as StoredSettings } from './settings';

export type PhotoLogGrouping = StoredSettings['photo_log_grouping'];

// What the four documents take from the company (docs/plans/S5.md, S5a-9 and its 2026-11-13
// correction): the profile the owner sets on Company settings (S5a-4), the letterhead fields and the
// document settings. This is the one reader the documents use. The letterhead fields and the
// document settings are stored since S5a-4b (migration 0013). Of them only the photo log grouping
// (S5a-9c) is printed so far, read through the settings schema; the letterhead comes back empty and
// the layout and company clauses at their neutral defaults (the itemized layout, no company clauses)
// until S5a-9b reads them.
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
 * The document settings the documents can print. The photo log grouping is the company's own since
 * S5a-9c; the other layouts and company clauses are S5a-9b, and widening these types is what makes
 * that step handle them (the compiler finds every place that prints a document).
 */
export type DocumentSettings = {
  proposalLayout: 'itemized';
  companyClauses: readonly [];
  photoLogGrouping: PhotoLogGrouping;
};

export type CompanyDocuments = { identity: CompanyIdentity; letterhead: Letterhead; settings: DocumentSettings };

export const NEUTRAL_LETTERHEAD: Letterhead = Object.freeze({ emergencyPhone: '', fax: '', website: '', tagline: '', mailingAddress: '' });

export const NEUTRAL_SETTINGS: DocumentSettings = Object.freeze({ proposalLayout: 'itemized', companyClauses: [] as const, photoLogGrouping: 'room' });

/**
 * The company's document inputs, read in the caller's transaction for its own company; null for no
 * such company. Stored settings that do not read through the settings schema throw (ZodError): they
 * are never used, as a price version that does not parse is never priced from.
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
      documents: companies.profileDocuments,
    })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!row) return null;
  const { documents, ...identity } = row;
  const stored = readDocumentSettings(documents);
  return { identity, letterhead: { ...NEUTRAL_LETTERHEAD }, settings: { ...NEUTRAL_SETTINGS, photoLogGrouping: stored.photo_log_grouping } };
}
