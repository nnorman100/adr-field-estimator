# Feature spec (current behaviour)

> **DRAFT FOR OWNER REVIEW.** This describes what DryScope does today, written from the code and
> tests at the time of writing. It invents no feature. The owner approves it before it becomes the
> baseline for the rebuild. Items marked **[open]** are gaps found while writing it, not features.
> Section 6, "Target (accepted, not built yet)", is kept apart: it lists owner-accepted decisions
> the rebuild must deliver, each citing its source, and none of it describes today's app.
> Feature state (built, on, phone-checked) is in [STATUS.md](STATUS.md); who may do what is in
> [ACCESS.md](ACCESS.md); data is in [DATA.md](DATA.md); AI is in [AI.md](AI.md).

Each acceptance check is written so a browser test can prove it, with the Playwright suite's fake
cloud adapters or a Firestore emulator. "Flag" names the switch that must be on
(`AI_FEATURES=…`, `PRICE_BOOKS_ENABLED`); with the flag off the screen is hidden or the route
returns 404.

## 1. Roles

| Role | Who | Sees | Can do |
|---|---|---|---|
| Owner | company owner (one active owner per company) | all of the company's jobs and signed documents, team, prices | everything in the company: jobs, scope, photos, Live, audit, signing, archive drafts, coordination and close, team and invitations, company profile, delivery and record-retention settings, prices (flag), approve additional work |
| Estimator | field technician | only jobs they created or are assigned | start and edit jobs, scope, photos, readings, Live, meter reading, Finish and review, sign on the phone, send a signing link, copy a signed job to a draft, read prices (flag) |
| Office | coordinator | all company jobs and signed documents | start jobs (empty scope only), coordination and claim details, assign estimators, record a signed job's close, resend documents, read prices (flag); cannot edit scope, add photos, run Live, audit or sign |
| Superadmin | platform operator (not a company role) | any company, read-only, each view audited | create, suspend, reactivate and archive companies; invite or replace owners; create an owner login with a temporary password; listed support actions (resend or cancel a staff invitation, switch estimator and office, re-enable a member, archive or restore an unsigned draft) |
| Homeowner with a signing link | customer, no account | the four documents and photos for one saved revision | review, sign once, ask for an emailed copy |
| Holder of a document link | homeowner or adjuster, no account | one signed document set | read it, 30 days, until revoked |

The capability table is in [ACCESS.md](ACCESS.md) (source: `CAPABILITIES` in
`backend/workspaces.py`).

## 2. Screens

Every screen below is at `/app` unless noted. "Data" is what the screen captures (C) or shows (S).

### 2.1 Before sign-in

| Screen | Roles | Data | Acceptance checks |
|---|---|---|---|
| Landing `/` | anyone | S: marketing text, Log in link | loads signed out; a device that is signed in goes on to `/app` |
| Page not found | anyone | S: links to `/app` and `/` | an unknown path shows it |
| Sign in, Verify your email, Set your own password | anyone | C: email, password or Google, new password twice | a user with a temporary password reaches only the set-password step; an unverified email cannot use the app; an account with no membership sees "Accept a company invitation before using this app." |
| Accept invitation | invited, verified account | S: invitation; C: Accept | an account whose email differs from the invitation cannot read or accept it |

### 2.2 Company dashboard and jobs

| Screen | Roles | Data | Acceptance checks |
|---|---|---|---|
| Dashboard | any member | S: company name, role cards, email-limit notice (owner) | cards match the role; refreshes on focus and when back online |
| Company jobs / My jobs | owner, office: all; estimator: own and assigned | S: address, customer, claim number, status, signed list with "Load older signed jobs" | an estimator never lists another estimator's job; a job of another company never appears |
| Archived drafts | owner | S: archived unsigned drafts; C: Restore | archive hides an unsigned draft and the job then answers 410; restore returns it; a signed job has no archive action |
| Team and invitations | owner | S/C: members, role changes, invite email and role, resend, cancel, clear; pending signing links before removing access | an estimator and office user cannot open it (office sees only active estimators for assignment) |
| Company settings | owner | C: name, address, phone, email, license, signoff, logo, crew-lead email, delivery switch, drying-reminders switch, additional-work rate (flag `priced_extras`) | an estimator cannot save; changing the delivery switch needs the delivery capability |
| How long records are kept (Company settings) | owner (`retention_manage`) | C: days per class (invitations, activity log, drying-watch history, archived-draft photos), 90 to 3,650, 90 by default; S: one plain sentence per class | an estimator or office user cannot read or save it; a period under 90 or over 3,650 days is refused; saving a shorter period asks for confirmation; with `RETENTION_ENABLED` off the run deletes nothing; with it on, a signed agreement's photos, an open draft's photos and a pending unexpired invitation are never deleted, and a company's sweep runs at most once a day |
| Prices (flag `PRICE_BOOKS_ENABLED`) | read: all roles; edit, publish, import, restore, Switch to v2: owner | S/C: price table, working copy, preview, publish with a change reason, versions, history, export | with the flag off the entry is hidden and the routes answer 404; an estimator sees no edit controls; publishing never changes a signed document |

