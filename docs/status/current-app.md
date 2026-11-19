# Status: Current app (Python backend and `public/`)

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

The old app was switched off reversibly on 2026-11-10 (`docs/plans/S8.md`, section 2), so no row below is serving now and On reads no for every row. Each Notes cell starts with the row's state before the switch-off. Its CI checks were removed on 2026-11-15 (#395, D-033) and S8-23 removes it from the repository.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Walkthrough-first flow, Live, offline notes | yes | no | partial | Before 2026-11-10 On was yes. Owner's staged field workflow passed Oct 14; physical iPhone checks still open |
| Company workspaces and roles | yes | no | partial | Before 2026-11-10 On was yes (since Oct 15). One real invitation accepted Oct 14; Google-account invitee not yet checked |
| Invitation clearing (owners) | yes | no | no | Before 2026-11-10 On was yes. #167 |
| QR tags, drying log, claim details, sizing, shot list | yes | no | no | Before 2026-11-10 On was yes. |
| Jobs list tabs and search | yes | no | no | Before 2026-11-10 On was yes. #130 |
| GPS stamp on photos | yes | no | no | Before 2026-11-10 On was yes. |
| Photos upload as a 2,560 px binary copy; originals follow on Wi-Fi | yes | no | no | Before 2026-11-10 On was no. Originals upload by themselves where the browser reports Wi-Fi (Chromium on Android) and after the "Upload originals now (use Wi-Fi)" tap elsewhere, iPhone included. Not yet released or phone-checked |
| Address autocomplete and map | yes | no | no | Before 2026-11-10 On was yes. Maps key set; $25 budget alert |
| Copy signed job to draft | yes | no | no | Before 2026-11-10 On was yes. |
| Document delivery (homeowner, adjuster, crew lead, resend) | yes | no | no | Before 2026-11-10 On was yes. Gmail SMTP; limit near 500/day |
| Readiness check | yes | no | no | Before 2026-11-10 On was yes (`AI_FEATURES=readiness`). |
| Voice-note signing gate | yes | no | no | Before 2026-11-10 On was yes. #148, fix #158 |
| Drying watch | yes | no | no | Before 2026-11-10 On was flag off. |
| Priced extras | yes | no | no | Before 2026-11-10 On was flag off. |
| Job summaries and AI usage | yes | no | no | Before 2026-11-10 On was flag off. |
| Company monthly AI spending | yes | no | no | Before 2026-11-10 On was not yet released. $10 per company per UTC calendar month before launch. Counted-input REST reservations with operation output bounds (OCR 8,192 and scope 16,384 tokens, thinking unchanged); ledger contention returns retryable 429. Owner-chosen soft Live threshold with a $2 admission margin. Failed provider HTTP replies release their holds; Live settles reported cost plus its unreported time tail. Owner dashboard line ("AI used this month") works independently of AI request-count flags. Crash holds remain charged. Generation and browser cooldown helpers are extracted into separate modules without changing behavior. See [Company AI spending](../ai-spending.md); real-service and phone acceptance open |
| Record retention (how long invitations, activity log, drying-watch history and archived-draft photos are kept) | yes | no | no | Before 2026-11-10 On was flag off (`RETENTION_ENABLED=false`, `DEFAULT_RETENTION` in `scripts/deploy_backend.py`); the owner's setting is on with the code. `docs/company-workspaces.md#record-retention`. Owner sets 90 to 3,650 days per class (90 by default and minimum) in Company settings, with a plain-word sentence per class. With the flag off nothing is deleted. Turning it on is one reviewed PR that changes `DEFAULT_RETENTION`, with the owner's word, after the new `_admin_events` (company_id, created_at) index is deployed by hand and READY. Phone check outstanding |
| Automatic deploys after CI | yes (#171) | no | n/a | Before 2026-11-10 On was not recorded. Needs the owner's one-time setup in `docs/firebase-isolation.md#automatic-deploys`; runs are recorded in the Actions job summary, not `RELEASES.md`. Refuses, before staging, a repository baseline that would turn off a feature now serving. Skips, with a logged reason, a merge that changes nothing the legacy app is built from (DryScope rebuild merges in `web/`, `infra/`, docs) |
| Release version numbers (`YYYY.MM.DD-N`) and one-step rollback | yes | no | no | Before 2026-11-10 On was not yet released. Shown in `/api/health`, app footer and Account menu; automatic git tag + plain-word GitHub Release after deploy verification; `auto_deploy.py --rollback <version>` and workflow dispatch warn and stop when rolling back past a `_migrations` data migration or a rules or index change, unless confirmed |
| Vault backup | yes | no | n/a | Before 2026-11-10 On was yes. Verified Oct 27 |
| Landing page at `/` | yes | no | no | Before 2026-11-10 On was yes. |
