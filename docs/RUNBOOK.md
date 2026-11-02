# Runbook

## Where things run
| Item | Value |
|---|---|
| Project | `alert-disaster-field-2026` |
| Cloud Run service | `alert-disaster-field-estimator`, region `us-west2` |
| Hosting target | `alert-disaster` (site `alert-disaster-field-2026`) |
| App URL | `https://alert-disaster-field-2026.web.app/app` |
| Runtime / build accounts | `adr-runtime@…`, `adr-builder@…` |
| Evidence bucket | `alert-disaster-field-2026-evidence` |
| Vault backup | job `dryscope-vault-backup` (see `docs/VAULT-BACKUP.md`) |
| Monitoring | `docs/MONITORING.md` |

## What is serving
Check the live version (`YYYY.MM.DD-N`) in the app footer or **Account** menu (`App version YYYY.MM.DD-N`), or query `/api/health` (reports `version` and `source_commit`) and `node scripts/verify_hosting.js`. Read the newest rows of `RELEASES.md`, the GitHub Releases page, and the newest Deploy run in the Actions history (automatic deploys are recorded there, not in `RELEASES.md`). Do not trust memory or this file for "what is live."

## Release
Follow the recipe at the top of `RELEASES.md` and `docs/SHIP-CHECKLIST.md`. Operator-run, with the owner's go. Full commands: `docs/firebase-isolation.md`. Once the owner has set it up, `.github/workflows/deploy.yml` also releases master commits after CI, assigns the next `YYYY.MM.DD-N` version tag and GitHub Release after verification succeeds, and rolls back on failure (`docs/firebase-isolation.md#automatic-deploys`); it stops and leaves the commit for a manual release when rules or indexes changed.

## Roll back
For a one-step rollback to an earlier `YYYY.MM.DD-N` version, run `python3 scripts/auto_deploy.py --rollback <YYYY.MM.DD-N>` or trigger **Deploy** in GitHub Actions with the `version` input (it needs `AUTO_DEPLOY_ENABLED` set to `true`; while paused, use the command). It checks `_migrations`, and when the target version is older than a database/data migration or the ledger cannot be read it warns and stops before staging, because code rollback does not undo data changes; rerun with `--confirm-past-migration` (workflow input `confirm_past_migration` set to `yes`) to go ahead. A rules or index change between the target and what is serving warns and stops the same way, because rules and indexes are not rolled back and stay at the newer hand-released version; the next automatic release then stops for a hand release. It then redeploys that version's backend and Hosting and verifies health.

**After a rollback, pause automatic deploys (`AUTO_DEPLOY_ENABLED`) or revert the bad change before the next merge. Otherwise the next release brings it back.**

For an immediate traffic-only restore, point Cloud Run traffic to the recorded rollback revision (explicit project and region), clone the recorded rollback Hosting version to the live channel, read back both, and append rows to `RELEASES.md`. Do not retry a failed deploy immediately.

## Common problems
| Symptom | First checks |
|---|---|
| Sign-in fails with `auth/unauthorized-domain` | Host has a trailing dot or wrong domain; use the canonical host |
| Everyone gets 403 "Set your own password…" | Account has `password_change_required`; user must set a password |
| Documents/emails not delivered | Delivery status on the job; company delivery switch; `INVITATION_TRANSPORT` (production: `smtp`) and its secret; daily email count (warning at 400) |
| Address suggestions blank | Maps key/secret, per-user daily cap, or offline |
| Phone shows an old screen | Service worker cache; use **Save & update**; check `sw.js` version bump |
| Post-deploy verifier fails on CSP | Compare with the Oct 26 Google telemetry fix in `RELEASES.md` |
| AI features missing | `AI_FEATURES` value on the serving revision |

## Incidents
1. Contain: revoke the signing/document link, disable the member, rotate the key, or roll back.
2. Look at Cloud Logging (allowlisted fields only) and `_admin_events`.
3. Fix on a branch with a failing test first.
4. Tell affected companies if their data was exposed [owner/legal decides wording].
5. Record it in `RELEASES.md`.

## Backups
Daily copies of logins and evidence photos go to a separate vault bucket (7-day soft delete, 90-day lifecycle). Last restore test: [not recorded — schedule one].

## Contacts
Owner: [Nathanael — phone]. Billing alerts: [email]. Maps budget alert: $25.
