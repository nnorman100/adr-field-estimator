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
- Destroy anything. Cloud SQL, the Firestore database, the bucket, secrets, the image repository and Cloud Run services all set native deletion protection (or `deletion_policy = "ABANDON"`) and `prevent_destroy`. There is no variable to switch protection off.
- Hold a secret. Secrets are created empty, by name. No password user exists; the database is reached with IAM database authentication.
- Replace existing IAM. Only additive `*_iam_member` resources, from a short list of roles.

## Checks

```
TERRAFORM=/path/to/terraform infra/dryscope/scripts/check.sh      # format, validate, mocked tests
python -m pytest tests/test_infra_terraform.py -q -p no:cacheprovider   # static guard, no Terraform needed
```

`terraform test` runs with mock providers and `command = plan`; it needs no credentials. The check script never plans against, applies to, or imports from the real project. CI does not run `check.sh` yet: adding Terraform to a workflow is a protected-path change for the owner.

## Open owner decisions

Private IP for Cloud SQL (needs a VPC), HA versus zonal for live, the public front door (load balancer and Cloud Armor) which sets Cloud Run ingress, evidence retention and any lock, Workload Identity pool for keyless deploys, the billing account for the budget alert, and Cloud Tasks, Model Armor and Identity Platform tenants (not in this change).
