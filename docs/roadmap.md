# DryScope roadmap

The approved plan (Oct 24, 2026) for making this repository the complete DryScope product. Any tool or person picking up the work starts at **Handoff**, then works the phases in order. `RELEASES.md` stays the one record of what is live; this file records what is planned and why.

## Handoff (Oct 24, 2026)
- **Repo state:** `master` includes PR #130 (jobs list tabs and search, `c1bc7d7`, merged Oct 24). No PRs are open. Not released: production is still commit `0b5dbae` (see `RELEASES.md`).
- **Next for Nate:** Phase 0, items 1–3 (phone test 2, ADR company profile, invitation check). Approve a release of PR #130 together with the Phase 1 batch.
- **Next for an agent:** finish the Phase 1.1 follow-ups, then Phase 0 item 6 (the local SMTP test), then Phase 1.2 (GPS stamp). Each item is one small PR that passes the eight checks below.
- **Rules that hold:**
  - Read `AGENTS.md` and `VISION.md` first.
  - Agents may merge Low or Medium risk PRs with green CI. High risk PRs and every production deploy need Nate's go.
  - Never run a blanket `firebase deploy`. Deploy only `hosting:alert-disaster`, after the backend.
  - Keep secrets out of the repo, the wiki and Notion.
- **Shared notes:** LLM Wiki `projects/adr-field-estimator.md`, and the Notion page "ADR Field Estimator (Alert Disaster Restoration field app)" in Second Brain / Notes.
- **Local note (Windows):** `tests/test_workspaces.py::test_smtp_session_that_hangs_is_cut_off_at_the_deadline_without_a_retry` fails locally on `master` and passes in CI (Phase 0 item 6).

## Context
Nate wants one product, **DryScope**, built on the live field estimator (`nnorman100/adr-field-estimator`, local `C:\Users\nnorm\adr-field-estimator`). The Next.js app `nnorman100/Dryscope` (AI Studio build, Firebase `dryscope-d6f72`) is only a source of features. Its features are rebuilt in the field estimator's own style, not its look (PRs #115 and #117). "DryScope" is the name inside the app only: no repo rename and no domain (Nate, Oct 24). The Firebase project stays `alert-disaster-field-2026`.

Goal: finish the Dryscope ports Nate picked, then build the first missing VISION.md piece he chose, **delivery after signing**.

