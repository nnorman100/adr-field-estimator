# Status: Central Terraform

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Central Terraform (test and live: Cloud SQL, named Firestore, evidence bucket, secrets, Cloud Run, alerts, sign-in APIs and the per-tenant sign-in user role) | yes (`infra/dryscope/`, mocked `terraform test` suites, closed-set plan check) | no (live not applied; the test copy is applied; owner reviews and applies per `docs/runbook/terraform-apply.md`) | n/a | New resources only, in dedicated project `dryscope` (`us-central1`), deletion protection on. The test copy has been applied and is releasing (`docs/plans/S8.md`, section 2, evidence of 2026-11-16); nothing is applied for live. CI does not run the Terraform checks yet (workflow files are owner-protected) |
| Scheduled access-records pass and field rules release to test | yes (#315) | no (test only, owner applies) | n/a | Cloud Scheduler job with a role-less service account |
| Plan check accepts re-applies, real S7-2 plans and Model Armor no-ops | yes (#335, #363, #398) | n/a | n/a | |
