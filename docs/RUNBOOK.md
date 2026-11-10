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

## CI runners

Every job in `.github/workflows/` (CI, Web app, Test guard, CodeQL and Deploy) runs on `${{ vars.CI_RUNNER || 'dryscope-linux' }}`. With the repository variable `CI_RUNNER` unset, jobs go to the self-hosted pool `dryscope-linux`: [runner-up](https://github.com/kunchenguid/runner-up) on the build server, as systemd service `runner-up` (setup in `/root/.config/runner-up/config.json`). It has two Docker places (2 cores, 6 GB each), starts one fresh container per job from the image `dryscope-ci-runner:1` (GitHub's `actions-runner` image plus `libatomic1`, `xz-utils`, build tools, Java 21 and Playwright's system libraries for Chromium and WebKit), and refuses jobs from fork pull requests. `runner-up status` shows each place and the waiting jobs.

The job container is leaner than GitHub's Ubuntu image: it has no Docker daemon (so no `services:` containers) and no Node, PostgreSQL or `gh`. Each job installs what it needs (setup-node, including in CodeQL for the JavaScript extractor, setup-java, Playwright's `install-deps` through `sudo apt-get`, a pinned `gh` in Deploy), and each install step is skipped or harmless on GitHub's image. In the web `database` job the test harness (`web/tests/db/postgres-harness.ts`) starts the throwaway PostgreSQL 16 itself: the `postgres:16` image where a Docker daemon answers (GitHub's image), otherwise `initdb`/`pg_ctl`. Only when there is no Docker daemon and no PostgreSQL 16 (the self-hosted container) does the job first install the Ubuntu `postgresql-16` package from apt, without creating or starting a cluster.

**Switch to GitHub-hosted runners:** set the repository variable `CI_RUNNER` to `ubuntu-latest` (Settings > Secrets and variables > Actions > Variables, or `gh variable set CI_RUNNER --body ubuntu-latest --repo nnorman100/adr-field-estimator`). Only runs that start afterwards use it; re-run any job still waiting for `dryscope-linux`. GitHub-hosted jobs use paid Actions minutes, and while the Actions budget stop is on they fail to start. **Switch back:** `gh variable delete CI_RUNNER --repo nnorman100/adr-field-estimator`.

**Stop runner-up** (on the build server): `sudo systemctl stop runner-up` stops the coordinator; jobs already running finish in their containers, and new jobs wait on GitHub for a `dryscope-linux` runner, so set `CI_RUNNER` first if CI should keep running. `sudo systemctl disable --now runner-up` keeps it off after a reboot. To end running jobs as well, `docker ps --filter label=runner-up.place` lists their containers; remove them with `docker rm -f <name>`. **Start it again:** `sudo systemctl enable --now runner-up`, then check `runner-up status`.

## Legacy CI retired

The old Python app (`backend/`, `public/`, `tests/` and their tooling) is frozen reference code for the TypeScript rebuild in `web/` and `infra/dryscope/`. Nobody uses it and it is deleted in S8, so as of 2026-11-10 most of its checks no longer run. **Do not change legacy files except through S8**; the old app keeps serving until then, and no check now guards those edits. Master's ruleset still requires every job name below, so each one still reports on every pull request and push to `master`:

| Job | What it does now |
| --- | --- |
| `python` | Runs only the pricing-oracle tests (`tests/test_pricing_oracle.py`, with `scripts/pricing_oracle*.py` and the stored answers in `tests/fixtures/pricing-oracle/`). They keep the pinned legacy pricing answers honest until S4 is finished. The rest of the Python suite, `ruff format` and `ruff check` no longer run. |
| `browser` | Reports success at once with `legacy suite retired 2026-11-10; see docs/RUNBOOK.md`. The legacy Playwright suite no longer runs. |
| `firestore-emulator` | Reports success at once with the same message. The legacy Firestore emulator tests no longer run. |
| `node` | Runs `npm ci`, Prettier, `npm run lint` (ESLint, file length, required docs) and the vitest suite, which holds the Terraform plan check. The legacy unit tests in `npm test` no longer run. |
| `Analyze (python)` in CodeQL | Still scans the legacy Python (the pricing code stays in the repo), and still only when a legacy file changed, the diff base is unavailable or on the weekly schedule; otherwise it reports green with the skip reason in its log. |
| `Analyze (javascript-typescript)`, `audit`, `Test guard`, all of `web.yml` | Never scoped; run everything. |

