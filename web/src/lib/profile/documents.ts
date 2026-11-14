import { eq } from 'drizzle-orm';
import { companies } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';

// What the four documents take from the company (docs/plans/S5.md, S5a-9 and its 2026-11-13
// correction): the profile the owner sets on Company settings (S5a-4), the letterhead fields and the
// document settings. This is the one reader the documents use. The letterhead fields and the
// document settings are stored since S5a-4b (migration 0013), but no document prints them yet, so
// this returns them empty and at their neutral defaults (the itemized layout, no company clauses,
// the photo log grouped by room) until S5a-9b and S5a-9c read them.
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
 * The document settings S5a-9 can print. Only the neutral defaults exist so far: the other layouts,
 * company clauses and grouping are S5a-9b and S5a-9c, and widening these types is what makes those
 * steps handle them (the compiler finds every place that prints a document).
 */
export type DocumentSettings = {
  proposalLayout: 'itemized';
  companyClauses: readonly [];
  photoLogGrouping: 'room';
};

export type CompanyDocuments = { identity: CompanyIdentity; letterhead: Letterhead; settings: DocumentSettings };

export const NEUTRAL_LETTERHEAD: Letterhead = Object.freeze({ emergencyPhone: '', fax: '', website: '', tagline: '', mailingAddress: '' });

export const NEUTRAL_SETTINGS: DocumentSettings = Object.freeze({ proposalLayout: 'itemized', companyClauses: [] as const, photoLogGrouping: 'room' });

/** The company's document inputs, read in the caller's transaction for its own company; null for no such company. */
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
    })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!row) return null;
  return { identity: row, letterhead: { ...NEUTRAL_LETTERHEAD }, settings: NEUTRAL_SETTINGS };
}
