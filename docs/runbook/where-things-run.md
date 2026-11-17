# Where things run and what is serving

## Where things run (the rebuilt app)

| Item | Value |
| --- | --- |
| Projects | `dryscope` (test); `dryscope-live` (live, planned: [S8 plan](../plans/S8.md)) |
| Services | `dryscope-api-<env>` and the Live relay `dryscope-live-<env>`, region `us-central1`; Cloud SQL `dryscope-<env>-pg`; field database `dryscope-field-<env>` |
| Test address | the web app's `run.app` address until the domain exists; then `test.<domain>` |
| Live address | `app.<domain>`, from the first day (S8) |
| Releases | `docs/runbook/test-release.md`; the newest GitHub Release records each version |
| Terraform | `infra/dryscope/` (`docs/runbook/terraform-apply.md`) |

Live is not applied yet; nothing serves real users from the rebuilt app today.

## The old app (retired, switched off 2026-11-10)

The old app is not serving. It was switched off reversibly on 2026-11-10 and is to be deleted ([S8 plan](../plans/S8.md), owner step B). The table below is kept only so the old resources can be found and removed; the old app's `RELEASES.md` rows and Hosting address are history.

| Item                     | Value                                                    |
| ------------------------ | -------------------------------------------------------- |
| Project                  | `alert-disaster-field-2026`                              |
| Cloud Run service        | `alert-disaster-field-estimator`, region `us-west2`      |
| Hosting target           | `alert-disaster` (site `alert-disaster-field-2026`)      |
| App URL                  | `https://alert-disaster-field-2026.web.app/app`          |
| Runtime / build accounts | `adr-runtime@…`, `adr-builder@…`                         |
| Evidence bucket          | `alert-disaster-field-2026-evidence`                     |
| Vault backup             | job `dryscope-vault-backup` (see `docs/VAULT-BACKUP.md`) |
| Monitoring               | `docs/MONITORING.md`                                     |

## What is serving

For the rebuilt app, read `/api/health` (`environment`, `version`, commit) or the newest GitHub Release. The paragraph below describes the old app and is history. Check the old live version (`YYYY.MM.DD-N`) in the app footer or **Account** menu (`App version YYYY.MM.DD-N`), or query `/api/health` (reports `version` and `source_commit`) and `node scripts/verify_hosting.js`. Read the newest rows of `RELEASES.md`, the GitHub Releases page, and the newest Deploy run in the Actions history (automatic deploys are recorded there, not in `RELEASES.md`). Do not trust memory or this file for "what is live."
