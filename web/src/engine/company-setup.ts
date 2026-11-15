// The company setup check: what a company must have filled in before any document is issued with
// its name on it. The documents (documents.ts) and the owner's company settings (S5a-4) both read
// this one list, so the screen can never say "ready" while the documents say "not signable".
//
// Since S5a-4b the check also knows the two texts printed on the signed page, the start-work
// authorization and the payment terms (the company's document settings). Given them, it lists an
// empty one as missing before signing. The settings screen passes them, and so do the estimate's
// documents since S5a-11, so documents without them are not signable and signing is refused.

export type SetupFields = { name: string; address: string; license: string; signoff: string };

/** The company's own wording for the signed page (document settings, S5a-4b). */
export type SigningTexts = { authorizationText: string; paymentTermsText: string };

// The labels are the owner's words for the fields, in the order the settings screen asks for them.
const SETUP_FIELDS = [
  ['name', 'Company name'],
  ['address', 'Company address'],
  ['license', 'CSLB license'],
  ['signoff', 'Document sign-off'],
] as const;

const SIGNING_FIELDS = [
  ['authorizationText', 'Start-work authorization'],
  ['paymentTermsText', 'Payment terms'],
] as const;

/**
 * The labels of the required company fields that are empty or only blank space, in screen order;
 * with the signing texts, also those of the two the signed page needs, after the others.
 */
export function companySetupMissing(fields: SetupFields, signing?: SigningTexts): string[] {
  const missing = SETUP_FIELDS.flatMap(([key, label]) => (fields[key].trim() ? [] : [label]));
  if (!signing) return missing;
  return [...missing, ...SIGNING_FIELDS.flatMap(([key, label]) => (signing[key].trim() ? [] : [label]))];
}
