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
  '/sign-in/[address]/invitations/[invitationId]': 'sign-in.spec.ts',
  '/operator/[tenantId]': 'operator.spec.ts',
  '/operator/[tenantId]/companies/[companyId]': 'operator.spec.ts',
  '/operator/[tenantId]/companies/[companyId]/team': 'operator.spec.ts',
};