## Where we are (Oct 24, 2026)
- Live: backend `00065-bat`, Hosting `1792708536426000`, commit `0b5dbae` (`RELEASES.md`). Master is `a6d1794`. There are no open PRs or issues.
- Shipped Oct 19–22: walkthrough-first flow, owner logins, QR tags (#115), drying log with psychrometrics and thermal readings (#117), claim and loss details (#118), IICRC sizing (#119), photo shot list (#121), landing page at `/` with the app at `/app` (#124), built-in ADR branding removed (#127).
- Already ported or better in the field estimator, so skipped: dictation to scope, the Live bar, documents, superadmin, owner/office dashboards, new job intake, and Dryscope pricing (it doesn't match the workbook).
- Never observed on a device: every release since Oct 18 was checked signed-out only. Still open: phone test 2 of the new features, a physical iPhone, a Google-account invitee, and invitation email in Gmail and Outlook. WebKit tests were not run locally.
- ADR has no company profile or logo since #127; the app shows its name only.
- Wiki notes `projects/adr-field-estimator.md` (stops at Oct 18) and `projects/dryscope.md` (calls the Next.js repo "the successor") are out of date.

## How every item ships
- One small PR per item, each with a test that fails without the change (VISION "Proven before it is claimed").
- Firstmate merges Low and Medium risk PRs with green CI. High risk PRs and every production release need Nate's go.
- Releases follow the existing `RELEASES.md` recipe: `scripts/deploy_backend.py` stages the backend, then a preview channel, then promotion, then a Hosting deploy (`hosting:alert-disaster` only), then a 15-minute watch. Each release appends its rows to `RELEASES.md`.
- Batch the releases. Release once after Phase 1. In Phase 2, release steps 1–2 together, then steps 3–6 together.

## What each item changes, by layer
| Item | Frontend / UI | Backend | Database (Firestore) |
|---|---|---|---|
| 1.1 Jobs filters + search (PR #130) | Tabs with counts, search box, customer and claim on each row | List summaries carry `customer_name` and `claim_number` | None: reuses the job sidecar row already read |
| 1.2 GPS stamp | Ask for location when a photo is taken; show it in the photo log | Validate and store the location; never change it on a signed record | New location fields on photo metadata; older photos have none and show "no location recorded" |
| 1.3 Address autocomplete + map | Suggestions under the address field; static map image; directions link | Places proxy routes with a per-user daily cap | Job coordinates saved on the draft; key in Secret Manager |
| 1.4 Copy signed job to draft | "Copy to new draft" on signed jobs | Copy route: rooms, scope, claim; no signatures, audit or links | New draft records `copied_from` |
| 2 Delivery | Delivery status and Resend on the job; read-only document page; crew-lead email and delivery on/off in company settings | Shared SMTP sender, send after signing, retry without double-sending, document-link tokens | Delivery sidecar per job, document-link records, crew-lead email and delivery switch on the company |

## Checks every item must pass (part of each PR's "done")
1. **Rules and indexes.** Browsers never read Firestore directly, so `firestore.rules` should stay deny-all. Check it anyway. Declare any new composite index in `firestore.indexes.json` and deploy it with the release (`--only firestore:indexes`), never by hand in the console.
2. **Older records.** Say how jobs saved before the change display and behave. Test one old-shape record. Never backfill invented values.
3. **Offline.** VISION says field work is never silently lost. Each feature says what happens with no signal. GPS works offline. Autocomplete falls back to typing. Copy-to-draft and Resend need a connection and say so. Delivery is queued on the server, never on the phone.
4. **Who may use it.** Add each new action to the role permission matrix (`can()` in `public/workspaces.js` and its server check). Test owner, estimator, office, superadmin support (read-only), and a different company's user.
5. **App update and cache.** New or changed front-end files go in the `sw.js` precache list and bump the shell version, so phones get the update. `scripts/verify_hosting.js` now reads asset counts from the shells (#123, #126), so it needs no edit. Re-run it.
6. **Help and docs.** Update the in-app Help how-tos for each role that sees the feature, plus `README.md` and `docs/company-workspaces.md`.
7. **Privacy and logs.** Logs carry allowlisted fields only: no emails, addresses, coordinates or customer names. GPS and Places lookups are location data, so the photo log labels where a location came from, and the proposal's privacy wording mentions it (Nate approves the wording).
8. **Phone check by Nate.** Each new screen is checked on a real phone before it counts as done. Record that check separately from the automated results.

## Phase 0: Prove what's live (about 1 day, mostly Nate)
1. **Phone test 2 (Nate, on his phone):** walkthrough with room chips, shot list, QR tag scan and print, drying log, claim details, sizing check, Fill scope, signing on site and by link. Do it on an iPhone if one is available. Log what Nate observes in `RELEASES.md` and the release notes, kept separate from mock results.
2. **ADR company profile:** Nate, as owner, uploads ADR's logo and contact details in Account. Then check the documents and the signing page show it.
3. **Invitation check:** send one invitation to a Google account and one to an Outlook address. Check the logo renders and that accepting works.
4. Fix only what the test finds, as small PRs.
5. ~~Update the wiki notes~~ Done Oct 24 (ADR note, Dryscope note, index, log).
6. **Fix the local SMTP timeout test.** `tests/test_workspaces.py::test_smtp_session_that_hangs_is_cut_off_at_the_deadline_without_a_retry` fails on `master` on this Windows machine and passes in CI. Find out why, probably timing or sockets on Windows, and fix the test or the code so the local suite is green. Small PR, Low risk.

## Phase 1: Port the four Dryscope features
Source files are in `nnorman100/Dryscope`; read them with `gh api`. Rebuild each in the field estimator's static frontend (`public/*.js`, no build step) and Python backend (`backend/`).

1. **Jobs list filters and search (S, Low risk).** Add status tabs with counts, and search by client, address or claim number on the company jobs list (`public/workspaces.js:420-470`, `public/app.js:~2575`). It filters on the device, over what `/api/inspections` and `/api/authorizations` already return. Status comes from the coordination record (`backend/workspace_api.py:226`). Totals use the server's `estimateLabel`, never a price worked out on the device. Reference: Dryscope `components/dashboards/TechPipelineDashboard.tsx`.
   - **Status:** merged as PR #130 (`c1bc7d7`, Oct 24); not released yet.
   - **Follow-up before the Phase 1 release:** add a Help how-to ("Find a job") for owner, office and estimator (check 6); confirm the superadmin support list shows the same tabs read-only; Nate tries search on his phone (check 8).
2. **GPS stamp on photos (S–M, Medium risk).** When a photo is taken, record `navigator.geolocation` with its accuracy and a source label ("device" or "not available"; never guess). Store it with the photo metadata in `backend/inspection_store.py` and the photo save path in `backend/main.py`. Print it in the photo moisture log (`public/documents.js`), plus a keyless Google Maps link. A failed or refused location fix is shown as missing, not hidden. Location is part of the evidence, so a signed record's GPS never changes. Reference: Dryscope `TechFieldDashboard.tsx` and the photo log column in `DocumentSuiteModal.tsx`.
   - **Older photos:** photos saved before this show "No location recorded". Nothing is backfilled.
   - **Offline:** location works with no signal and is saved with the photo on the phone, then synced.
   - **Privacy:** never log coordinates. Nate approved the exact proposal wording on Oct 24, 2026: "Photos taken during the inspection are stamped with the location reported by the technician's phone, when the technician allows it, and that location is part of the photo log." New proposals include it; saved signed documents remain unchanged. Include this owner approval in the GPS PR description.
   - **Permission:** the browser asks for location the first time. If the technician says no, photos still save, labeled "Location not shared".
3. **Address autocomplete and job map (M, Medium risk; needs Nate to approve a Maps key).**
   - Add a backend proxy route, e.g. `/api/places/autocomplete` and `/api/places/details`, that calls the Places API (New). Keep the key in Secret Manager. Check the user's identity and membership, and cap calls per user per day like the other AI and API calls.
   - The address field (`public/app.html:60`) suggests addresses and fills city, state, ZIP and coordinates. With no key it stays plain text.
   - Map: a static map image fetched through the backend, plus a keyless directions link. The browser never loads Google's scripts, which keeps VISION's same-origin rule.
   - Reference: Dryscope `components/maps/*` and `lib/maps-config.ts`.
   - **Before turning it on (Nate):** create the key, set a monthly budget alert, and cap requests per day on each API in the Cloud console quotas. Record the cap in `docs/firebase-isolation.md`.
   - **Offline / no key:** the field stays a normal text box. The map panel says "Map unavailable offline".
   - **Data:** save the chosen place's coordinates on the draft. Older jobs have none and show no map, only the directions link built from the address.
   - **Logs:** never log the typed address or the coordinates.
4. **Clone a signed job into a new draft (S–M, Medium risk).** Add a "Copy to new draft" action on a signed job. It creates a new inspection holding the rooms, scope and claim details. It does not copy the signatures, the audit or the signing links, and the signed record stays unchanged. The new draft records which job it came from. Reference: Dryscope `OfficeArchiveVault.tsx` ("Clone / Restore"). Leave out its hard-coded carrier list and settled amounts.
   - **Who:** owner, office and estimator (the estimator only for jobs they can see). Refused for superadmin support, which is read-only. Add it to `can()` and to the server check, and test every role plus a user from another company.
   - **Offline:** needs a connection. The button says so when offline.
   - **Photos:** decide in the PR whether photos come over (default: no, because they belong to the signed evidence). Ask Nate only if it's unclear.

Then release Phase 1, with a short phone check of the four features.

## Phase 2: Deliver the paperwork after signing (VISION "The agreement reaches everyone it involves")
Decisions (Nate, Oct 24): the emails hold **private links, not PDF attachments**. The crew lead gets **email now, with texting later**.

Design:
- **Delivery record:** a new sidecar holding one entry per recipient (homeowner, adjuster, crew lead) with its status: queued, sent, failed or skipped, plus the reason. It lives beside the job's coordination record, never inside the signed agreement. A retry sends only the entries that haven't been sent, so repeating it never sends a second copy. Gmail SMTP doesn't deduplicate (see `backend/workspaces.py:1478`).
- **When it fires:** after a durable signing receipt, both on site (`POST /api/authorize`, `main.py:1183`) and by link (`POST /api/sign`, `main.py:1369`). If sending fails, the signature still stands. The job shows "Delivery failed: Resend".
- **Sending:** reuse the invitation SMTP code (`send_invitation` and `send_smtp`, `backend/workspaces.py:1415-1530`). Pull the shared sending part into one function both callers use, and keep the existing secrets and deadline. Emails carry the company's branding and are signed off as "Powered by DryScope".
- **Private document links:** a new read-only token type (pattern: `backend/signing_links.py`). Each token is bound to one signed authorization and one set of documents, expires (30 days, which Nate can change), can be revoked, and works for more than one view. A new read-only view reuses `public/sign.html`/`sign.js` and `public/documents.js` rendering, with the signing area turned off and photos fetched through the token. The page is `noindex` and sends `Permissions-Policy: tools=()`, like `/sign`.
- **Who gets what:**
  - Homeowner: the signed proposal and photo log.
  - Adjuster: the itemized claim, the scope defense letter, and the existing scope-code JSON export. Send it only when the claim details hold an adjuster email. Make no ESX claim (`AGENTS.md`).
  - Crew lead: a job summary of address, rooms, equipment and drying days. Prices are left out unless Nate asks.
- **Data needed:** a crew-lead email on the company profile or the job, and a delivery on/off switch for each company (owner setting; default on for ADR once tested).

Steps, each its own PR:
1. Shared SMTP sender plus the delivery record and retry, with no emails switched on yet. High risk, because it touches the invitation path; release with Nate's go.
   - Each email sets Reply-To to the company's contact email and shows the company's name, address and phone number.
   - Count emails sent per day. When the count passes 400 (Gmail's limit is about 500), log a warning and show owners a notice.
   - Logs carry only the delivery ID, recipient role and status. Never the email address.
2. Read-only document link and the read-only page.
3. Homeowner email. Use `customer_email` from the coordination record (`backend/workspaces.py:162`). Add an "Email me a copy" checkbox, ticked by default, to the on-site signing step and to the `/sign` link page. Record whether it was ticked with the signature. Send only when it's ticked and an email exists; otherwise mark the entry "skipped" and give the reason. Nate approves the checkbox wording.
4. Adjuster email.
5. Crew-lead email and the delivery switch for each company.
6. Delivery status and Resend on the job, visible to owner and office. Superadmin support sees the status read-only, and the server refuses Resend there. Resend needs a connection. Add a Help how-to ("Sending documents") and update `README.md` ("the app sends no email" changes).

Release steps 1–2 together, then 3–6. Run real-send checks to the test inbox's plus-addresses, then do one real ADR job with Nate.

**Later, not in this plan:** texting through Twilio or Telnyx with US business (10DLC) registration; letting homeowners upload photos through the link; the remaining VISION pieces (company workbook upload, drying schedule, automatic deploys).

## Timeline and later decisions
- **Rough size (guesses, updated after each phase):** Phase 0 about 1 day. Phase 1 is 4 PRs plus follow-ups over 3–5 days. Phase 2 is 6 PRs over about 1–2 weeks.
- **Old Dryscope repo:** no action now. Whether to archive `nnorman100/Dryscope` after Phase 1 ships is Nate's decision later.

## Risks and dependencies
- **Gmail SMTP from Nate's account:** Gmail allows about 500 emails a day, and the sender is personal. Fine for ADR now. Before other companies send at volume, plan a move to a transactional email service with its own domain (needs Nate's decision).
- **Maps key:** Phase 1.3 needs a Google Maps Platform key with billing in `alert-disaster-field-2026`, which Nate must approve.
- **Data compatibility:** new photo GPS fields and delivery records mean rolling back to an older revision makes jobs lose those features, so fixing forward is the safer option. Note this in each release's rollback section, as #122 did.

## Verification
- Per PR: `pytest` (backend), `npm test`, and the Chromium browser specs pass in CI. Each fix has a test that fails without it.
- Delivery: tests with SMTP faked, covering a sent email, a failure then retry sending exactly once, adjuster skipped with no email, and an expired or revoked link refused. A tampered or other-company token gets 401/404.
- Real-service check: send to test plus-addresses and look at the emails in Gmail and Outlook.
- Device: Nate opens each feature on his phone. Any behavior on a device stays open until it's observed.
- Per release: the existing preview channel, `node scripts/verify_hosting.js`, `/api/health` reporting the commit, a 15-minute watch, and the rows in `RELEASES.md`.
