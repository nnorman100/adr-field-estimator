# S6 plan, correction, 2026-11-17: S8 go-live plan (S8.md), owner-approved

Part of [the S6 plan](../S6.md), section 12.

The S8 plan ([S8.md](../S8.md)) was approved on 2026-11-17. For S6: (1) section 1's "If the new app ever takes over the old origin (S8's choice)": S8's choice is that it never does; the new app lives only at its own domain and the old app's project is deleted. The coexistence test `web/tests/e2e/offline/old-worker.spec.ts` is retired with the old files in S8-23b, behind the owner's Test guard label. (2) O8: the live scheduled job (the repair pass) is S8-10.
