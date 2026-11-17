# Billing plan, step SB-6

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-6 Operator billing API and the catalog check (M, High).** Slice: server.
- BE: `GET` and `PUT /api/platform/companies/{companyId}/billing` (`operatorRoute`, fresh sign-in for the write): read the state; switch `manual` to `stripe` (catalog check, then create the customer once; a customer id already stored is always reused, because Stripe forgets idempotency keys after a day); switch back to `manual`, refused while the customer has a live subscription; set or clear "keep full access until" (B17) and operator read-only. The catalog check reads the four prices by lookup key and the three meters by event name and refuses with a named reason when one is missing, not monthly, not metered where it should be, not a last-value meter, without a tax behaviour, or without the allowance numbers.
- Docs: `docs/access/superadmin.md`; the isolation matrix rows.
- Tests: a non-operator is refused; two "switch to Stripe" calls create one customer, also when they are a week apart; a switch back to `manual` with a live subscription is refused; each catalog fault refuses with its reason and creates nothing; the override is bounded (B17) and audited; every action writes one audit row naming the operator.
- Needs: SB-2, SB-5. B17.
