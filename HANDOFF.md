# Handoff

Current state of DryScope for whoever picks the work up next. It points at the records that
stay current instead of copying them: **what is serving** is read from `RELEASES.md`, the
Deploy run history and `/api/health`, never from this file.

Read in this order: `CLAUDE.md` and `AGENTS.md` (rules), `VISION.md` (what the product is),
this file, `docs/STATUS.md` (each feature: built, on, checked on a phone), `docs/spec.md`,
`docs/phone-acceptance.md`.

## What is live

| Item | Where to read it |
|---|---|
| Serving backend revision, version (`YYYY.MM.DD-N`) and source commit | `GET /api/health`, the app footer or Account menu, `node scripts/verify_hosting.js` |
| Release history | `RELEASES.md` (manual releases) and the newest **Deploy** run in GitHub Actions (automatic releases are recorded in the job summary, not in `RELEASES.md`) |
| Cloud Run service | `alert-disaster-field-estimator`, `us-west2`, project `alert-disaster-field-2026` |
| Hosting | target `alert-disaster`, site `alert-disaster-field-2026`; app at `https://alert-disaster-field-2026.web.app/app` |
| Latest release row in `RELEASES.md` when this file was written (2026-11-06) | 2026-11-04, version `2026.11.04-5`, commit `22b3a509`, promoted to 100% with Hosting released. Automatic deploys after that date appear only in the Actions history, so recheck before relying on this row |

## Feature switches

Switches are environment variables on the Cloud Run revision, set by `scripts/deploy_backend.py`.
A switch is turned on by a reviewed pull request that changes the repository baseline plus the
owner's word, never by a flag on the deploy command (`docs/firebase-isolation.md#turning-a-feature-on-or-off`).

| Switch | Repository baseline | Controls |
|---|---|---|
| `WORKSPACES_ENABLED` | on (the live service has it on; `auto_deploy.py` passes `on`) | company workspaces, roles, memberships. Off is a rollback mode that uses the `STAFF_EMAILS` allowlist |
| `AI_FEATURES` | `readiness` | comma list. Names the code checks: `readiness`, `drying_watch`, `priced_extras`, `job_summary`, `ai_usage`, `estimate_assist` (`docs/AI.md`) |
| `PRICE_BOOKS_ENABLED` | `false` | the price editor, the `prices_read`/`prices_manage` capabilities, the estimator item list, Switch to v2 |
| `RETENTION_ENABLED` | `false` (`DEFAULT_RETENTION = 'off'` in `scripts/deploy_backend.py`) | the record-retention deletion sweep; the owner's retention setting works with it off, and nothing is deleted (`docs/company-workspaces.md#record-retention`) |
| `APPCHECK_MODE` | `monitor` by default; only `off` or `monitor` are accepted, enforcement is not built | App Check (`docs/app-check.md`) |
| `AUTO_DEPLOY_ENABLED` (GitHub repository variable) | owner-set | automatic deploys after CI; anything but `true` pauses them |

`AUDIT_MODEL`, `OCR_MODEL`, `LIVE_MODEL`, `GOOGLE_CLOUD_LOCATION` and `LIVE_LOCATION` are not set by
the deploy script, so the code defaults apply unless the service already carries them. The serving
revision's values were not checked when this file was written.

Live OCR, scope suggestions, audit, voice-note transcription and the Live walkthrough have **no**
switch; they are always on (`docs/AI.md`).

## Last applied data migration

The ledger is the private Firestore collection `_migrations` (`backend/migration_ledger.py`). The
repository holds two migrations, both run by hand with the owner's word:

| Migration id | Script | Purpose |
|---|---|---|
| `adr-company-v1` | `scripts/migrate_workspaces.py` | create ADR's company, owner membership and superadmin |
| `price-books-v1` | `scripts/migrate_price_books.py` | seed ADR's rate book |

The ledger "starts empty; migrations applied before it existed are not backfilled", so which of
these show as applied is **not verified from the repository**. Read `_migrations` (owner or
superadmin access) before assuming either has run. Rollbacks stop when the target is older than
a recorded migration (`docs/runbook/releases.md`).

## Open items

Owner actions (from `docs/STATUS.md`, recheck there):

1. Phone test 2 on a real iPhone (roadmap Phase 0 item 1): camera, microphone, Bluetooth,
   reconnect, interruption, Finish cleanup, sub-second latency. All still open; see the numbered
   owner script in `docs/phone-acceptance.md`.
2. ADR company profile and logo (Phase 0 item 2).
3. Invitation check to a Google and an Outlook address (Phase 0 item 3).
4. Before a second company subscribes: the rebuild's isolated `test` resources (databases,
   identities and release targets) in project `dryscope`, never in `alert-disaster-field-2026`
   (D-006 Nov 9 note, D-012), and Resend email with a company sending domain (D-007).
5. Decide which flag-off features to switch on, one reviewed pull request at a time, each with a
   phone check.
6. Photo originals (#223) are built but not released or phone-checked.

Known gaps in automated proof of the standard's three required checks are listed in
`docs/spec.md` under "Standard checks".

Pending work in other branches and pull requests as of 2026-11-06: square-foot price brackets
(#228) and a per-company monthly AI cap (#230) are open pull requests and are **not** described
in this repository's docs until they merge. Record retention (#229) is merged with its deletion
sweep off.

## Rules that decide what you may do

- The owner approves every merge: agents ask before merging any PR and nothing merges
  automatically (D-009, kept on Nov 9, 2026; D-012 in `docs/DECISIONS.md`). High-risk
  work needs two separate independent reviews on top of the pipeline review, from models that did not write the code. Deploys run to test first, then live. Still owner-only:
  anything that deletes data, cannot be undone, or changes security or permissions (IAM, secrets,
  Firebase Auth settings); turning on deletion or new pricing; and production steps the owner
  runs.
- Never run a blanket `firebase deploy`; only `firebase deploy --only hosting:alert-disaster --project alert-disaster-field-2026`
  after the backend is deployed.
- Never weaken a test, eval fixture, threshold or workflow; the Test guard blocks it.
- Keep `index.html` and `public/index.html` identical.
- Required docs (`README.md`, `CLAUDE.md`, `AGENTS.md`, this file, `docs/spec.md`,
  `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/DATA.md`, `docs/RUNBOOK.md`, `docs/AI.md`)
  must exist and hold text; `npm run lint` runs `scripts/check_required_docs.js` and fails
  otherwise.