### 2.3 Job editor

| Screen | Roles | Data | Acceptance checks |
|---|---|---|---|
| Check scope | edit: owner, estimator; office sees read-only | C: address (suggestions), year built, rooms and demolition, equipment counts, standard job charges, technician notes, scope-confirmed box, mold toggles; item list (flag) | edits autosave; offline edits stay on the phone and show "Saved on phone - sync pending"; a company without published prices sees the "prices not set" banner and cannot get an estimate |
| Customer, Job coordination, Claim and loss details | customer: owner, estimator; coordination: owner, office; claim: `scope` or `coordination` | C: customer name, phone, email, office notes, assigned estimator, claim number, policy, date of loss, adjuster | an estimator cannot assign; an estimator records and sees the customer's name, phone, email and address, but not office notes, assignment or access lists; a signed job's customer cannot be edited |
| Walk and photo | owner, estimator | C: live video and audio (16 kHz audio, a 640 px frame every 2 s), photos with room and shot tag, offline voice notes, meter-photo reading, "Fill scope from walkthrough", QR tags | an office user has no Live or photo controls; a photo added offline uploads on reconnect; a photo is never uploaded twice |
| Drying log | read: job readers; add and remove: owner, estimator | C: air, material and thermal readings with room and time | an office user can read but not add |
| Ready to review? | owner, estimator (flag `readiness`) | S: gaps; C: Continue anyway | the gaps never block Finish |
| Review before signing | generate: owner, estimator; read: all job readers | S: customer estimate range and itemized total, four documents (Proposal, Itemized claim, Scope defense letter, Photo audit log), AI review notes for staff only; C: documents-confirmed box | the audit is refused until scope is confirmed and pending voice notes are resolved; any edit after the audit invalidates it; prices and mandatory wording come from the server |
| Sign on the phone | owner, estimator | C: signature, "Email me a copy" | signing binds to the saved revision and proposal hash; success shows only after a server receipt; a signed job cannot be edited |
| Send to the homeowner | owner, estimator | C: create, copy, share, revoke a signing link | the link signs once, expires unsigned after 7 days and stops working after any edit; after signing it shows the signed documents and receipt read-only for 30 days |
| Document delivery | resend: owner, office | S: status per recipient role; C: Resend | an estimator cannot resend |
| Additional work (flag `priced_extras`) | quote: owner, estimator; approve: owner | C: description, hours; S: server quote | only the owner approves |
| Job summary (flag `job_summary`) | job readers | S: summary text | with the flag off the card is absent |
| Drying watch (flag `drying_watch`) | read: members; mark dry: owner, office, estimator; remind, extend: owner, office | S: days dry, summary; C: mark dry, remind, extend | a reminder needs a person's approval |
| Job close and estimate accuracy (flag `estimate_assist`) | close: owner, office; accuracy: owner (needs prices) | C: final invoice, actual drying days; S: how many landed in the range | an estimator cannot see amounts |
| QR tags | any signed-in user with an editable draft | C: scan or enter a code, print a sheet | |
| Help, remove-room, archive and reset-password dialogs | per role | | help lines for a switched-off feature are hidden |

### 2.4 Platform administration (superadmin)

| Screen | Data | Acceptance checks |
|---|---|---|
| Companies (list, create) | C: company, owner email or temporary-password login | a company owner cannot open it |
| Company administration | C: status active, suspended, archived; replace owner | archive needs a suspended company |
| Read-only support view | S: any company's jobs, signed list, team, AI usage, drying watch, prices, job and agreement details, photos, evidence | each view writes an audit event; no edit control for customer data appears; a refused request writes nothing |

### 2.5 Homeowner pages (no account)

| Screen | Data | Acceptance checks |
|---|---|---|
| Review and sign your estimate, `/sign` | S: four documents, photos; C: signer name, role, two consent boxes, "Email me a copy", signature | a used link shows the signed documents and receipt read-only for 30 days after signing, then the unavailable message; an expired or revoked link shows the same unavailable message, and a voided link says the estimate changed; the same request sent twice returns the same receipt |
| Your signed estimate documents, `/documents` | S: homeowner set (proposal and photos) or adjuster set (claim, defense letter, scope JSON) | read-only; unavailable after 30 days or revocation; the page is not cached offline |

