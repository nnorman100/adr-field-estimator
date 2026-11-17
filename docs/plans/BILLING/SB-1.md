# Billing plan, step SB-1

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-1 Billing tables (M, High: company separation, a database job).** Slice: database.
- DB: one migration. `company_billing` (one row per company: mode, Stripe customer and subscription ids each unique, Stripe status, access, access reason, override, last synced time). `billing_periods` (company, the period's start and end, the dated copy of prices and allowance; one row per company and period, never changed once written). `billing_alerts` (code, company, time, cleared by). `billing_events` (Stripe's event id as the key, type, Stripe customer id, the company once known, received, processed, attempts, next try, last error code). A lookup function `billing_company_for_customer(text)` owned like `sign_in_company` (migration 0004), which answers one company id for one customer id and nothing else. Row-level security forced on every billing table; the runtime reads and writes a company's row only in that company's context; the operator's policies as in migration 0006. A backfill gives every existing company a `manual`, `full` row; a trigger gives every new company one.
- Docs: `docs/DATA.md` (what billing data is held: ids and states, no card data).
- Tests: the row-security guard and the catalog isolation suite find every billing table; company A cannot read or change company B's row; the same Stripe customer id cannot be stored for two companies; the lookup function answers nothing for an unknown id; every existing and new company has a row; the typed schema matches the migration.
- Needs: nothing. Can start on approval.
