// The company setup check: what a company must have filled in before any document is issued with
// its name on it. The documents (documents.ts) and the owner's company settings (S5a-4) both read
// this one list, so the screen can never say "ready" while the documents say "not signable".

export type SetupFields = { name: string; address: string; license: string; signoff: string };

// The labels are the owner's words for the fields, in the order the settings screen asks for them.
const SETUP_FIELDS = [
  ['name', 'Company name'],
  ['address', 'Company address'],
  ['license', 'CSLB license'],
  ['signoff', 'Document sign-off'],
] as const;

/** The labels of the required company fields that are empty or only blank space, in screen order. */
export function companySetupMissing(fields: SetupFields): string[] {
  return SETUP_FIELDS.flatMap(([key, label]) => (fields[key].trim() ? [] : [label]));
}
