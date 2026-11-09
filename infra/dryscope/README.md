# DryScope Terraform

Infrastructure for the rebuilt DryScope in dedicated project `dryscope` (project number `570228742694`), region `us-central1`. Written and checked offline. **Nothing here has been applied.** The owner reviews and applies it (steps in [docs/RUNBOOK.md](../../docs/RUNBOOK.md#apply-the-central-terraform)).

```
infra/dryscope/
  modules/naming   one place for every name, account and secret-to-service rule
  data/            Cloud SQL, named Firestore database, evidence bucket, secrets,
                   image repository, runtime and deploy accounts and their grants
  app/             Cloud Run (web app, Live relay), alerts, uptime check, budget stub
  scripts/check.sh offline checks (format, validate, mocked tests)
```

Each root has `envs/test.tfvars`, `envs/live.tfvars` and a matching `envs/backend-<env>.hcl` (bucket `dryscope-tfstate`), so test and live never share state. Apply `data` before `app`; the app root derives data names from the shared naming module and does not read the data root's state. Test uses the shared-core `db-f1-micro` Cloud SQL tier (`ENTERPRISE` edition, zonal, 10 GB SSD — about $10/month; no uptime guarantee, fine for test), while live keeps the dedicated `db-custom-1-3840` tier (1 vCPU, 3.75 GiB, `ENTERPRISE` edition, zonal, 20 GB SSD).

## What it will not do

- Touch the legacy `alert-disaster-field-2026` project or anything in `us-west2`: the legacy Cloud Run service, the `(default)` Firestore database, the old `alert-disaster-field-2026-evidence` bucket, or `adr-runtime` and `adr-builder`. The legacy app keeps serving unchanged until cutover; these roots refuse any project other than `dryscope` and any region other than `us-central1` at plan time.
- Destroy anything through Terraform. Cloud SQL, the Firestore database, the bucket, secrets, the image repository and Cloud Run services all set `prevent_destroy`, and SQL databases, SQL users and Firestore set `deletion_policy = "ABANDON"`. There is no variable to switch protection off. Only Cloud SQL (`deletion_protection_enabled`) and Firestore (`delete_protection_state`) also carry Google-side protection; Cloud Run's `deletion_protection` and every `prevent_destroy` stop Terraform only, not a direct API delete. Against that, no account created here can delete a Cloud Run service or revision: the deploy account holds the custom role `dryscopeDeploy<Env>` (Cloud Run reads plus `run.services.update`, no delete) instead of `roles/run.developer`, and the evidence roles carry no object delete.
- Hold a secret. Secrets are created empty, by name. No password user exists; the database is reached with IAM database authentication.
- Replace existing IAM. Only additive `*_iam_member` resources, from a short list of roles.

## Checks

```
TERRAFORM=/path/to/terraform infra/dryscope/scripts/check.sh      # format, validate, mocked tests, plan check
npx vitest run tests/test_terraform_plan_check.js                  # the plan check itself, on fixtures
```

`terraform test` runs with mock providers, mostly `command = plan` and, for the destroy-guard check only, a mocked apply; it needs no credentials. The suites in `data/tests` and `app/tests` assert region, environment-scoped names, protection settings, IAM-only database users, the reviewed role on every grant, the deploy role's lack of delete permissions, invocation-only public access, and that the legacy project, region, accounts, database, bucket and service are refused or never managed. `scripts/check-plan.js` reads the whole mocked plan of each root and environment and requires every resource (its project and name), every IAM grant (role, member and exact condition) and every protection setting to match a fixed table, so a grant nobody listed, a resource pointed at another environment, a wider condition, a shared-core tier in live (or the wrong tier for the environment) or a delete or replacement fails even though no test names it. The owner runs the same script on the saved plan before an apply (RUNBOOK). `prevent_destroy` is not in plan JSON, so `guards/guards.tftest.hcl` covers it: it applies each root against the mock provider and `scripts/check-guards.js` requires Terraform's own teardown to refuse to destroy every protected resource (SQL instance, Firestore database, bucket, repository, the four secrets, both Cloud Run services). The same file also plans a different image digest after the mocked create and requires the planned image to stay put, which covers the `ignore_changes` that leaves releases to `gcloud`. Removing or falsifying a guard, or that `ignore_changes`, fails `check.sh`; the refusal of every delete action in the plan check stands behind both. The check script never plans against, applies to, or imports from the real project. CI does not run `check.sh` yet: adding Terraform to a workflow is a protected-path change for the owner.

## Accepted risks

- **The deploy account is as powerful as the runtime it deploys.** It may act as the web app and relay accounts and update their services, so any code it ships runs with that environment's data and secrets. GitHub environment protection, the principal set's repository scope and a separate workload identity pool per environment (`dryscope-test`, `dryscope-live`; the variable refuses any other pool) are the real controls; it must never be given `iam.roles.update` on its own custom role.
- **Runtime accounts can delete rows and documents in their own environment** (`roles/datastore.user`, SQL grants). Point-in-time recovery on both stores is the backstop.
- **Gemini calls need a project-level role.** Vertex AI cannot be scoped to one environment; the custom role holds `aiplatform.endpoints.predict` only.

## Open owner decisions

Private IP for Cloud SQL (needs a VPC), HA versus zonal for live, the public front door (load balancer and Cloud Armor), which will reintroduce a Cloud Run ingress setting when the owner decides (until then both services take all traffic, `INGRESS_TRAFFIC_ALL`), evidence retention and any lock, creating the per-environment Workload Identity pools for keyless deploys, the billing account for the budget alert, and Cloud Tasks, Model Armor and Identity Platform tenants (not in this change).
