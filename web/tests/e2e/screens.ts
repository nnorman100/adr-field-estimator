// Every page under src/app, as its route pattern, with the e2e spec (in this folder) that checks
// it with axe. tests/unit/screens.test.ts fails on a page with no entry here, or an entry whose
// spec does not exist or never runs an axe check, so a new screen cannot ship unchecked.
// A route group such as (auth) is left out of the pattern, as it is not part of the address.
export const SCREENS: Record<string, string> = {
  '/': 'start-page.spec.ts',
  '/field': 'field-shell.spec.ts',
  '/sign-in/[address]': 'sign-in.spec.ts',
  '/sign-in/[address]/team': 'team.spec.ts',
  '/sign-in/[address]/company': 'company.spec.ts',
  '/sign-in/[address]/prices': 'prices.spec.ts',
  '/sign-in/[address]/jobs/[jobId]/finish': 'finish.spec.ts',
  '/sign-in/[address]/jobs/[jobId]/review': 'review.spec.ts',
  '/sign-in/[address]/invitations/[invitationId]': 'sign-in.spec.ts',
  '/operator/[tenantId]': 'operator.spec.ts',
  '/operator/[tenantId]/companies/[companyId]': 'operator.spec.ts',
  '/operator/[tenantId]/companies/[companyId]/team': 'operator.spec.ts',
};

// The views of the field page (S5a-6): every field screen is a view of /field picked by the
// address's query (src/lib/field/views.ts), because the field worker answers every /field address
// with the one kept shell page. Each view is listed here with the spec that runs axe on it (by
// visiting every view of src/lib/field/views.ts); tests/unit/screens.test.ts fails on a view with no
// entry.
export const FIELD_VIEW_SCREENS: Record<string, string> = {
  jobs: 'jobs.spec.ts',
  'new-job': 'jobs.spec.ts',
  scope: 'jobs.spec.ts',
  customer: 'jobs.spec.ts',
  photos: 'jobs.spec.ts',
};