## 3. Behaviour that holds on every screen

- Offline: the service worker opens the app shell with no signal; drafts, photos and voice notes
  are kept in IndexedDB and sync when the connection returns. Audit, signing, link creation,
  drying readings, job close, coordination saves and archive are online only.
- Concurrency: a draft save carries the revision it was based on; a stale save returns 409 and
  keeps the local work.
- Signed records are immutable; later coordination goes in private sidecars.

## 4. Standard checks

The three checks the technology standard requires, with what proves each today.

### 4.1 Company A never reads company B

Acceptance: sign in as an owner of company B and request, by id, each of company A's jobs, signed
agreements, evidence, photos, coordination, delivery, prices, drying-watch, outcome and team
records: every request answers 403 or 404, no lists contain A's records, and a superadmin's view
of A is audited.

Existing proof: `tests/test_workspaces.py::test_roles_and_cross_company_scoped_jobs`,
`::test_signed_job_records_evidence_and_coordination_stay_scoped`,
`tests/test_job_archive_and_customer.py::test_other_company_owner_cannot_reach_this_company`,
`tests/test_outcomes.py` (isolation and 404 cases), `tests/test_drying_watch.py::test_lists_are_company_scoped_and_support_is_read_only`,
`tests/browser/workspaces.spec.js` (branding and account-switch isolation).
**[open]** These run against the in-memory fake store, not the Firestore emulator. No test was
found that fetches company A's photo bytes or full-size original as company B, and no rules test
covers the `inspections` and `authorizations` collections (the rules test covers superadmin
records only).

### 4.2 Double submit makes one record, and a signed record is rejected

Acceptance: sending the same sign request twice returns one receipt and one agreement; a changed
payload with the same reference is rejected; after signing, every edit, audit, photo, transcript or
second signature is rejected and the stored records are unchanged.

Existing proof: `tests/test_firestore_emulator.py::test_concurrent_signing_retries_return_one_receipt`,
`::test_signed_records_cannot_be_altered`, `::test_link_and_device_signatures_race_to_one_agreement`,
`::test_link_signature_and_edit_race_never_both_land`,
`tests/test_backend.py::test_authenticated_durable_flow_and_immutable_retry`,
`tests/test_signing_links.py::test_link_reads_the_bound_documents_and_signs_once_as_the_technician`,
`tests/browser/workflows.spec.js` (failed save keeps the retry reference),
`tests/browser/signing-link.spec.js` (homeowner retry).
**[open]** No browser test double-clicks the sign buttons (the buttons disable during the call);
no HTTP-level race of two simultaneous homeowner signing requests exists (the race is tested at
store level in the emulator).

### 4.3 Cutting the connection mid-save or mid-upload delivers exactly once

Acceptance: with the connection cut after the server committed but before the phone heard back,
restoring it leaves one copy of the draft change, each photo, each original and each voice note,
and no false conflict.

Existing proof: `tests/browser/photo-originals.spec.js` (a failed photo upload resends only that
photo; an original whose copy reached the server unseen), `tests/browser/offline-notes.spec.js`
(a note saved with its response lost appears once), `tests/browser/scope-items.spec.js` (a lost
create response), `tests/browser/workflows.spec.js` and `local-drafts.spec.js` (offline draft,
reconnection), `tests/test_inspection_store.py::test_photo_retry_same_id_cannot_substitute_room_or_evidence`,
`tests/test_photo_originals.py::test_a_retried_original_that_is_already_stored_succeeds`,
`tests/test_voice_notes.py::test_retried_voice_note_is_not_transcribed_or_appended_twice`.
**[open]** Not covered by any test: a lost response to the autosave `PUT` after the server saved
it (by reading `reconcile()` in `public/app.js`, the foreground path may report a revision
conflict even when the saved data equals the local data; not confirmed by running it); a lost
response to a photo upload through the normal sync path; a request cut mid-body; a lost response
to audit or to signing-link creation; and a drying reading, which has no idempotency key (the
server mints a new id per request, so a resend after a lost response could add a second
reading). The browser tests use a fake server, so none is observed against Cloud Run and
Firestore.

## 5. Not built (from VISION.md)

Company workbook upload; AI-suggested prices; crew calendar and reminders; per-visit reading
dispatch; homeowner photo upload through the link; walkthrough recording stored with the signed
agreement; recipient texting; anonymized cross-company price comparison; a support role and an
owner-visible access log.

