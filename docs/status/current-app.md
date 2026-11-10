# Status: Current app (Python backend and `public/`)

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Walkthrough-first flow, Live, offline notes | yes | yes | partial | Owner's staged field workflow passed Oct 14; physical iPhone checks still open |
| Company workspaces and roles | yes | yes (since Oct 15) | partial | One real invitation accepted Oct 14; Google-account invitee not yet checked |
| Invitation clearing (owners) | yes | yes | no | #167 |
| QR tags, drying log, claim details, sizing, shot list | yes | yes | no | |
| Jobs list tabs and search | yes | yes | no | #130 |
| GPS stamp on photos | yes | yes | no | |
| Photos upload as a 2,560 px binary copy; originals follow on Wi-Fi | yes | no | no | Originals upload by themselves where the browser reports Wi-Fi (Chromium on Android) and after the "Upload originals now (use Wi-Fi)" tap elsewhere, iPhone included. Not yet released or phone-checked |
| Address autocomplete and map | yes | yes | no | Maps key set; $25 budget alert |
| Copy signed job to draft | yes | yes | no | |
| Document delivery (homeowner, adjuster, crew lead, resend) | yes | yes | no | Gmail SMTP; limit near 500/day |
| Readiness check | yes | yes (`AI_FEATURES=readiness`) | no | |
| Voice-note signing gate | yes | yes | no | #148, fix #158 |
| Drying watch | yes | flag off | no | |
| Priced extras | yes | flag off | no | |
| Job summaries and AI usage | yes | flag off | no | |
| Company monthly AI spending | yes | not yet released | no | $10 per company per UTC calendar month before launch. Counted-input REST reservations with operation output bounds (OCR 8,192 and scope 16,384 tokens, thinking unchanged); ledger contention returns retryable 429. Owner-chosen soft Live threshold with a $2 admission margin. Failed provider HTTP replies release their holds; Live settles reported cost plus its unreported time tail. Owner dashboard line ("AI used this month") works independently of AI request-count flags. Crash holds remain charged. Generation and browser cooldown helpers are extracted into separate modules without changing behavior. See [Company AI spending](../ai-spending.md); real-service and phone acceptance open |
| Record retention (how long invitations, activity log, drying-watch history and archived-draft photos are kept) | yes | flag off (`RETENTION_ENABLED=false`, `DEFAULT_RETENTION` in `scripts/deploy_backend.py`); the owner's setting is on with the code | no | `docs/company-workspaces.md#record-retention`. Owner sets 90 to 3,650 days per class (90 by default and minimum) in Company settings, with a plain-word sentence per class. With the flag off nothing is deleted. Turning it on is one reviewed PR that changes `DEFAULT_RETENTION`, with the owner's word, after the new `_admin_events` (company_id, created_at) index is deployed by hand and READY. Phone check outstanding |
| Automatic deploys after CI | yes (#171) | not recorded | n/a | Needs the owner's one-time setup in `docs/firebase-isolation.md#automatic-deploys`; runs are recorded in the Actions job summary, not `RELEASES.md`. Refuses, before staging, a repository baseline that would turn off a feature now serving. Skips, with a logged reason, a merge that changes nothing the legacy app is built from (DryScope rebuild merges in `web/`, `infra/`, docs) |
| Release version numbers (`YYYY.MM.DD-N`) and one-step rollback | yes | not yet released | no | Shown in `/api/health`, app footer and Account menu; automatic git tag + plain-word GitHub Release after deploy verification; `auto_deploy.py --rollback <version>` and workflow dispatch warn and stop when rolling back past a `_migrations` data migration or a rules or index change, unless confirmed |
| Vault backup | yes | yes | n/a | Verified Oct 27 |
| Landing page at `/` | yes | yes | no | |
