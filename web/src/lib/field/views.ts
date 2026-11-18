// Where the field app is (S5a-6). Every field screen is a view of the one page /field, picked by
// the address's query: the field worker answers every /field address with the same kept shell page
// (web/sw/sw.js), so a view must never need a page of its own. A reload keeps the view, because the
// view is in the address.
//
//   /field                         the jobs list (the role's default list)
//   /field?list=mine|company       the jobs list, one list chosen
//   /field?list=archived           Archived drafts (the owner, S5b-2)
//   /field?view=new-job            New job
//   /field?job={id}                Check Scope of one job
//   /field?job={id}&view=customer  Customer and claim
//   /field?job={id}&view=photos    Photos
//   /field?job={id}&view=coordination  Job coordination (owner and office)
//
// tests/e2e/screens.ts lists every view with the browser test that runs axe on it.

export const FIELD_VIEWS = ['jobs', 'new-job', 'scope', 'customer', 'photos', 'coordination'] as const;
export type FieldView = (typeof FIELD_VIEWS)[number];

export const JOB_VIEWS = ['scope', 'customer', 'photos', 'coordination'] as const;
export type JobView = (typeof JOB_VIEWS)[number];

export type JobsList = 'mine' | 'company' | 'archived';

export type FieldPlace =
  | { view: 'jobs'; list: JobsList | null }
  | { view: 'new-job' }
  | { view: JobView; jobId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Anything the app did not write (a bad id, an unknown view) is the jobs list, never an error page.
export function placeOf(params: URLSearchParams): FieldPlace {
  const job = params.get('job');
  const view = params.get('view');
  if (job !== null && UUID.test(job)) {
    const jobView = (JOB_VIEWS as readonly string[]).includes(view ?? '') ? (view as JobView) : 'scope';
    return { view: jobView, jobId: job.toLowerCase() };
  }
  if (view === 'new-job') return { view: 'new-job' };
  const list = params.get('list');
  return { view: 'jobs', list: list === 'mine' || list === 'company' || list === 'archived' ? list : null };
}

export function hrefOf(place: FieldPlace): string {
  switch (place.view) {
    case 'jobs':
      return place.list ? `/field?list=${place.list}` : '/field';
    case 'new-job':
      return '/field?view=new-job';
    case 'scope':
      return `/field?job=${place.jobId}`;
    default:
      return `/field?job=${place.jobId}&view=${place.view}`;
  }
}

// The list a person sees first: the owner and office look after every job of the company, an
// estimator works on their own.
export function defaultList(role: string): JobsList {
  return role === 'owner' || role === 'office' ? 'company' : 'mine';
}
