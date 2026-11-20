# Finish and review

Part of [Screen specs](README.md). Address: `/sign-in/{address}/jobs/{id}/finish`. Built in:
`web/src/app/(auth)/sign-in/[address]/jobs/[jobId]/finish/finish-screen.tsx`,
`web/src/lib/submissions/screen.ts`. Stages S5a-8 and S5b-11.

## Purpose

Turn the job's draft into its record and lock it on every phone ("Finish and review"), or, for a
finished job, make a new draft version from the record ("Back to editing"). Before Finish it lists
"What will be recorded": the rooms (and how many have no name), the photo count, and whether the
summary of findings is written (the draft's `summary` key, not the Notes box on Check Scope: no field
screen edits it, see [Check Scope](check-scope.md)). Finish needs a connection.

With the company's `readiness` flag on, the page checks the saved draft in the background. It
compares the answer's job, revision, draft ID and field digest with what the page shows. If the
matching answer has gaps, choosing **Finish and review** opens **Ready to review?**. The prompt
lists gaps in checklist order and links to the relevant job field, room or photo controls. Photo
suggestions use the room's existing overview, affected surface and moisture meter tags. The owner
can open Prices when the checklist finds no usable published price. Estimators are directed to
their company owner.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the job's state and summary, on any job (they read every draft) | the buttons Finish and Back to editing show for `scope`, whoever owns the field work; the server accepts them only from the field owner (`not_field_owner`, `jobAccess` with `fieldWork`), so on a job an estimator owns the owner's tap is refused |
| Estimator | the job's state on jobs they can see; while the job is still being edited the screen also reads its draft, which an estimator may read only while they own the field work, so on another person's job they get "We could not open this job" (`finish-screen.tsx`) | the buttons show as for the owner (`scope`); the server accepts only the field owner, so a visible estimator who does not own the field work is refused too |
| Office | the job's state; "Only the owner or the estimator on this job can finish it." | open the review of a finished job; nothing else (`scope` missing, the routes answer 403) |
| Superadmin support | nothing (the page checks the company sign-in) | nothing |
| Different-company user | signed out of this company's page (the sign-in must belong to this company's tenant), or "This job could not be found" | nothing |

The screen decides by `scope` (`finisherOf`), which controls the buttons; field ownership controls
the write: the server also needs the caller to own the field work (`docs/access/submit.md`), so a
button can show and its request still be refused with 403 `not_field_owner`.

## States

- Loading: "Reading the job…".
- Signed out: "Sign in to finish this job"; sign-in not finished: "Finish signing in first".
- Not found or archived (404, 410): "This job could not be found" ("It may belong to someone else,
  or it was archived.").
- No connection or unreadable: "We could not open this job" ("Finish and review needs a
  connection…") with "Try again".
- Being edited: the summary and, for `scope`, "Finish and review" (refused unless the caller owns the
  field work); a newer draft appeared: "Show the new draft".
- Readiness prompt: focus starts on **Back**. Back or Escape closes it and returns focus to
  **Finish and review**. **Continue anyway** sends the ordinary Finish request once. A Fix link
  opens the appropriate field view. Returning to Finish reads the job, the draft and the flag again.
- Finish goes ahead directly when the check has no matching gaps or is still pending. An unavailable
  or timed-out check and the flag being off leave the Finish action available.
- Finished: "Finished", "This draft is recorded and locked. Nobody can change it.", "Review the
  estimate" and, for `scope`, "Back to editing" (shown to the owner and to a visible non-owning
  estimator alike, refused unless the caller owns the field work).
- Signed: "This job is signed".
- Errors: the server's message with "Try again" (same request) or "Reload the job".
- Back to editing answered 503 after Postgres committed the new draft ID: the new draft may be
  missing. For the field owner, an estimator or the company owner, opening Check Scope or Photos
  then offers the "Start field work" recovery, which rebuilds the missing draft from the last
  submission ([Check Scope](check-scope.md)). Until then, Back to editing again works only on this
  screen as it stands (it keeps the request's IDs, so the retry is the same request); if the field
  owner reloads or leaves and reopens Finish, it cannot load the missing draft and shows "We could
  not open this job" with no Back to editing button.

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Who is signed in | `GET /api/me` | member |
| Read the job | `GET /api/jobs/{id}`; for a draft, the shown draft from the field database | `jobs_read` |
| Readiness advice | `GET /api/jobs/{id}/readiness` | `scope`, flag `readiness`, editing draft |
| Finish and review | `POST /api/jobs/{id}/submissions` | `scope`, field owner |
| Back to editing | `POST /api/jobs/{id}/drafts` | `scope`, field owner |
| Review the estimate | opens [Review](review.md) | |

Rules: `docs/access/submit.md`.

Readiness is advisory and never stores an acknowledgement. Office, submitted, signed and archived
views have no readiness controls.

## Mismatches to check

- Outside the return link after Fix, Check Scope has no direct action that opens this screen. The sync chip's "Changes not
  saved" sheet offers "Go to Finish and review" only for a write refused because the draft was locked
  (the draft was being finished, or finished, before the write; this can be before any submission
  commits), with a signal and once the job reads (`web/src/app/field/sync-chip.tsx`,
  `web/src/lib/field/journal.ts`); an archived or ownership-refused write does not offer it. [Review](review.md)
  offers "Back to Finish and review" on a job not yet finished ("Not finished yet"), on a finished,
  unpriced job ("Price this job") and on a priced unsigned job, not once signed. Otherwise the address
  must be typed. A technician walking a loss has no button from Check Scope to Finish.
- The summary check reads `draft.summary`, which no field screen can write (see
  [Check Scope](check-scope.md)), so "No summary of findings yet" stays until another source sets it. The check does not stop Finish,
  but pricing does: "Price this job" is refused with `summary_missing` ("Go back to editing, write it,
  then finish again") when the summary is empty, and Check Scope has no editor for it.