## 6. Target (accepted, not built yet)

Nothing in this section is built. Each item is an owner-accepted decision the rebuild must
deliver (rebuild plan, `dry-standard-replan` report, stage S1 "inventory every existing screen/role
and accepted neutral workflow"; delivery in S5). Its acceptance checks are labelled **not built**
and must not be read as current behaviour. Anything not decided is marked **[open]**.

### 6.1 Company-neutral pricing additions and change orders

Source: the ADR-neutral plan (`dry-adr-neutral-plan` report), questions Q1–Q13, accepted as
supplied (rebuild plan, supersession ledger). Prices stay server Decimal math; a model never
supplies a price.

| Item | Decision (question) | Roles |
|---|---|---|
| New-company setup | A fresh table by default, with an optional "Start from my current prices" the owner reviews; never an automatic import (Q1). No inherited markup or cushion: multipliers 1 and no extra allowance unless the owner chooses one; stored old defaults are kept (Q6). Area basis and cabinetry scope are chosen in owner settings with plain examples (Q7). | owner |
| Named positive adjustments | Owner-defined named rules with a customer label, a multiplier, eligible items or groups and a required reason, published in the versioned price table; the existing category, cabinetry and after-hours settings stay (Q2). | define and approve: owner; propose on a job: estimator |
| Custom multipliers on a job | One selected custom multiplier per eligible base line, positive surcharges only; no stacking and no discounts in the first release; the standard factors stay visible beside it (Q3). | apply: owner approves; propose: estimator |
| Project additions | Hourly (today's Additional work, unchanged), quantity/unit, and flat-fee one-off additions, each owner-approved and kept out of the reusable catalog (Q4). | propose: estimator; approve: owner |
| Change orders after signing | An incremental, separately signed change order for positive added work only, linked to the original agreement; the original is never edited or repriced (Q5). | approve added money: owner; sign: the customer; who may create it: **[open]** |
| Old drafts and records | Pinned drafts are not moved automatically; the owner reprices an unsigned draft only on explicit review; signed records never change (Q8). | owner |

Target acceptance checks (**not built**):

- A company with no published table still cannot price an estimate; a new company's table has
  multipliers of 1 and no allowance it did not choose.
- An estimator can propose an adjustment or addition but cannot approve it; only the owner's
  approval reaches a total, and the approval binds the job revision and price hash.
- Two custom adjustments matching one line are refused until the owner picks one; a multiplier
  below 1 is refused.
- Editing any approved addition's quantity, unit, price, scope, tax treatment or description
  clears its approval and the audit.
- A unit or flat-fee addition never changes the company's reusable table, and an old hourly
  approval keeps its saved rate.
- Creating a change order on a signed job leaves the original agreement, proposal hash and evidence
  paths byte-for-byte unchanged; the change order has its own revision, audit, proposal hash and
  single-use signature, and prices only the added work.
- Two concurrent change orders on the same signed job cannot both build on a stale parent.
- Change orders are not counted as separate completed jobs in estimate accuracy.

Still **[open]**: the calculation version name, chosen with the price-bracket work (#228); whether
custom adjustments apply to bracket-derived lines (the plan recommends yes, only through explicit
eligible-item selection); whether a minimum or trip charge applies again on a change order (the
plan recommends off unless selected); where the parent/child link is stored; and credits,
reductions and whole-agreement replacement, which are outside the first workflow.

### 6.2 Field and office ownership

Source: the Technology Standard Stack (field/office ownership) and the rebuild plan's ownership
table and gate R8; the office-created-job rule below is the owner's decision recorded in this
review on Nov 6, 2026.

| Data | Owner of writes | Others |
|---|---|---|
| Field work: observations, rooms, measurements, findings, transcript, field photos | the job's field owner (the estimator who starts the draft) | other authorized staff view only |
| Customer details and assignment | office (and the company owner) | the field owner views the customer |
| Prices and approvals | the company owner | separate from field ownership |

An office-created job starts with no field owner. The first authorized estimator to capture field
work on it becomes its field owner; office keeps customer details and assignment.

Target acceptance checks (**not built**):

- On an office-created empty job, the first authorized estimator's first capture makes them field
  owner, and a second estimator's later field write is refused.
- An office user can change customer details and assignment on that job, and cannot write field
  data.
- A field owner cannot change assignment or office-owned customer details.
- Becoming field owner grants no price approval.

Still **[open]**: an explicit field-owner transfer (the plan's alternative, preserving pending work
and an audit), and how today's rule that a company owner or assignee can edit scope maps onto
field ownership.
