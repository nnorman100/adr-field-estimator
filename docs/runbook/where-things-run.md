# Where things run and what is serving

## Where things run

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

Check the live version (`YYYY.MM.DD-N`) in the app footer or **Account** menu (`App version YYYY.MM.DD-N`), or query `/api/health` (reports `version` and `source_commit`) and `node scripts/verify_hosting.js`. Read the newest rows of `RELEASES.md`, the GitHub Releases page, and the newest Deploy run in the Actions history (automatic deploys are recorded there, not in `RELEASES.md`). Do not trust memory or this file for "what is live."
