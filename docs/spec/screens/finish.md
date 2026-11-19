# Finish and review

Part of [Screen specs](README.md). Address: `/sign-in/{address}/jobs/{id}/finish`. Built in:
`web/src/app/(auth)/sign-in/[address]/jobs/[jobId]/finish/finish-screen.tsx`,
`web/src/lib/submissions/screen.ts`. Stage S5a-8.

## Purpose

Turn the job's draft into its record and lock it on every phone ("Finish and review"), or, for a
finished job, make a new draft version from the record ("Back to editing"). Before Finish it lists
"What will be recorded": the rooms (and how many have no name), the photo count, and whether the
summary of findings is written (the draft's `summary` key, not the Notes box on Check Scope: no field
screen edits it, see [Check Scope](check-scope.md)). Online only: it is not part of the kept field shell.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the job's state and summary | Finish (once they own the field work) and Back to editing (`scope`) |
| Estimator | the job's state on jobs they can see; while the job is still being edited the screen also reads its draft, which an estimator may read only while they own the field work, so on another person's job they get "We could not open this job" (`finish-screen.tsx`) | Finish and Back to editing on jobs whose field work they own |
| Office | the job's state; "Only the owner or the estimator on this job can finish it." | open the review of a finished job; nothing else (`scope` missing, the routes answer 403) |
| Superadmin support | nothing (the page checks the company sign-in) | nothing |
| Different-company user | signed out of this company's page (the sign-in must belong to this company's tenant), or "This job could not be found" | nothing |

The screen decides by `scope` (`finisherOf`); the server also needs the caller to own the field
work (`docs/access/submit.md`).

## States

- Loading: "Reading the job…".
- Signed out: "Sign in to finish this job"; sign-in not finished: "Finish signing in first".
- Not found or archived (404, 410): "This job could not be found" ("It may belong to someone else,
  or it was archived.").
- No connection or unreadable: "We could not open this job" ("Finish and review needs a
  connection…") with "Try again".
- Being edited: the summary and "Finish and review"; a newer draft appeared: "Show the new draft".
- Finished: "Finished", "This draft is recorded and locked. Nobody can change it.", "Review the
  estimate" and, for `scope`, "Back to editing".
- Signed: "This job is signed".
- Errors: the server's message with "Try again" (same request) or "Reload the job".

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Who is signed in | `GET /api/me` | member |
| Read the job | `GET /api/jobs/{id}`; for a draft, the shown draft from the field database | `jobs_read` |
| Finish and review | `POST /api/jobs/{id}/submissions` | `scope`, field owner |
| Back to editing | `POST /api/jobs/{id}/drafts` | `scope`, field owner |
| Review the estimate | opens [Review](review.md) | |

Rules: `docs/access/submit.md`.

## Not built yet

- "Ready to review?" checks before Finish (S5b-11).

## Mismatches to check

- No Check Scope action opens this screen. It is reached from the sync chip's "Changes not saved"
  sheet ("Go to Finish and review", only for a write refused because the draft was finished, with a
  signal and once the job reads: `web/src/app/field/sync-chip.tsx`) and from [Review](review.md)'s
  "Not finished yet" link; an archived or ownership-refused write does not offer it. Otherwise the
  address must be typed. A technician walking a loss has no button from Check Scope to Finish.
- The summary check reads `draft.summary`, which no field screen can write (see
  [Check Scope](check-scope.md)), so "No summary of findings yet" stays until another source sets it.
