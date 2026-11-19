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
| Owner | every job's draft | edit only once the field work is theirs (Start field work on a job nobody owns, or a move to themself in [Job coordination](job-coordination.md)) |
| Estimator | the job's header, tabs and Customer and claim on jobs they made or are assigned to; the draft (rooms, scope, photos) only while they own the job's field work (`draftReadable` in `job-screens.tsx`; `canRead` in `web/firestore.rules`) | Start field work on a job nobody owns, or again on a job that names them but whose draft does not yet (see Key actions); edit the jobs whose field work they own |
| Office | every job's draft, read only | nothing: no `scope`; no Start field work |
| Superadmin support | nothing | nothing |
| Different-company user | nothing: the job answers 404 and the field rules refuse the draft | nothing |

On a job another person owns, an estimator who opens it afresh sees the job header and tabs but no
draft: Check Scope and [Photos](photos.md) show only "Another person owns this job's field work, so it
is not shown here. The company owner can move it to you.". An estimator whose phone already held the
draft when the field work moved away (or when they were also unassigned) keeps what that page loaded:
the scope form with what they typed, and the photos already shown, read only, under "This job's field
work is no longer yours…" (`moved` in `job-screens.tsx`); opening the job again on a fresh page gives
the first case.

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
| Start field work (become field owner) | `POST /api/jobs/{id}/field-owner` ("Nobody has started this job's field work yet. Whoever starts it owns it…"). Also shown, as "This job's field work is yours, but this phone cannot open it yet. Start field work again to finish.", when the job already names this person but its draft does not. Two ways to get there: the first Start request committed the owner and did not update the draft; or the owner moved the field work to this estimator in [Job coordination](job-coordination.md), the move committed and answered 503 before the draft named them. Starting again finishes either. Offered on Check Scope and on [Photos](photos.md) (`startable` in `job-screens.tsx`, `start-field-work.tsx`) | `scope` |
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