The legacy deploy workflow `.github/workflows/deploy.yml` is disabled in GitHub (the file stays). To run a retired suite by hand for a legacy change, use the commands in `CLAUDE.md` locally.

Only the CodeQL Python analysis still uses the scope step, `scripts/ci_legacy_scope.sh`. It lists the legacy files (the old browser list first, then the unit-test and tooling files) and runs the scan when one changed against the base commit. It runs the scan when it cannot tell what changed: no base commit (new branch, force push, scheduled run), a push whose base is not an ancestor, or a failed diff. `tests/test_ci_legacy_scope.py` covers the script and checks the retired jobs' shape. When S8 deletes the legacy app, remove the script, the Python CodeQL leg and the oracle test together.

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
3. Start with **test**. (Cloud SQL tiers differ by environment: `infra/dryscope/README.md`.) Each root and environment has its own state, so always initialise with `-reconfigure` and the matching backend file (never migrate state between them): `terraform init -reconfigure -backend-config=envs/backend-<env>.hcl` in `infra/dryscope/data` or `infra/dryscope/app`. In `infra/dryscope/data`: `terraform init -reconfigure -backend-config=envs/backend-test.hcl`, then `terraform plan -var-file=envs/test.tfvars -out=test.tfplan`. Check the saved plan with the closed-set check: `terraform show -json test.tfplan > test.json && node ../scripts/check-plan.js data test test.json` from the root's directory (use `app` for the app root and `live` for live). It exits non-zero on any delete or replacement (other than the four named grant changes in [re-applying the test data root](#apply-the-central-terraform) below), any update (other than adding the new `ALLOWED_ORIGINS` setting to Cloud Run services that are already applied: see [sign-in user role](#sign-in-user-role)), any resource or IAM grant outside the table (role, member and exact condition), any resource in another project or with another environment's name, or any weakened protection, and the output goes into the apply record. Then read the plan: on a first apply every line must be a create, and on a re-apply of the test data root the four named IAM grant changes, plus creates of anything added since the first apply (the two sign-in APIs and the `dryscopeIdentityTest` role), are the only lines that are not no-ops. Any other update, replace or destroy line, or any resource whose name is not in the list below (with `<env>` = `test` or `live`), stops the apply:
   - Data root: service accounts `dryscope-api-<env>`, `dryscope-live-<env>`, `dryscope-migrate-<env>`, `dryscope-deploy-<env>`; Cloud SQL instance `dryscope-<env>-pg`, its database `dryscope` and its IAM users for the `api`, `live` and `migrate` accounts; Firestore database `dryscope-field-<env>`; bucket `dryscope-evidence-<env>`; Artifact Registry repository `dryscope-<env>`; secrets `dryscope-<env>-*`; API enablement (`google_project_service`) for the ten listed `*.googleapis.com` services (including `identitytoolkit` and `firebaserules` for sign-in and the field database rules), which changes nothing when an API is already on; the custom roles `dryscopeGemini<Env>` and `dryscopeIdentity<Env>` (see [sign-in user role](#sign-in-user-role)); and `*_iam_member` grants whose member is one of the `dryscope-*-<env>` accounts (or the workload identity principal set from step 9).
   - App root: Cloud Run services `dryscope-api-<env>` and `dryscope-live-<env>` (both get `ALLOWED_ORIGINS`, the environment's own web app address from `allowed_origins` in `envs/<env>.tfvars`; the variable refuses anything but `https://host` origins and the other environment's services); the custom role `dryscopeDeploy<Env>` (`dryscopeDeployTest` or `dryscopeDeployLive`); their `*_iam_member` grants; the `DryScope <env> alerts` email channel and `DryScope <env>: ...` alert policies and uptime check; and the `DryScope <env> monthly` budget when a billing account is given.
4. `terraform apply test.tfplan`. Cloud SQL takes several minutes. Then add a value to each secret the data root created (`gcloud secrets versions add dryscope-test-<name> --project=dryscope --data-file=-`), never through Terraform or chat.
5. Owner-run database bootstrap, approved by the owner at apply time. A new IAM database user has no database privileges, so before the first migration the owner connects as a privileged Cloud SQL user (the built-in `postgres` user or another `cloudsqlsuperuser` member, set up out of band through the Cloud SQL Auth Proxy, never through Terraform, its password never in git, chat or state) and grants the migrator only what migrations need: `ALTER ROLE "dryscope-migrate-test@dryscope.iam" CREATEROLE;` (so it can create the non-owner runtime role, which it cannot give `BYPASSRLS`) and `GRANT CREATE ON DATABASE dryscope TO "dryscope-migrate-test@dryscope.iam";` (so it can create the schema it then owns), plus `GRANT USAGE, CREATE ON SCHEMA public TO "dryscope-migrate-test@dryscope.iam";` because Postgres 15 and later no longer let every user create tables in `public`, where `0001_foundation` puts its tables. The exact commands are in [Release the rebuilt app to test](#release-the-rebuilt-app-to-test), part B. Never grant the migrator `cloudsqlsuperuser` or `BYPASSRLS`. Then run the schema migrator as `dryscope-migrate-test` (a numbered migration creates the non-owner runtime role with row-level security forced and grants it table rights; Terraform only creates the IAM database users). The files that exist today are the `web/migrations` ledger in [Postgres migrations for the rebuilt app](#postgres-migrations-for-the-rebuilt-app). `0001_foundation` creates the ledger and an empty companies table; `0002_identity` adds the sign-in and company-separation tables; `0003_runtime_role` creates the runtime role `dryscope_runtime`, forces row-level security on every table and grants the role to `dryscope-api-<env>@dryscope.iam`; `0004_sign_in_lookup` adds the tenant-to-company lookup the runtime may call before a company is known (`docs/DATA.md`). Terraform creates that IAM database user before the first migration; if it was created after `0003` ran, the API user has no rights until the owner runs `GRANT dryscope_runtime TO "dryscope-api-<env>@dryscope.iam" WITH INHERIT TRUE, SET FALSE;` as the migrator. Check it after the first migration: `SELECT r.rolname, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'dryscope-api-test@dryscope.iam';` must show one row, `dryscope_runtime`, `t`, `f`.
6. Build and push the first images into the `dryscope-test` Artifact Registry repository (`us-central1-docker.pkg.dev/dryscope/dryscope-test/...`) by digest, then in `infra/dryscope/app` run `terraform init -reconfigure -backend-config=envs/backend-test.hcl` and plan and apply with `-var-file=envs/test.tfvars -var api_image=<digest ref> -var live_image=<digest ref>` and `TF_VAR_alert_email` set in the shell (the address is never in git). The release workflow pushes both images (the web app and the `live-relay-placeholder/` stand-in that stage S7 replaces) without Docker and prints their digests; the exact steps are in [Release the rebuilt app to test](#release-the-rebuilt-app-to-test), parts C and D.
7. Verify with the test identity: it reads only test resources and is refused on live ones. Check an alert test notification, the uptime check (live only), and that test services scale to zero.
8. Repeat for **live** with `envs/live.tfvars`, only after the test run is clean and the owner approves, including the step 5 bootstrap for `dryscope-migrate-live`. In each root, first run `terraform init -reconfigure -backend-config=envs/backend-live.hcl` so live never writes to test state. The `project_iam_member` lines (conditioned Cloud SQL and Firestore access, and the predict-only `dryscopeGemini<Env>` custom role, which holds `aiplatform.endpoints.predict` and nothing else), the unconditional `allUsers` `roles/run.invoker` binding on both Cloud Run services (the app verifies Firebase sign-in itself) and the `dryscopeDeploy<Env>` custom role bound to the deploy account on both services are IAM changes for the owner to review: confirm each in the plan, and that the custom role's permissions are only Cloud Run reads plus `run.services.update`, with no `run.services.delete` or `run.revisions.delete`.
9. For keyless deploys (test commands: [Release the rebuilt app to test](#release-the-rebuilt-app-to-test), part A), create a separate GitHub workload identity pool per environment in project `dryscope` (`570228742694`), named `dryscope-test` and `dryscope-live`, never two providers in one pool (the same repository mapping in a shared pool gives both environments the same principal set, so a token the test provider accepts could impersonate the live deploy account). The live pool's provider needs an attribute condition restricting it to the repository owner, the protected branch and the live GitHub environment (`assertion.repository_owner`, `assertion.ref` and `assertion.environment`); the test provider may be looser, because its pool cannot reach live. Then pass `-var workload_identity_principal_set=principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-<env>/attribute.repository_id/<numeric id>` to the data root, so live is bound only to a principal set from the `dryscope-live` pool. The data root binds that principal set to two accounts: the deploy account (images and Cloud Run) and the migrator (numbered migrations before traffic), so the deploy account never reaches the database. The variable and the plan check refuse any other pool (a shared one or the other environment's), the pool-wide wildcard and anything not scoped to one repository. For the budget alert, pass `-var billing_account_id=...` to the app root.

**Releases and roll back.** Terraform creates the two Cloud Run services with the first image and then ignores their image and traffic, so a release or rollback never needs an apply (test releases run from `.github/workflows/web-release.yml`; see [Release the rebuilt app to test](#release-the-rebuilt-app-to-test)): the deploy account (which cannot run these roots) deploys a new digest with `gcloud run deploy`, and rolls back with `gcloud run services update-traffic <service> --to-revisions=<earlier revision>=100 --region=us-central1`. Passing a different digest to Terraform later changes nothing. The deploy account must never be able to edit its own custom role (`iam.roles.update`), or it could add the delete permission back.

**No resource is deleted by an apply that passes the plan check; the only IAM grants it removes or replaces are the four named in [re-applying the test data root](#apply-the-central-terraform) below.** The old us-west2 service keeps serving until the cutover plan says otherwise. Removing a protected resource is a separate owner operation: lift its protection by hand, with a backup and a recorded reason.

**Re-applying the test data root after the Live relay grants were removed.** The first data table gave the Live relay account (`dryscope-live-<env>`) Cloud SQL connect and login and `roles/datastore.user`, and matched the Firestore grant on the database name only. The current table gives Cloud SQL connect and login to the `api` and `migrate` accounts only, gives `roles/datastore.user` to the `api` account only, and conditions it on the environment's database or any name under it (`resource.name == 'projects/dryscope/databases/dryscope-field-<env>' || resource.name.startsWith('projects/dryscope/databases/dryscope-field-<env>/')`, so its documents are covered and the other environment's database, or a sibling such as a restored copy, is not). An environment applied with the first table (test) therefore plans exactly four IAM changes and, apart from creates of resources added since (the two sign-in APIs and the `dryscopeIdentityTest` role), nothing else: deletes of `google_project_iam_member.sql_client["live"]`, `sql_login["live"]` and `firestore_user["live"]`, and a replacement of `firestore_user["api"]` (the provider cannot change a condition in place). Run the same steps 3 and 4. The plan check accepts those four by name, and only as exactly that change: a delete must remove the Live relay grant with that role and member, and the replacement must keep role and member and move from the earlier exact-name condition to the current one. Any other delete, replacement or update still fails it, and every other plan line must be a no-op. The Live relay's Cloud SQL IAM user stays (removing it would be a delete); without the two roles it cannot connect or log in. Expect the web app's Firestore access to drop for a moment between the delete and the create; nothing in test uses it yet.

<a id="sign-in-user-role"></a>**Sign-in user role (`dryscopeIdentity<Env>`).** The data root creates one custom role per environment holding exactly `firebaseauth.users.get`, `firebaseauth.users.create`, `firebaseauth.users.update` and `firebaseauth.users.sendEmail`: no `users.delete`, no `firebaseauth.configs.*` (project and tenant sign-in settings are shared by test and live and stay owner-run) and no `identitytoolkit.tenants.*`. Terraform binds it nowhere. A binding on the project would reach every tenant, including live's, so the owner binds it on each of the environment's own sign-in tenants only, with `tenants/TENANT_ID:setIamPolicy` naming `projects/dryscope/roles/dryscopeIdentity<Env>` (the data root's `identity_users_role` output) and `serviceAccount:dryscope-api-<env>@dryscope.iam.gserviceaccount.com`. That a tenant-only binding is honoured by the user-management calls is not yet proven (stage S3's real-service check tests it). The plan check refuses a wider role and any project-level grant of it or of a `roles/firebaseauth.*`, `roles/identitytoolkit.*` or `roles/identityplatform.*` role. **App root already applied.** If the Cloud Run services existed before `ALLOWED_ORIGINS` was added, the app plan updates both services in place to add it. The plan check accepts that update only when, apart from that setting (which must be the environment's own web app address), the planned service equals the applied one; output-only fields the provider recomputes are skipped, and any other change, delete or replacement still fails. Apply the data root instead of creating the role by hand: a role created by hand under the same id makes the apply fail until it is imported or deleted.

**Evidence uploads never overwrite.** The web app's `roles/storage.objectCreator` carries no delete, and Google's role table says it does not overwrite, but the evidence bucket keeps object versions and the "no overwrite" rule must not rest on how the role is evaluated against a versioned name. Every evidence upload must create with a does-not-exist precondition, `ifGenerationMatch=0` (the JSON API parameter; `x-goog-if-generation-match: 0` in the XML API, `if_generation_match=0` or the equivalent in a client library), and treat the `412 Precondition Failed` that an existing name returns as a refused write, never retrying it without the precondition. A test for the upload code must show that a second upload to the same name is refused.

<a id="owner-cloud-steps-in-order"></a>
## Owner cloud steps, in order

The one list of steps only the owner runs for the rebuilt app in project `dryscope`. Agents never run them. Do **test** first and tick each box only after its check passes; repeat the per-environment items for **live** only when the owner decides (item 14). Nothing in this repository records any of them as done: `infra/dryscope/` has not been applied, so every box starts empty. This list links to the detail instead of repeating it; the sign-in commands are in the [S3 plan, section 6](plans/S3.md#6-owner-run-cloud-steps-in-project-dryscope) (**confirm** marks there are fields not yet run). When a stage adds an owner step, add it here in its place in the order.

- [ ] **1. Project bootstrap.** Link billing, enable the bootstrap APIs, create the state bucket `gs://dryscope-tfstate` ([Apply the central Terraform](#apply-the-central-terraform), step 2). Needs: the project and the owner's identity. Verify: `gcloud services list --enabled --project=dryscope` lists them; the bucket is private and versioned.
- [ ] **2. Sign-in plan and apply (data root, test).** Run `infra/dryscope/scripts/check.sh`, then plan, run `check-plan.js` and apply the `data` root ([step 3 and 4](#apply-the-central-terraform)). This also turns on the two sign-in APIs and creates the unbound role `dryscopeIdentityTest` ([sign-in user role](#sign-in-user-role)); do not create either by hand. Needs: item 1. Verify: `check-plan.js` exits 0, the plan deletes nothing except the four named grants on a re-apply, and after the apply a second plan shows no changes.
- [ ] **3. Secret values.** Add a value to each `dryscope-test-*` secret ([step 4](#apply-the-central-terraform)), never through Terraform or chat. Needs: item 2. Verify: `gcloud secrets versions list dryscope-test-<name> --project=dryscope` shows an enabled version for each.
- [ ] **4. Keyless deploy pool.** Create the workload identity pool `dryscope-test` (its own pool, one provider), then re-plan and apply the data root with `-var workload_identity_principal_set=...` ([step 9](#apply-the-central-terraform)). Needs: item 2. Verify: the plan check accepts the principal set; the principal set names `dryscope-test` and one repository id; `gcloud iam workload-identity-pools describe dryscope-test --location=global --project=dryscope` returns it.
- [ ] **5. Database setup grants, then migrations.** As a privileged Cloud SQL user through the Auth Proxy, give the migrator `CREATEROLE` and `CREATE` on the database (never `cloudsqlsuperuser` or `BYPASSRLS`), then run the migrator as `dryscope-migrate-test` ([step 5](#apply-the-central-terraform); [Postgres migrations](#postgres-migrations-for-the-rebuilt-app)). Needs: item 2 (the instance and IAM users exist). Verify: `migration_ledger` holds every file in `web/migrations`; a second `npm run db:migrate` applies nothing.
- [ ] **6. Identity Platform on, project settings, authorized domains.** [S3 plan section 6](plans/S3.md#6-owner-run-cloud-steps-in-project-dryscope) steps 2 to 4: `initializeAuth`, allow tenants, no public sign-up, hide which emails exist, add the test app's address. Needs: item 2 (the APIs are on). Verify: a `GET` on the project config returns the settings; sign-in settings are shared by `test` and `live`, so this is owner-run only.
- [ ] **7. Test tenants and the per-tenant role binding.** Create `test-operators`, `test-company-a` and `test-company-b`, then bind `dryscopeIdentityTest` to `dryscope-api-test` on each tenant only, never on the project ([S3 plan section 6](plans/S3.md#6-owner-run-cloud-steps-in-project-dryscope) steps 5 and 7; [sign-in user role](#sign-in-user-role)). Needs: items 2 and 6. Verify: each tenant's IAM policy shows the one binding, and the project's policy shows none for this role. That the binding limits the account to those tenants is not yet proven; S3-18 proves it (item 13).
- [ ] **8. Web app config and Google sign-in.** Register the Firebase web app, restrict its API key to the test app's address, create the Google OAuth client and switch Google on per tenant ([S3 plan section 6](plans/S3.md#6-owner-run-cloud-steps-in-project-dryscope) steps 8 and 9). Needs: items 6 and 7. Verify: the sdk config prints; Google appears under each tenant's providers; the client secret is in no file or chat.
- [ ] **9. First test deploy.** Build and push the first images by digest, then plan, run `check-plan.js` and apply the `app` root ([step 6](#apply-the-central-terraform)), with `ALLOWED_ORIGINS` set from `envs/test.tfvars`. Needs: items 3 to 5. Verify: `GET /api/health` on the test service answers; the plan check passes; test services scale to zero ([step 7](#apply-the-central-terraform)).
- [ ] **10. Runtime-role check after the deploy.** Run the check query in [step 5](#apply-the-central-terraform): `dryscope-api-test@dryscope.iam` must hold one membership, `dryscope_runtime`, with inherit `t` and set `f`. If the IAM user was created after `0003` ran, run the `GRANT` that step names first. Needs: items 5 and 9. Verify: exactly that one row.
- [ ] **11. First operator.** Create the user in the `test-operators` tenant (Console), then run the owner-only command from S3-9 to add the operator row ([S3 plan section 6](plans/S3.md#6-owner-run-cloud-steps-in-project-dryscope) step 11). Needs: items 7 and 10 and S3-9 merged. Verify: the operator signs in with a second step and sees the Companies screen; no API adds operators.
- [ ] **12. Field-database rules (test).** After the rules change merges, deploy them to `dryscope-field-test` only, through the rules REST API release `cloud.firestore/dryscope-field-test` ([S3 plan section 6](plans/S3.md#6-owner-run-cloud-steps-in-project-dryscope) step 12; creating the ruleset first is the dry run). Needs: S3-6 merged (https://github.com/nnorman100/adr-field-estimator/pull/288). Verify: the emulator rules tests pass against the same file, and a signed-in user of company B is refused on company A's path in `test`.
- [ ] **13. Real-service sign-in check (S3-18).** Run the checks S3-18 lists, recorded apart from mock results, including that the `test` app account is refused on a tenant it is not bound to. Needs: items 7 to 12. Verify: the S3-18 record exists; if the tenant-only refusal fails, stop before any live tenant and decide the separate-test-project fallback ([S3 plan section 7](plans/S3.md#7-risks)).
- [ ] **14. Live.** Only after item 13 is clean and the owner approves: repeat only the per-environment items for live, with `envs/live.tfvars` and the live backend files ([step 8](#apply-the-central-terraform)): item 2 (data root), 3 (`dryscope-live-*` secrets), 4 (pool `dryscope-live` with its attribute condition), 5 (`dryscope-migrate-live` grants and migrations), 7 (live tenants, binding `dryscopeIdentityLive` to `dryscope-api-live` on each live tenant only), 8 (live web app, API key restricted to the live address, Google on for each live tenant), 9 (app root), 10 (runtime-role check for `dryscope-api-live@dryscope.iam`), 11 (live operator) and 12 (rules release `cloud.firestore/dryscope-field-live`). Items 1 and 6 are once per project and are not repeated; the only live change there is adding the live app's address to the authorized domains (S3 plan section 6 step 4). Then, in the owner's own timing and each its own approval: the public address and front door, and the later retirement of the old app in `alert-disaster-field-2026` (deletions are owner-only). Needs: item 13. Verify: each item's check, against live resources only.

## Postgres migrations for the rebuilt app

`web/migrations` is a numbered ledger. Files are named `0001_name.sql`, `0002_name.sql`, and so on. From `web/`, `npm run db:migrate` applies each missing file in order, in its own transaction that takes the migration lock and rereads the ledger, before a new version of the rebuilt app takes traffic. It records the file id and a SHA-256 of the file bytes in `migration_ledger`. A second run applies nothing. A gap in the numbers, or a file whose bytes changed after it was applied, stops the run. The command reads `APP_ENV` and `DATABASE_URL` from the environment, then from `web/.env.local` for any that are unset. The test release workflow runs it against the test Cloud SQL instance as `dryscope-migrate-test`, through the Cloud SQL Auth Proxy with IAM login, before a new revision is staged ([Release the rebuilt app to test](#release-the-rebuilt-app-to-test)). Nothing runs it against live.

Schema changes follow add, then switch, then remove:

1. Add the new table or column in a migration, and ship the app still able to read the old shape.
2. Switch readers and writers to the new shape only after that migration has been applied.
3. Remove the old shape in a later migration only after a fresh backup of that database and an explicit owner approval.

The migrator does not parse SQL for removals: a migration that removes a table, column or rows needs the fresh backup and the owner's explicit approval before it merges, and a later least-privilege migration role will back that up. Each file runs with its ledger row in one transaction; a file that ends that transaction with its own `COMMIT` or `ROLLBACK` fails and is not recorded. Do not roll the database backward to make an older image start. Fix forward on the same data. The same rule is the data contract in [DATA.md](DATA.md#rebuilt-app-postgres-not-deployed).

## Release the rebuilt app to test

`.github/workflows/web-release.yml` releases `web/` to the **test** environment only, after the Web app workflow passes on `master` (or by hand: `gh workflow run web-release.yml --ref master`). Every job runs on the switchable CI runner ([CI runners](#ci-runners)), which has no Docker daemon, so images are assembled without Docker: `web/scripts/build-image.sh` builds the Next.js standalone output with npm and appends it as one root-owned `/app` layer onto the base image pinned in `web/Dockerfile`, with [crane](https://github.com/google/go-containerregistry) (`web/scripts/install-crane.sh`, pinned by version and checksum). One release runs at a time:

1. **build** (as `dryscope-deploy-test`): pushes `us-central1-docker.pkg.dev/dryscope/dryscope-test/web:<commit>` with the commit baked in, then uses it by digest. A rerun of the same commit reuses the pushed image (tags are immutable). Until the owner's first app-root apply (part D), it also pushes the Live relay placeholder (`.../live-placeholder:<commit>`, which answers 503 until stage S7) and stops there; the run summary prints both digests.
2. **migrate** (as `dryscope-migrate-test`): starts the Cloud SQL Auth Proxy (pinned version and checksum, `--auto-iam-authn`, no password) and runs `npm run db:migrate`. Nothing has moved yet if it fails.
3. **deploy** (as `dryscope-deploy-test`): records the revisions serving now, runs `gcloud run deploy dryscope-api-test --image=<digest> --no-traffic --tag=candidate` (only the image changes, so Terraform sees no drift), checks the tagged URL with `web/scripts/smoke-release.ts` (`/api/health` answers `ok`, `test`, this commit and database `ok`, which it reports only after the revision's own Cloud SQL IAM login succeeded, and answers 503 otherwise; signed-out `GET /api/jobs` and `POST /api/companies` answer 401 or 403), moves 100% of traffic to the new revision, and checks the service URL again. If the move or that last check fails, or the job is cancelled during the move, it puts the recorded traffic back.

Until all three repository variables in part C are set, every run ends with a "Test release skipped" notice and changes nothing. Before part D, a run only pushes the first images. A variable that is set but names anything other than the test pool or the test accounts fails the run. **To pause test releases**, delete `DRYSCOPE_TEST_WIF_PROVIDER` (`gh variable delete DRYSCOPE_TEST_WIF_PROVIDER`). **To roll back by hand:** `gcloud run services update-traffic dryscope-api-test --to-revisions=<earlier revision>=100 --region=us-central1 --project=dryscope`. Live has no release workflow yet.

The owner runs parts A to D once, in order, from the repository root on a machine with `gcloud`, `gh`, `terraform`, `node`, `psql` and the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy); no Docker is needed. Agents never run them. Steps 1 to 4 of [Apply the central Terraform](#apply-the-central-terraform) come first.

**A. Workload identity pool and provider for test (step 9).** The provider accepts only this repository (`nnorman100/adr-field-estimator`, id `1413863528`, owner id `201970234`), the `master` branch and the `test` GitHub environment:

```bash
gcloud iam workload-identity-pools create dryscope-test --project=dryscope --location=global \
  --display-name="DryScope test GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github --project=dryscope --location=global \
  --workload-identity-pool=dryscope-test --display-name="adr-field-estimator master, test" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository_id == '1413863528' && assertion.repository_owner_id == '201970234' && assertion.ref == 'refs/heads/master' && assertion.environment == 'test'"
```

Then bind that repository's principal set to the deploy account and the migrator through the data root. Pass the same `-var` on every later plan of the test data root; leaving it out would plan to remove both bindings, which the plan check refuses.

```bash
cd infra/dryscope/data
terraform init -reconfigure -backend-config=envs/backend-test.hcl
terraform plan -var-file=envs/test.tfvars -out=test.tfplan \
  -var workload_identity_principal_set=principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-test/attribute.repository_id/1413863528
terraform show -json test.tfplan > test.json && node ../scripts/check-plan.js data test test.json
terraform apply test.tfplan
cd ../../..
```

The plan should show two creates and nothing else: `google_service_account_iam_member.deploy_workload_identity[0]` and `google_service_account_iam_member.migrate_workload_identity[0]`, each `roles/iam.workloadIdentityUser` for that principal set.

**B. Database bootstrap (step 5).** Set a password for the built-in `postgres` user (typed at the prompt; never stored in git, chat or Terraform), start the proxy as yourself in a second terminal, and grant the migrator only what migrations need:

```bash
gcloud sql users set-password postgres --instance=dryscope-test-pg --project=dryscope --prompt-for-password
gcloud auth application-default login            # the proxy uses your own credentials
cloud-sql-proxy --port=5433 dryscope:us-central1:dryscope-test-pg   # second terminal; stop it afterwards
psql "host=127.0.0.1 port=5433 user=postgres dbname=dryscope"
```

```sql
ALTER ROLE "dryscope-migrate-test@dryscope.iam" CREATEROLE;
GRANT CREATE ON DATABASE dryscope TO "dryscope-migrate-test@dryscope.iam";
GRANT USAGE, CREATE ON SCHEMA public TO "dryscope-migrate-test@dryscope.iam";
```

Never grant the migrator `cloudsqlsuperuser` or `BYPASSRLS`. The first release's migrate job then applies `web/migrations` as the migrator.

**C. GitHub environment and variables.** Create the `test` environment, limited to `master`, set the three variables, then start a run. With the app root not yet applied, that run only pushes the first two images and prints their digests in its summary.

```bash
gh api -X PUT repos/nnorman100/adr-field-estimator/environments/test --input - <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
gh api -X POST repos/nnorman100/adr-field-estimator/environments/test/deployment-branch-policies -f name=master -f type=branch
gh variable set DRYSCOPE_TEST_WIF_PROVIDER --body projects/570228742694/locations/global/workloadIdentityPools/dryscope-test/providers/github
gh variable set DRYSCOPE_TEST_DEPLOY_SA --body dryscope-deploy-test@dryscope.iam.gserviceaccount.com
gh variable set DRYSCOPE_TEST_MIGRATE_SA --body dryscope-migrate-test@dryscope.iam.gserviceaccount.com
gh workflow run web-release.yml --ref master
```

**D. The app root (step 6).** Copy the two references from that run's summary (`api_image` and `live_image`, each ending in `@sha256:<64 hex>`), apply the app root with them, then start a run again; this one releases.

```bash
API_IMAGE='us-central1-docker.pkg.dev/dryscope/dryscope-test/web@sha256:<from the run summary>'
LIVE_IMAGE='us-central1-docker.pkg.dev/dryscope/dryscope-test/live-placeholder@sha256:<from the run summary>'
cd infra/dryscope/app
terraform init -reconfigure -backend-config=envs/backend-test.hcl
export TF_VAR_alert_email='<alert address>'      # never in git
terraform plan -var-file=envs/test.tfvars -var api_image="$API_IMAGE" -var live_image="$LIVE_IMAGE" -out=test.tfplan
terraform show -json test.tfplan > test.json && node ../scripts/check-plan.js app test test.json
terraform apply test.tfplan
cd ../../..
gh workflow run web-release.yml --ref master
```

The apply waits for both services to become ready, which needs a version in every `dryscope-test-*` secret (step 4). `dryscope-live-test` answers 503 until stage S7 ships the real relay. Check: `curl -s "$(gcloud run services describe dryscope-api-test --region=us-central1 --project=dryscope --format='value(status.url)')/api/health"` prints `{"status":"ok","env":"test","commit":"<COMMIT>","database":"ok"}`.

To build an image by hand instead (Linux or macOS, no Docker): `web/scripts/install-crane.sh ~/.local/bin`, `npm ci` in `web/`, `gcloud auth print-access-token | crane auth login us-central1-docker.pkg.dev -u oauth2accesstoken --password-stdin`, then `web/scripts/build-image.sh web --commit "$(git rev-parse HEAD)" --tag us-central1-docker.pkg.dev/dryscope/dryscope-test/web:$(git rev-parse HEAD)` and `crane digest` that tag. On macOS set `TAR=gtar` (GNU tar). The CI-built images are preferred: the standalone output then comes from the same Linux build as every release.

After the first release passes, rerun the part D plan with the same variables: it must report no changes, which shows the release changed only what Terraform ignores (image and traffic).

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
