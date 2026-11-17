# S6 plan correction: 2026-11-17: billing plan (BILLING.md), owner-approved

Part of [the S6 plan](../S6.md), section 12, "Corrections".

The billing plan ([BILLING.md](../BILLING.md)) was approved on 2026-11-17. For section 3 (the sync gate) and S6-5: the sync gate gains a read-only verdict. Unsent work is kept and not sent, as for the lock codes, and is sent when `/api/me` says the company has full access again; the photo queue treats `billing_read_only` as waiting, never as a refusal that drops the photo (billing SB-13).
