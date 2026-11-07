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
Follow the recipe at the top of `RELEASES.md` and `docs/SHIP-CHECKLIST.md`. A hand release is a production step the owner runs (`HANDOFF.md`, "Rules that decide what you may do"). Full commands: `docs/firebase-isolation.md`. Once the owner has set it up, `.github/workflows/deploy.yml` also releases master commits after CI, assigns the next `YYYY.MM.DD-N` version tag and GitHub Release after verification succeeds, and rolls back on failure (`docs/firebase-isolation.md#automatic-deploys`); it stops and leaves the commit for a manual release when rules or indexes changed, or when the repository baseline would turn off a feature now serving.

## Pipeline gate settings
`.no-mistakes.yaml` sets the repo-level no-mistakes gate rules: protected paths (workflow files, `CLAUDE.md`, `AGENTS.md`, `scripts/test-guard.mjs` and `.github/test-guard.json`, which automatic fixes must leave for a person) and two review auto-fix rounds. The reviewer agent is a global-only setting. Protected paths take effect once this file is on `master`.

## Switch a company to its own price table
The company's owner does this in the app, with `PRICE_BOOKS_ENABLED` on. It cannot be undone.

1. Have everyone connect their phones so open drafts sync. A draft still only on a phone at publish becomes a new job on the published table at its first save, with no reprice review (see [Company workspaces](company-workspaces.md#company-prices)).
2. On **Company prices**, choose **Switch to v2**, check the mapped table and the sample differences in the review, then publish.
3. Drafts already on the server keep their rate book until the owner chooses **Review new prices for this job** on that draft. New jobs use the table.

## Roll back
For a one-step rollback to an earlier `YYYY.MM.DD-N` version, run `python3 scripts/auto_deploy.py --rollback <YYYY.MM.DD-N>` or trigger **Deploy** in GitHub Actions with the `version` input (it needs `AUTO_DEPLOY_ENABLED` set to `true`; while paused, use the command). It redeploys that version's backend and Hosting and verifies health, but stops first when the target is older than a data migration, rules or indexes changed since it, or the repository baseline would turn off a feature now serving; `docs/firebase-isolation.md#rollback` has the confirmations and what stays unchanged.

**After a rollback, pause automatic deploys (`AUTO_DEPLOY_ENABLED`) or revert the bad change before the next merge. Otherwise the next release brings it back.**

For an immediate traffic-only restore, point Cloud Run traffic to the recorded rollback revision (explicit project and region), clone the recorded rollback Hosting version to the live channel, read back both, and append rows to `RELEASES.md`. Do not retry a failed deploy immediately.

### Turning company prices off
Change `DEFAULT_PRICE_BOOKS` back to `off` in a reviewed PR, then release that commit with `--confirm-baseline` (`docs/firebase-isolation.md#turning-a-feature-on-or-off`). That hides the price editor, the **Switch to v2** card and the estimator's item list, and the app shows the v1 form, including for a draft a phone already holds. It does not touch the data or the calculation, so nothing already priced moves:

- A job pinned to a company table keeps pricing from it, because the engine is not behind the flag. Documents print as before.
- A job started while the flag is off pins at its first audit, to the company's current table if it has one. Quantities only the item list collects (owner-added items) keep their saved values and cannot be edited until the flag is back on.
- A company that switched stays switched: no release can return it to its rate book. To change its prices the flag must be on.
- Unpublished working copies stay saved. Turning the flag on again brings them back.

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


## Company AI allowance and reserved holds

Only an authorized platform operator changes AI allowances; the owner page is
read-only. Use the dedicated `alert-disaster-field-2026` project and its private
Firestore `(default)` database. This procedure is separate from job prices,
per-user quotas and agreement records.

- The code default is $10 per UTC calendar month. A missing
  `_company_ai_budgets/{company_id}` document follows that default, including later
  code-default changes; ordinary AI calls never materialize it.
- To set an approved company override, use the Firestore console to set the
  **integer** field `monthly_cap_microusd` on that exact company's private budget
  document. Dollars multiply by 1,000,000: $10 is `10000000`. Record the company ID,
  previous value, approved new value, reason and operator in the operator's change
  record. No app endpoint or owner control writes this document. To return to the
  code default, record and remove only that company's explicit budget override
  document; do not leave an existing document with an invalid/missing cap field.
- To investigate allowance that remains reserved, inspect
  `_company_ai_months/{company_id}_{YYYY-MM}` for its `spent_microusd` and
  `reserved_microusd`. In `_company_ai_reservations`, query `company_id` equal to
  the company, then inspect rows whose `month` equals that UTC month and `state`
  equals `reserved`. Inspect `operation`, `amount_microusd` and `live`; reservation
  documents contain no prompts, photos or transcripts. Filter month/state locally
  if the console requests an index; this investigation needs no new index.
- A crash, missing usage or failed settlement can retain a full hold. There is no
  elapsed-time refund: age does not prove no billable request happened. Never delete
  a hold or edit monthly totals to free capacity. Confirm provider usage and arrange
  an audited reconciliation through the idempotent ledger settlement path, or apply
  an approved cap override. A late settlement belongs to its original month. A
  provider HTTP error normally settles zero; a settlement outage may still leave
  its reservation unconfirmed.

The owner display includes both spent and reserved estimates. Check provider
billing independently before reconciling a hold; physical-device and real Vertex
billing acceptance remain open. No automatic refund, TTL, invoice reconciliation
or data migration is part of this feature.
