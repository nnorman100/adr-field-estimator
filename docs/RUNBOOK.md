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
Read the newest rows of `RELEASES.md`, then verify read-only: `/api/health` (reports `source_commit`) and `node scripts/verify_hosting.js`. Do not trust memory or this file for "what is live."

## Release
Follow the recipe at the top of `RELEASES.md` and `docs/SHIP-CHECKLIST.md`. Operator-run, with the owner's go. Full commands: `docs/firebase-isolation.md`.

## Roll back
Restore Cloud Run traffic to the recorded rollback revision (explicit project and region), clone the recorded rollback Hosting version to the live channel, read back both, and append rows to `RELEASES.md`. Do not retry the failed deploy immediately.

## Common problems
| Symptom | First checks |
|---|---|
| Sign-in fails with `auth/unauthorized-domain` | Host has a trailing dot or wrong domain; use the canonical host |
| Everyone gets 403 "Set your own password…" | Account has `password_change_required`; user must set a password |
| Documents/emails not delivered | Delivery status on the job; company delivery switch; SMTP secret; daily email count (warning at 400) |
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
