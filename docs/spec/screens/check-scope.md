# Check Scope (with Start field work)

Part of [Screen specs](README.md). Address: `/field?job={id}` (the default job view). Built in:
`web/src/app/field/job-screens.tsx` (the job frame and its tabs), `scope-view.tsx`,
`rooms-section.tsx`, `room-card.tsx`, `room-lists.tsx`, `equipment-suggestion.tsx`,
`start-field-work.tsx`, `use-field-edit.ts`, `published-item-list.tsx`. Stages S5a-6, S5a-10, S5b-1, S6-3, S6-4, S6-8, S5b-11.

## Purpose

The technician's walk of the loss: year built, the job's rooms (name, room type, water category
and class or mold condition, measurements, the room type's items and prep tasks), equipment counts
(with the counts the rooms suggest: "Confirm or change the counts below; only the counts you enter
are priced."), job charges, notes and the scope-confirmed box (`scope-view.tsx`). Edits are written to the job's field draft in the field database
(Firestore) on the phone, so they work with no signal when the phone keeps jobs. The job frame shows
the address, the tabs "Check Scope", "Customer and claim", "Photos" and, for the owner and office,
"Job coordination", and [Job actions](job-actions.md) below.

## Ready to review?

With the company's `readiness` flag on, owners and estimators see the count of items to check,
**Ready to review**, or **Readiness check unavailable** on an online editing draft they can read.
The count describes the saved field manifest. A change must be stored before it clears a gap. Office,
signed and archived views have no readiness controls. The check has no effect on draft edits,
including work kept on the phone when the connection drops.

A Fix link from [Finish](finish.md) opens Check Scope, Customer and claim, or Photos and focuses the
matching control or section. A read-only draft focuses the Rooms or Check Scope heading when the
control is not usable. Room links use the stable room ID. Photo links select the room and shot tag
and keep them for the capture. Photos lists the baseline shots (overview, affected surface, moisture
meter) the readiness check still lacks for the chosen room, each selecting that shot. **Back to
Finish and review** stays on every tab of the job after a Fix and reopens Finish with current data;
with any unsaved input (Office notes included) it offers Keep editing or Discard changes and go back,
and it waits, showing "Saving…", until this job's pending saves and photo sends are acknowledged
before it leaves. Discard clears the unsent values of every form on the job. The wait, its deadline
and its failure handling are in [Finish](finish.md).
An accepted save asks the check again. A confirmed archive replaces the readiness text and link with the archived notice.
The summary of findings gap points to guidance in Check Scope while the separate summary editor is
pending.

## Drying log and watch

Open **Drying log** on Check Scope to see active readings by room and time. The company owner and
any estimator with access to the job can add or void a reading, including when someone else owns
the field draft. Office staff can read the log. Select a room or Whole job and enter the time the
reading was taken. Air readings show the five values the server calculates. Material readings use
the meter's unit for both moisture and the optional dry standard. Thermal readings record the
temperature difference and pattern. Voiding asks for confirmation and removes the reading from the
active log.

These actions need a connection. A lost save reply leaves the fields in place and offers **Save
again**, which sends the same reading. A refusal keeps the entered values and shows why the save
could not be confirmed or accepted. The unsent form lives on the open job screen and counts as
unsaved input for Back to Finish. A local time that does not exist, or happens twice when the clocks
change, is not guessed: the technician corrects it or chooses the first or second occurrence. When
the server confirms the job is refused, the fetched job, customer, prices and drying data leave the
screen and only the unsent reading, its refusal text and its exact retry stay while this job and
sign-in are open. A watch decision whose reply was lost keeps its reason and a **Try again** button,
even after the watch stops offering that action.

On a signed job with the company’s drying-watch switch enabled, **Drying watch** shows the signed
plan, current day, next due reading, last reading, room gaps and affected-air trend. An older
signed job without saved drying days says there is no plan. A reading added or voided here
refreshes the watch and the readiness check. Each room shows its affected material readings and dry
standards, and a room with a missing dry standard is not counted as complete. The actions offered
(mark dry, extension note, close monitoring) are the ones the server's watch answer permits for the
person, office staff included; the office drying log itself stays read only. A monitoring decision
requires an explicit confirmation and reason. If the facts changed, review them again before confirming. Extension
notes leave the signed drying days as agreed.

## Who may see it and do what

Only the person who owns the job's field work edits it, and only while the draft is being edited
(`canEditDraft` in `web/src/lib/field/store.ts`: `scope`, `fieldOwnerUid` is them, state `editing`).

| Role | Sees | Can do |
|---|---|---|
| Owner | every job's draft | edit only once the field work is theirs (Start field work on a job nobody owns, or a move to themself in [Job coordination](job-coordination.md)); if that move leaves the existing draft still naming the former owner, opening the job gets it ready ("Getting this job's field work ready…", see Key actions) |
| Estimator | the job's header, tabs and Customer and claim on jobs they made or are assigned to; the draft (rooms, scope, photos) only while they own the job's field work (`draftReadable` in `job-screens.tsx`; `canRead` in `web/firestore.rules`) | Start field work on a job nobody owns; edit the jobs whose field work they own (a job that names them but whose draft does not yet is got ready as it opens, see Key actions) |
| Office | every job's draft, read only | nothing in the field work: no `scope`; no Start field work. On a signed job, the drying log stays read only and the drying watch offers the actions the server permits (see Drying log and watch) |
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
- Company members with `prices_read` can expand "Item list as of {date}" to read the latest
  published item names, units, room types and suggestions. The reference contains no prices
  or totals. If the phone keeps jobs, the list reopens offline from `ds-prices`. Check Scope
  checks for a new publication on online open, on reconnect, when the page comes back to the foreground and every minute while it stays open. It identifies an
  older copy when it finds a newer version, and shows the newer list with a warning when the phone
  cannot save it. A company without a publication sees "Prices not set", also offline once the
  phone has seen that answer. When the server refuses the list (403, price books off, or a revoked sign-in), the list is
  hidden at once and the saved copy for that person and company is erased. The same erase runs when
  the field gate's `GET /api/me` lets the person in without `prices_read`, whether or not Check
  Scope is open, and when the sign-in page or the Prices, Company settings, Team, Finish or Review
  screen accepts a `GET /api/me` answer for the current sign-in without `prices_read`. Known limits:
  an open Check Scope in another tab keeps showing the list until it receives a refusal itself or is
  reloaded, and when the page closes before its erase gets the cross-tab lock, the refusal is not
  recorded. The refusal is recorded in localStorage before the erase is tried, so a
  copy that could not be erased is never shown and every read erases it first, in any tab and
  after a reload. An answer is shown and saved only if no refusal was recorded after its request
  started, and a copy fetched before a refusal is erased. The same version already saved is not
  written again. A refusal that only asks the person to sign in again (401 `sign_in_again`) or to
  complete the role's second step (403 `second_step_required`) hides the list in this view and
  keeps the copy. A lost connection, or a 403 or 404 without one of the
  server's own member, capability or feature-flag codes (a captive portal or proxy), is not a
  refusal: the last readable list stays. Erasing, sign-out and Discard never create the item-list
  database, and sign-out and Discard fail while an erase cannot finish. Limit: when the phone
  cannot write localStorage, the refusal is not recorded, so a copy that could not be erased may
  stay viewable offline until the next online check.
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
| Read the company's published reference item list | `GET /api/prices/item-list`, offline copy in `ds-prices` | `prices_read` |
| Start field work (become field owner) | `POST /api/jobs/{id}/field-owner` ("Nobody has started this job's field work yet. Whoever starts it owns it…"), offered on Check Scope and on [Photos](photos.md) only on a job nobody owns (`startable` in `job-screens.tsx`, `start-field-work.tsx`). When the job already names this person but its draft is not there or does not name them yet (a field step that did not get through: a first Start, a move, Back to editing, New job, Copy), there is no Start prompt any more: the job read gets it ready (the draft life-cycle redesign, slice 6: the read syncs the job's drafts from Postgres when they fell behind or the current draft is missing) and the screen shows "Getting this job's field work ready…" while it reads the job again (1, 2, 4, 8 and 8 seconds), then "This job's field work is not ready on this phone yet. Try again in a moment." with Try again. A 403 answer to Start drops the job from the screen, as any refusal of it does. | `scope` |
| Save rooms, scope, counts, notes | the field database draft (`draftFieldWrites`), checked by `web/firestore.rules`; no server route | field owner with `scope` |

Rules: `docs/access/jobs.md` (field owner), `docs/access/scope-lists.md`; draft lock while
submitting: `docs/access/submit.md`.

## Not built yet

- Job close (S5b-10).
- Voice notes, scope suggestions from AI and meter-photo reading (S7).
- Approving a named adjustment on a job (S5b-8). Reprice (S5b-6) is on Review before signing.
- A normal Check Scope action that opens [Finish and review](finish.md): see "Mismatches to check".
- A field for the summary of findings that [Finish](finish.md) checks: see "Mismatches to check".

## Mismatches to check

- Outside the return link after Fix, Check Scope has no direct action that opens Finish and review. It is reached from the sync chip's "Changes not
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
