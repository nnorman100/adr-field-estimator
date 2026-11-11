# Release the rebuilt app to test

`.github/workflows/web-release.yml` releases `web/` to the **test** environment only, after the Web app workflow passes on `master` (or by hand: `gh workflow run web-release.yml --ref master`). Every job runs on the switchable CI runner ([CI runners](ci.md#ci-runners)) and needs only Google APIs over HTTPS from it: no job connects to Cloud SQL from the runner (the build server cannot reach the test instance's address; migrations run in a Cloud Run job inside Google). The runner has no Docker daemon, so images are assembled without Docker: `web/scripts/build-image.sh` builds the Next.js standalone output with npm and appends it as one root-owned `/app` layer onto the base image pinned in `web/Dockerfile`, with [crane](https://github.com/google/go-containerregistry) (`web/scripts/install-crane.sh`, pinned by version and checksum). One release runs at a time:

1. **build** (as `dryscope-deploy-test`): pushes `us-central1-docker.pkg.dev/dryscope/dryscope-test/web:<commit>` with the commit baked in (the image also carries the migrator, `/app/migrate.mjs`, and the ledger, `/app/migrations`), then uses it by digest. A rerun of the same commit reuses the pushed image (tags are immutable). Until the owner's first app-root apply (part D), it also pushes the Live relay placeholder (`.../live-placeholder:<commit>`, which answers 503 until stage S7) and stops there; the run summary prints both digests.
2. **migrate** (as `dryscope-deploy-test`): sets the release image, by digest, on the Cloud Run job `dryscope-migrate-test` with `gcloud run jobs update --image=<digest>` (only the image changes), checks that the job still runs as `dryscope-migrate-test` with that image, then runs it with `gcloud run jobs execute --wait`. The job runs `node migrate.mjs` as `dryscope-migrate-test` over Cloud Run's built-in Cloud SQL connection with IAM login (no password, no secret), one task, no retries, ten-minute limit. A failed execution fails the release; nothing has moved yet. Its log is the execution's log in the Cloud Run console (the deploy account cannot read logs).
3. **deploy** (as `dryscope-deploy-test`): first releases the field database's browser rules, `web/firestore.rules`, to `dryscope-field-test` with `web/scripts/release-rules.ts` through the Firebase Rules API (role `dryscopeRulesReleaseTest`, [field rules release role](terraform-apply.md#field-rules-release-role)): it reads release `cloud.firestore/dryscope-field-test` and its ruleset, and when they already hold the committed file it creates nothing and prints `unchanged`; otherwise it creates a ruleset from the file (a rules error refuses it and changes nothing), points the release at it (creating the release the first time), reads both back and fails unless they hold exactly the file. A failure there stops the release before any revision or traffic changes. The Web app workflow ran the emulator rules tests on the same commit before this run started. Rules take a few minutes to reach every client. It then records the revisions serving now, runs `gcloud run deploy dryscope-api-test --image=<digest> --no-traffic --tag=candidate` (only the image changes, so Terraform sees no drift), checks the tagged URL with `web/scripts/smoke-release.ts` (`/api/health` answers `ok`, `test`, this commit and database `ok`, which it reports only after the revision's own Cloud SQL IAM login succeeded, and answers 503 otherwise; signed-out `GET /api/jobs` and `POST /api/companies` answer 401 or 403), moves 100% of traffic to the new revision, and checks the service URL again. If the move or that last check fails, or the job is cancelled during the move, it puts the recorded traffic back.

Until all three repository variables in part C are set, every run ends with a "Test release skipped" notice and changes nothing. Before part D, a run only pushes the first images. `DRYSCOPE_TEST_MIGRATE_SA` names the account the migration job must run as; the workflow no longer signs in as it. A variable that is set but names anything other than the test pool or the test accounts fails the run. **To pause test releases**, delete `DRYSCOPE_TEST_WIF_PROVIDER` (`gh variable delete DRYSCOPE_TEST_WIF_PROVIDER`). **To roll back by hand:** `gcloud run services update-traffic dryscope-api-test --to-revisions=<earlier revision>=100 --region=us-central1 --project=dryscope`. Live has no release workflow yet.

The owner runs parts A to D once, in order, from the repository root on a machine with `gcloud`, `gh`, `terraform`, `node`, `psql` and the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy) (part B only; [Cloud Shell](https://cloud.google.com/shell) has all of them and reaches the instance from inside Google); no Docker is needed. **First-run order:** the part B grants must be in place before the migration job first executes, which is the first release after part D; a release before part B fails at migrate, before any traffic moves, and is rerun after part B. Agents never run them. Steps 1 to 4 of [Apply the central Terraform](terraform-apply.md#apply-the-central-terraform) come first.

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

The plan should show the two workload identity creates, `google_service_account_iam_member.deploy_workload_identity[0]` and `google_service_account_iam_member.migrate_workload_identity[0]`, each `roles/iam.workloadIdentityUser` for that principal set, plus `google_service_account_iam_member.deploy_acts_as["migrate"]` (`roles/iam.serviceAccountUser` on `dryscope-migrate-test` for the deploy account, so it can set the migration job's image) if the data root was applied before that grant existed, and, if it was applied before the rules release and the scheduler account existed, `google_project_iam_custom_role.rules_release[0]` (`dryscopeRulesReleaseTest`), `google_project_iam_member.deploy_rules_release[0]` (that role for the deploy account, no condition), `google_service_account.scheduler[0]` (`dryscope-scheduler-test`, no role) and `google_project_service.apis["cloudscheduler.googleapis.com"]`; nothing else. Re-apply the data root this way before the first release after part D, or the migrate job fails at `gcloud run jobs update` and the deploy job fails at the rules step with a 403.

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

Never grant the migrator `cloudsqlsuperuser` or `BYPASSRLS`. The first release's migrate job then applies `web/migrations` as the migrator, from the Cloud Run job. Part B needs a direct connection to the instance as the owner: run it from Cloud Shell or any machine that reaches it (the build server does not).

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

**D. The app root (step 6).** Copy the two references from that run's summary (`api_image` and `live_image`, each ending in `@sha256:<64 hex>`), apply the app root with them, then start a run again; this one releases. The apply also creates the migration job `dryscope-migrate-test` from the `api_image` digest, its `dryscopeMigrateJobTest` role and the deploy account's grant on it. It also creates the Cloud Scheduler job `dryscope-access-projection-test`, which calls the web app's access-projection route every five minutes as `dryscope-scheduler-test` ([scheduled job calls](terraform-apply.md#scheduled-job-calls)); the data root must have created that account and enabled the Cloud Scheduler API first. The scheduler account, the scheduler job and the rules release role are test only for now: a live apply creates none of them, and the live wiring comes in a later step. If the app root is already applied, the same plan shows exactly those creates (the three migration-job resources if they are new, and the scheduler job) and nothing else. Parts A (including `deploy_acts_as["migrate"]`) and B must be done before that run.

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

The apply waits for both services to become ready, which needs a version in every `dryscope-test-*` secret (step 4). Creating the job runs nothing. `dryscope-live-test` answers 503 until stage S7 ships the real relay. Check: `curl -s "$(gcloud run services describe dryscope-api-test --region=us-central1 --project=dryscope --format='value(status.url)')/api/health"` prints `{"status":"ok","env":"test","commit":"<COMMIT>","database":"ok"}`.

To build an image by hand instead (Linux or macOS, no Docker): `web/scripts/install-crane.sh ~/.local/bin`, `npm ci` in `web/`, `gcloud auth print-access-token | crane auth login us-central1-docker.pkg.dev -u oauth2accesstoken --password-stdin`, then `web/scripts/build-image.sh web --commit "$(git rev-parse HEAD)" --tag us-central1-docker.pkg.dev/dryscope/dryscope-test/web:$(git rev-parse HEAD)` and `crane digest` that tag. On macOS set `TAR=gtar` (GNU tar). The CI-built images are preferred: the standalone output then comes from the same Linux build as every release.

After the first release passes, rerun the part D plan with the same variables: it must report no changes, which shows the release changed only what Terraform ignores (the services' and the job's image, and traffic). To rerun only the migrations (for example after part B): `gcloud run jobs execute dryscope-migrate-test --region=us-central1 --project=dryscope --wait`; it applies nothing when the ledger is current.
