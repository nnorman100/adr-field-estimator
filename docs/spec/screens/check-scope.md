# Check Scope (with Start field work)

Part of [Screen specs](README.md). Address: `/field?job={id}` (the default job view). Built in:
`web/src/app/field/job-screens.tsx` (the job frame and its tabs), `scope-view.tsx`,
`rooms-section.tsx`, `room-card.tsx`, `room-lists.tsx`, `equipment-suggestion.tsx`,
`start-field-work.tsx`, `use-field-edit.ts`. Stages S5a-6, S5a-10, S5b-1, S6-3, S6-4.

## Purpose

The technician's walk of the loss: year built, the job's rooms (name, room type, water category
and class or mold condition, measurements, the room type's items and prep tasks), equipment counts
(with the counts the rooms suggest: "Confirm or change the counts below; only the counts you enter
are priced."), job charges, notes and the scope-confirmed box (`scope-view.tsx`). Edits are written to the job's field draft in the field database
(Firestore) on the phone, so they work with no signal when the phone keeps jobs. The job frame shows
the address, the tabs "Check Scope", "Customer and claim", "Photos" and, for the owner and office,
"Job coordination", and [Job actions](job-actions.md) below.

## Who may see it and do what

Only the person who owns the job's field work edits it, and only while the draft is being edited
(`canEditDraft` in `web/src/lib/field/store.ts`: `scope`, `fieldOwnerUid` is them, state `editing`).

| Role | Sees | Can do |
|---|---|---|
| Owner | every job's draft | edit only once the field work is theirs (Start field work on a job nobody owns, or a move to themself in [Job coordination](job-coordination.md)); if that move leaves the existing draft still naming the former owner, the owner gets the Start field work recovery prompt (see Key actions) |
| Estimator | the job's header, tabs and Customer and claim on jobs they made or are assigned to; the draft (rooms, scope, photos) only while they own the job's field work (`draftReadable` in `job-screens.tsx`; `canRead` in `web/firestore.rules`) | Start field work on a job nobody owns, or again on a job that names them but whose draft does not yet (see Key actions); edit the jobs whose field work they own |
| Office | every job's draft, read only | nothing: no `scope`; no Start field work |
| Superadmin support | nothing | nothing |
| Different-company user | nothing: the job answers 404 and the field rules refuse the draft | nothing |

On a job another person owns, an estimator who opens it on a fresh page sees the job header and
tabs but no draft: Check Scope and [Photos](photos.md) show only "Another person owns this job's field
work, so it is not shown here. The company owner can move it to you.". Once the app has recorded a
move away from an estimator who held the draft (`pending.moved` in `web/src/lib/field/pending.ts`),
there are three cases:

- Switching tabs inside the job that is open keeps it as it is: the draft, the customer and claim
  forms with what was typed, read only, under "This job's field work is no longer yours…" (`moved`
  in `job-screens.tsx`). Leaving the job for the Jobs list and opening it again inside the same field
  shell (no page reload) unmounts those screens: it starts from the retained draft and job detail
  (`pending.moved` in `web/src/lib/field/pending.ts`), read only, and the customer and claim forms
  show their saved values and any pending or refused save, but text that was only typed and never
  sent is gone (it lives in the form's own state, `RecordForm` in `customer-view.tsx`). Photo
  thumbnails are fetched again from the retained photo references, so an estimator who lost job access
  (unassigned from a job they did not make) gets 404 for them even if they were visible before
  leaving, while one who made the job keeps access and sees them again ([Photos](photos.md)).
- A fresh online page shows the ownership notice above if the estimator still has job access (they
  made the job or are still assigned), or answers 404 if they lost it (unassigned from a job they did
  not make).
- An estimator who was assigned but never held the field work keeps no draft; they lose the forms on
  the next refused read.

Read-only texts: "Read only. Only the estimator who owns this job's field work changes it, while the
job is being edited."; for an estimator when another owns it, "Another person owns this job's field
work, so it is not shown here. The company owner can move it to you."; after a move away, "This
job's field work is no longer yours…" (unsent changes stay on the phone, read only).

## States

- Loading: "Opening the job…", or offline "Opening saved field work…".
- Empty: "No rooms yet.".
- Lists not readable: "The room types, items and prep tasks could not be read." with the reason.
- Offline with jobs kept: edits save on the phone (the shell's "No signal: your work is saved on
  this phone"); offline with Online only, nothing opens without a signal.
- Draft unreadable: the error with "Try again".
- Validation: "Check the boxes marked below." / "Check the boxes marked in this room."; "Give the
  room a name."; "Nothing to save."; saved: "Scope saved.".
- Archived job: "This job is archived" and nothing is editable ([Job actions](job-actions.md)).
- No field database for the company: "The field database is not set up for this company yet."

## Key actions and server routes

| Action | Route or store | Key |
|---|---|---|
| Read the job | `GET /api/jobs/{id}` | `jobs_read` |
| Read the room types, items and prep tasks | `GET /api/jobs/{id}/scope-lists` | `jobs_read` |
| Start field work (become field owner) | `POST /api/jobs/{id}/field-owner` ("Nobody has started this job's field work yet. Whoever starts it owns it…"). Also shown, as "This job's field work is yours, but this phone cannot open it yet. Start field work again to finish.", when the job already names this person but its draft does not (`ownerUnset` in `job-screens.tsx`; Offered on Check Scope and on [Photos](photos.md), `startable` in `job-screens.tsx`, `start-field-work.tsx`). The prompt is shown for more causes than Start can repair. **Start repairs** (it finishes the field database step again): the first Start request committed the owner and did not update an existing draft; the owner moved the field work to this estimator (or to themself) in [Job coordination](job-coordination.md), the move committed and the existing draft still names the former owner (for example a 503 before the draft named them); and an estimator who owns the field work used "Back to editing" on [Finish](finish.md), got a 503 after Postgres committed the new draft ID, and the new draft is missing (their read of it is refused, so the prompt appears; Start rebuilds the draft from the last submission, `remakeCurrentDraft` in `web/src/lib/jobs/office.ts`). **Start cannot repair** a job whose first draft was never made: a job made by New job, by Copy of a signed job or by Save as new draft is committed in Postgres before its draft is made in the field database, so after a failed draft step (503) the job can be opened from Jobs, the missing draft's refused read shows the prompt, and Start answers 503 again because there is no submission to rebuild from. The repair is to send the original action again with its original IDs ("Try again" on [New job](new-job.md), the job actions' "Try copying again" on [Job actions](job-actions.md), Save as new draft's own retry on the [sync chip](field-shell.md)). A company owner who owns the field work gets no recovery after the Back to editing 503: the owner's read of the missing draft finds nothing, `ownerUnset` is set only when a draft exists and names someone else, so Check Scope and Photos show "The field work of this job is not there yet. Try again in a moment." and no Start field work; the owner's retry is "Back to editing" again, on the Finish screen that sent the request (see "Mismatches to check") | `scope` |
| Save rooms, scope, counts, notes | the field database draft (`draftFieldWrites`), checked by `web/firestore.rules`; no server route | field owner with `scope` |

Rules: `docs/access/jobs.md` (field owner), `docs/access/scope-lists.md`; draft lock while
submitting: `docs/access/submit.md`.

## Not built yet

- Drying readings and the drying log, job close (S5b-10).
- Voice notes, scope suggestions from AI and meter-photo reading (S7).
- Named adjustments and Reprice (S5b-7, S5b-6).
- A normal Check Scope action that opens [Finish and review](finish.md): see "Mismatches to check".
- A field for the summary of findings that [Finish](finish.md) checks: see "Mismatches to check".

## Mismatches to check

- Known gap: after "Back to editing" answers 503 once Postgres has committed the new draft ID and the new draft is missing, a company owner who owns the field work has no Start field work recovery on Check Scope or [Photos](photos.md) (`ownerUnset` and the permission-denied recovery in `job-screens.tsx` exclude the owner's missing-draft read). The screen shows "The field work of this job is not there yet. Try again in a moment."; the owner's retry is "Back to editing" again, and only on the Finish screen that sent the request, which holds the request's IDs (`pendingDraft` in `finish-screen.tsx`). If the owner reloads or leaves and reopens Finish, it reads the committed draft's status, cannot load the missing draft and shows "We could not open this job" with no Back to editing button. The owner's move of the field work to themself, which leaves an existing draft naming the former owner, does offer Start field work.
- No Check Scope action opens Finish and review. It is reached from the sync chip's "Changes not
  saved" sheet ("Go to Finish and review": only for a write refused because the draft was locked,
  that is being finished or finished, online, once the job reads) and from [Review](review.md)'s
  "Back to Finish and review" button (shown before pricing, including "Not finished yet", and on a priced,
  unsigned job). Otherwise by typing the address (see [README](README.md), item 1).
- Notes (`fact-notes`) save to the draft's `notes` key, but the summary of findings is a separate
  `summary` key that no field screen edits: `web/src/lib/field/forms.ts` excludes it from the
  forms. [Finish](finish.md) reads `draft.summary` (`summaryWritten` in
  `web/src/lib/submissions/screen.ts`), so a technician who fills in Notes and saves still sees "No
  summary of findings yet" there. S5 decision J1 calls for a summary editor; it is not built. The
  gap blocks pricing: with prices published and the scope confirmed, Finish still succeeds, then
  "Price this job" is refused with `summary_missing` ("…finished without a summary of findings. Go back
  to editing, write it, then finish again.", `web/src/lib/estimates/service.ts`), and no field screen
  can write it.
