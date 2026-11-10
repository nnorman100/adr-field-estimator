# Runbook

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

## Apply the central Terraform

`infra/dryscope/` holds the Terraform for the rebuilt app's central test and live resources in dedicated project `dryscope` (project number `570228742694`, no Google Cloud organization required), region `us-central1` (`data` and `app` roots; see its [README](../infra/dryscope/README.md)). It has not been applied. The owner reviews every plan; an agent never runs plan or apply against the project. Everything is new in `dryscope` (`us-central1`); nothing touches the legacy `alert-disaster-field-2026` project (`us-west2` service, `(default)` Firestore database, `alert-disaster-field-2026-evidence` bucket, or `adr-runtime` and `adr-builder` accounts), which stays running unchanged until the new app is live.

1. Run the offline checks: `TERRAFORM=<binary> infra/dryscope/scripts/check.sh` (format, validate, the mocked `terraform test` suites, the closed-set plan check on each mocked plan, and the destroy-guard check, for both roots and both environments). Use Terraform 1.9 or later and below 2.0 (the guard check was proven on 1.12.2 and 1.17.1); it reads `prevent_destroy` from the `.tf` files, so the result does not change with the Terraform version.
2. **One-time owner bootstrap for the brand-new `dryscope` project (no organization):**
   - Link billing to project `dryscope` (`570228742694`), then enable the required APIs so Terraform can read project metadata, manage services, and apply both the `data` and `app` roots:
     ```bash
     gcloud services enable --project=dryscope \
       serviceusage.googleapis.com \
       cloudresourcemanager.googleapis.com \
       iam.googleapis.com \
       iamcredentials.googleapis.com \
       sts.googleapis.com \
       sqladmin.googleapis.com \
       firestore.googleapis.com \
       storage.googleapis.com \
       secretmanager.googleapis.com \
       artifactregistry.googleapis.com \
       aiplatform.googleapis.com \
       run.googleapis.com \
       monitoring.googleapis.com \
       logging.googleapis.com \
       billingbudgets.googleapis.com
     ```
   - Create the remote state bucket `gs://dryscope-tfstate` (named in `infra/dryscope/*/envs/backend-*.hcl`) in `us-central1`, private, versioned, with uniform bucket-level access:
     ```bash
     gcloud storage buckets create gs://dryscope-tfstate --project=dryscope --location=us-central1 --uniform-bucket-level-access --public-access-prevention
     gcloud storage buckets update gs://dryscope-tfstate --versioning
     ```
     Give only the applying owner identity access.
   - Apply `data` then `app` for **test** first (steps 3–7 below) before touching **live** (step 8); the plan must delete nothing, except the four named IAM grant changes when [re-applying the test data root](#apply-the-central-terraform) below.
3. Start with **test**. (Cloud SQL tiers differ by environment: `infra/dryscope/README.md`.) Each root and environment has its own state, so always initialise with `-reconfigure` and the matching backend file (never migrate state between them): `terraform init -reconfigure -backend-config=envs/backend-<env>.hcl` in `infra/dryscope/data` or `infra/dryscope/app`. In `infra/dryscope/data`: `terraform init -reconfigure -backend-config=envs/backend-test.hcl`, then `terraform plan -var-file=envs/test.tfvars -out=test.tfplan`. Check the saved plan with the closed-set check: `terraform show -json test.tfplan > test.json && node ../scripts/check-plan.js data test test.json` from the root's directory (use `app` for the app root and `live` for live). It exits non-zero on any delete or replacement (other than the four named grant changes in [re-applying the test data root](#apply-the-central-terraform) below), any update, any resource or IAM grant outside the table (role, member and exact condition), any resource in another project or with another environment's name, or any weakened protection, and the output goes into the apply record. Then read the plan: on a first apply every line must be a create, and on a re-apply of the test data root the four named IAM grant changes are the only lines that are not no-ops. Any other update, replace or destroy line, or any resource whose name is not in the list below (with `<env>` = `test` or `live`), stops the apply:
   - Data root: service accounts `dryscope-api-<env>`, `dryscope-live-<env>`, `dryscope-migrate-<env>`, `dryscope-deploy-<env>`; Cloud SQL instance `dryscope-<env>-pg`, its database `dryscope` and its IAM users for the `api`, `live` and `migrate` accounts; Firestore database `dryscope-field-<env>`; bucket `dryscope-evidence-<env>`; Artifact Registry repository `dryscope-<env>`; secrets `dryscope-<env>-*`; API enablement (`google_project_service`) for the eight listed `*.googleapis.com` services, which changes nothing when an API is already on; and `*_iam_member` grants whose member is one of the `dryscope-*-<env>` accounts (or the workload identity principal set from step 9).
   - App root: Cloud Run services `dryscope-api-<env>` and `dryscope-live-<env>`; the custom role `dryscopeDeploy<Env>` (`dryscopeDeployTest` or `dryscopeDeployLive`); their `*_iam_member` grants; the `DryScope <env> alerts` email channel and `DryScope <env>: ...` alert policies and uptime check; and the `DryScope <env> monthly` budget when a billing account is given.
4. `terraform apply test.tfplan`. Cloud SQL takes several minutes. Then add a value to each secret the data root created (`gcloud secrets versions add dryscope-test-<name> --project=dryscope --data-file=-`), never through Terraform or chat.
5. Owner-run database bootstrap, approved by the owner at apply time. A new IAM database user has no database privileges, so before the first migration the owner connects as a privileged Cloud SQL user (the built-in `postgres` user or another `cloudsqlsuperuser` member, set up out of band through the Cloud SQL Auth Proxy, never through Terraform, its password never in git, chat or state) and grants the migrator only what migrations need: `ALTER ROLE "dryscope-migrate-test@dryscope.iam" CREATEROLE;` (so it can create the non-owner runtime role, which it cannot give `BYPASSRLS`) and `GRANT CREATE ON DATABASE dryscope TO "dryscope-migrate-test@dryscope.iam";` (so it can create the schema it then owns). Never grant the migrator `cloudsqlsuperuser` or `BYPASSRLS`. Then run the schema migrator as `dryscope-migrate-test` (a numbered migration creates the non-owner runtime role with row-level security forced and grants it table rights; Terraform only creates the IAM database users). The files that exist today are the `web/migrations` ledger in [Postgres migrations for the rebuilt app](#postgres-migrations-for-the-rebuilt-app). `0001_foundation` creates the ledger and an empty companies table. It does not create roles or row-level security.
6. Build and push the first images into the `dryscope-test` Artifact Registry repository (`us-central1-docker.pkg.dev/dryscope/dryscope-test/...`) by digest, then in `infra/dryscope/app` run `terraform init -reconfigure -backend-config=envs/backend-test.hcl` and plan and apply with `-var-file=envs/test.tfvars -var api_image=<digest ref> -var live_image=<digest ref>` and `TF_VAR_alert_email` set in the shell (the address is never in git).
7. Verify with the test identity: it reads only test resources and is refused on live ones. Check an alert test notification, the uptime check (live only), and that test services scale to zero.
8. Repeat for **live** with `envs/live.tfvars`, only after the test run is clean and the owner approves, including the step 5 bootstrap for `dryscope-migrate-live`. In each root, first run `terraform init -reconfigure -backend-config=envs/backend-live.hcl` so live never writes to test state. The `project_iam_member` lines (conditioned Cloud SQL and Firestore access, and the predict-only `dryscopeGemini<Env>` custom role, which holds `aiplatform.endpoints.predict` and nothing else), the unconditional `allUsers` `roles/run.invoker` binding on both Cloud Run services (the app verifies Firebase sign-in itself) and the `dryscopeDeploy<Env>` custom role bound to the deploy account on both services are IAM changes for the owner to review: confirm each in the plan, and that the custom role's permissions are only Cloud Run reads plus `run.services.update`, with no `run.services.delete` or `run.revisions.delete`.
9. For keyless deploys, create a separate GitHub workload identity pool per environment in project `dryscope` (`570228742694`), named `dryscope-test` and `dryscope-live`, never two providers in one pool (the same repository mapping in a shared pool gives both environments the same principal set, so a token the test provider accepts could impersonate the live deploy account). The live pool's provider needs an attribute condition restricting it to the repository owner, the protected branch and the live GitHub environment (`assertion.repository_owner`, `assertion.ref` and `assertion.environment`); the test provider may be looser, because its pool cannot reach live. Then pass `-var workload_identity_principal_set=principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-<env>/attribute.repository_id/<numeric id>` to the data root, so live is bound only to a principal set from the `dryscope-live` pool. The variable and the plan check refuse any other pool (a shared one or the other environment's), the pool-wide wildcard and anything not scoped to one repository. For the budget alert, pass `-var billing_account_id=...` to the app root.

**Releases and roll back.** Terraform creates the two Cloud Run services with the first image and then ignores their image and traffic, so a release or rollback never needs an apply: the deploy account (which cannot run these roots) deploys a new digest with `gcloud run deploy`, and rolls back with `gcloud run services update-traffic <service> --to-revisions=<earlier revision>=100 --region=us-central1`. Passing a different digest to Terraform later changes nothing. The deploy account must never be able to edit its own custom role (`iam.roles.update`), or it could add the delete permission back.

**No resource is deleted by an apply that passes the plan check; the only IAM grants it removes or replaces are the four named in [re-applying the test data root](#apply-the-central-terraform) below.** The old us-west2 service keeps serving until the cutover plan says otherwise. Removing a protected resource is a separate owner operation: lift its protection by hand, with a backup and a recorded reason.

**Re-applying the test data root after the Live relay grants were removed.** The first data table gave the Live relay account (`dryscope-live-<env>`) Cloud SQL connect and login and `roles/datastore.user`, and matched the Firestore grant on the database name only. The current table gives Cloud SQL connect and login to the `api` and `migrate` accounts only, gives `roles/datastore.user` to the `api` account only, and conditions it on the environment's database or any name under it (`resource.name == 'projects/dryscope/databases/dryscope-field-<env>' || resource.name.startsWith('projects/dryscope/databases/dryscope-field-<env>/')`, so its documents are covered and the other environment's database, or a sibling such as a restored copy, is not). An environment applied with the first table (test) therefore plans exactly four IAM changes and nothing else: deletes of `google_project_iam_member.sql_client["live"]`, `sql_login["live"]` and `firestore_user["live"]`, and a replacement of `firestore_user["api"]` (the provider cannot change a condition in place). Run the same steps 3 and 4. The plan check accepts those four by name, and only as exactly that change: a delete must remove the Live relay grant with that role and member, and the replacement must keep role and member and move from the earlier exact-name condition to the current one. Any other delete, replacement or update still fails it, and every other plan line must be a no-op. The Live relay's Cloud SQL IAM user stays (removing it would be a delete); without the two roles it cannot connect or log in. Expect the web app's Firestore access to drop for a moment between the delete and the create; nothing in test uses it yet.

**Evidence uploads never overwrite.** The web app's `roles/storage.objectCreator` carries no delete, and Google's role table says it does not overwrite, but the evidence bucket keeps object versions and the "no overwrite" rule must not rest on how the role is evaluated against a versioned name. Every evidence upload must create with a does-not-exist precondition, `ifGenerationMatch=0` (the JSON API parameter; `x-goog-if-generation-match: 0` in the XML API, `if_generation_match=0` or the equivalent in a client library), and treat the `412 Precondition Failed` that an existing name returns as a refused write, never retrying it without the precondition. A test for the upload code must show that a second upload to the same name is refused.

## Postgres migrations for the rebuilt app

`web/migrations` is a numbered ledger. Files are named `0001_name.sql`, `0002_name.sql`, and so on. From `web/`, `npm run db:migrate` applies each missing file in order, in its own transaction that takes the migration lock and rereads the ledger, before a new version of the rebuilt app takes traffic. It records the file id and a SHA-256 of the file bytes in `migration_ledger`. A second run applies nothing. A gap in the numbers, or a file whose bytes changed after it was applied, stops the run. The command reads `APP_ENV` and `DATABASE_URL` from the environment, then from `web/.env.local` for any that are unset. This repository does not point that command at Cloud SQL. The owner runs it against an instance the owner has created.

Schema changes follow add, then switch, then remove:

1. Add the new table or column in a migration, and ship the app still able to read the old shape.
2. Switch readers and writers to the new shape only after that migration has been applied.
3. Remove the old shape in a later migration only after a fresh backup of that database and an explicit owner approval.

The migrator does not parse SQL for removals: a migration that removes a table, column or rows needs the fresh backup and the owner's explicit approval before it merges, and a later least-privilege migration role will back that up. Each file runs with its ledger row in one transaction; a file that ends that transaction with its own `COMMIT` or `ROLLBACK` fails and is not recorded. Do not roll the database backward to make an older image start. Fix forward on the same data. The same rule is the data contract in [DATA.md](DATA.md#rebuilt-app-postgres-not-deployed).

## Common problems

| Symptom                                       | First checks                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in fails with `auth/unauthorized-domain` | Host has a trailing dot or wrong domain; use the canonical host                                                                                     |
| Everyone gets 403 "Set your own password…"    | Account has `password_change_required`; user must set a password                                                                                    |
| Documents/emails not delivered                | Delivery status on the job; company delivery switch; `INVITATION_TRANSPORT` (production: `smtp`) and its secret; daily email count (warning at 400) |
| Address suggestions blank                     | Maps key/secret, per-user daily cap, or offline                                                                                                     |
| Phone shows an old screen                     | Service worker cache; use **Save & update**; check `sw.js` version bump                                                                             |
| Post-deploy verifier fails on CSP             | Compare with the Oct 26 Google telemetry fix in `RELEASES.md`                                                                                       |
| AI features missing                           | `AI_FEATURES` value on the serving revision                                                                                                         |

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
