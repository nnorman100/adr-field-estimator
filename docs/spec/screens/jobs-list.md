# Jobs lists

Part of [Screen specs](README.md). Addresses: `/field` (the role's default list),
`/field?list=company`, `/field?list=mine`, `/field?list=archived`. Built in:
`web/src/app/field/jobs-view.tsx`, `job-actions.tsx` (restore and unfinished archives),
`web/src/lib/field/views.ts`. Stages S5a-6, S5b-1, S5b-2, S5b-11.

## Purpose

The first field screen: the jobs a person works on, newest first, each opening its Check Scope view.
The owner and office start on "Company jobs"; an estimator on "My jobs" (`defaultList` in
`views.ts`). The owner also has "Archived drafts".

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | Company jobs, My jobs, Archived drafts | open a job, New job, load more, Restore an archived draft |
| Estimator | My jobs only: the jobs they made, own in the field, or are assigned to (`isOwnJob`, `isAssigned` in `web/src/lib/jobs/access.ts`); no list switch | open a job, New job, load more |
| Office | Company jobs, My jobs | open a job, New job, load more |
| Superadmin support | nothing (no company sign-in) | nothing |
| Different-company user | never this company's jobs: the list is read for the company of the caller's sign-in | nothing here |

Status labels (`JOB_STATUS_LABELS` in `src/lib/jobs/status-labels.ts`): "In progress" (draft), "Submitted", "Signed",
"Archived".

## States

- Loading: "Loading jobs…".
- Empty: "No jobs yet." or, on the archived list, "No archived drafts.".
- Offline: "Needs a connection"; the lists are read from the server only, and the load-more button
  is disabled.
- Error: the server's message in an alert, with a retry button for the page that failed. A refusal
  (a suspended company, a removed member) clears every job shown, so no property address stays on
  screen.
- Unfinished archive or restore: a "Not finished" list with "Try archiving again" or "Try restoring
  again".
- After a restore: a link to open the restored job.
- A job with no address shows "No address yet".
- When the current sign-in has `scope` and the company has enabled `readiness`, visible editing rows
  can show a count of items to check or **Ready to review**. The row needs a current check matching
  its ID and revision. A slow or failed check leaves the row usable with its regular status.
  The list asks for up to three checks at once and cancels them when the displayed rows or sign-in
  change. Office, submitted, signed and archived rows have no readiness marker.

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Read a list, paged | `GET /api/jobs?scope=company\|mine` (estimator: `mine` only, `company` is 403) | `jobs_read` |
| Read readiness for a visible editing row | `GET /api/jobs/{id}/readiness` | `scope`, flag `readiness` |
| Read archived drafts | `GET /api/jobs?scope=archived` | `jobs_archive` |
| Restore an archived draft | `POST /api/jobs/{id}/restore` | `jobs_archive` |
| New job | opens [New job](new-job.md) | `jobs_create` |

Rules: `docs/access/jobs.md` ("Jobs routes", "Archive, restore and copy").

## Not built yet

- Signed-job close and drying-watch state on list rows (S5b-10 in `docs/plans/S5.md`).
- Search or filters on the list: not in any plan.

## Mismatches to check

None found. The list switch is shown by role (`owner`, `office`) and the server enforces the same
split by role (`seesEveryJob` in `web/src/lib/jobs/access.ts`).
