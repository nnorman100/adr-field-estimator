# DryScope Terraform

Infrastructure for the rebuilt DryScope in project `alert-disaster-field-2026`, region `us-central1`. Written and checked offline. **Nothing here has been applied.** The owner reviews and applies it (steps in [docs/RUNBOOK.md](../../docs/RUNBOOK.md#apply-the-central-terraform)).

```
infra/dryscope/
  modules/naming   one place for every name, account and secret-to-service rule
  data/            Cloud SQL, named Firestore database, evidence bucket, secrets,
                   image repository, runtime and deploy accounts and their grants
  app/             Cloud Run (web app, Live relay), alerts, uptime check, budget stub
  scripts/check.sh offline checks (format, validate, mocked tests)
```

Each root has `envs/test.tfvars`, `envs/live.tfvars` and a matching `envs/backend-<env>.hcl`, so test and live never share state. Apply `data` before `app`; the app root derives data names from the shared naming module and does not read the data root's state.

## What it will not do

- Touch anything in `us-west2`: the legacy Cloud Run service, the `(default)` Firestore database, the old evidence bucket, `adr-runtime` and `adr-builder`, or other apps in the project. The roots refuse any other project or region at plan time.
- Destroy anything through Terraform. Cloud SQL, the Firestore database, the bucket, secrets, the image repository and Cloud Run services all set `prevent_destroy`, and SQL databases, SQL users and Firestore set `deletion_policy = "ABANDON"`. There is no variable to switch protection off. Only Cloud SQL (`deletion_protection_enabled`) and Firestore (`delete_protection_state`) also carry Google-side protection; Cloud Run's `deletion_protection` and every `prevent_destroy` stop Terraform only, not a direct API delete. Against that, no account created here can delete a Cloud Run service or revision: the deploy account holds the custom role `dryscopeDeploy<Env>` (Cloud Run reads plus `run.services.update`, no delete) instead of `roles/run.developer`, and the evidence roles carry no object delete.
- Hold a secret. Secrets are created empty, by name. No password user exists; the database is reached with IAM database authentication.
- Replace existing IAM. Only additive `*_iam_member` resources, from a short list of roles.

## Checks

```
TERRAFORM=/path/to/terraform infra/dryscope/scripts/check.sh      # format, validate, mocked tests
```

`terraform test` runs with mock providers and `command = plan`; it needs no credentials. The suites in `data/tests` and `app/tests` assert region, environment-scoped names, protection settings, IAM-only database users, the reviewed role on every grant, the deploy role's lack of delete permissions, invocation-only public access, and that the legacy project, region, accounts, database, bucket and service are refused or never managed. The check script never plans against, applies to, or imports from the real project. CI does not run `check.sh` yet: adding Terraform to a workflow is a protected-path change for the owner.

## Open owner decisions

Private IP for Cloud SQL (needs a VPC), HA versus zonal for live, the public front door (load balancer and Cloud Armor) which sets Cloud Run ingress, evidence retention and any lock, Workload Identity pool for keyless deploys, the billing account for the budget alert, and Cloud Tasks, Model Armor and Identity Platform tenants (not in this change).
