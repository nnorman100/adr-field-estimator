# Status: Central Terraform

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Central Terraform (test and live: Cloud SQL, named Firestore, evidence bucket, secrets, Cloud Run, alerts, sign-in APIs and the per-tenant sign-in user role) | yes (`infra/dryscope/`, mocked `terraform test` suites, closed-set plan check) | no (not applied; owner reviews and applies per `docs/runbook/terraform-apply.md`) | n/a | New resources only, in dedicated project `dryscope` (`us-central1`), deletion protection on. No plan or apply has been run against the project. CI does not run the Terraform checks yet (workflow files are owner-protected) |
