# Status: S8 go-live

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

Plan: `docs/plans/S8.md` (#425); billing plan `docs/plans/BILLING.md` (#428). No live project exists yet (D-018).

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Lawyer checklist as the working list, checked against product rules 4C (S8-1) | yes (#446) | n/a | n/a | |
| Database pools fitted to a per-environment connection budget (S8-2) | yes (#429) | no (rebuild not live) | n/a | |
| Time limits on app database connections | yes (#456) | no (rebuild not live) | n/a | |
| Operator records check after a restore (S8-3) | yes (#451) | no (rebuild not live) | n/a | Read only |
| Owner-run restore and rollback drill kit (S8-5) | yes (#459) | no (owner runs it) | n/a | |
| Load test kit with pass marks (S8-7) | yes (#457) | no (owner runs it in S8-22) | n/a | |
| Keyless sign-in guards accept only a pool in this project (security F8) | yes (#464) | no (owner applies) | n/a | |
| Cloud SQL backups kept after deletion and a Google Cloud incident alert | yes (#468) | no (owner applies) | n/a | |
