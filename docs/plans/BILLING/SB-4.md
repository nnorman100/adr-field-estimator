# Billing plan, step SB-4

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-4 The webhook route (M, High: a public route that changes access).** Slice: server.
- BE: `POST /api/stripe/webhook` with a new route rule, `webhook`, and its wrapper. Raw body, capped at the size SB-0 measured with headroom; signature check as section 4.4 (two active secrets accepted, for Stripe's secret roll); a `livemode` check; one insert into `billing_events`; 200. No other work. The path joins the proxy's lists under its own heading.
- Docs: `docs/access/non-role-access.md` (who may call it and why it is public).
- Tests, with signed fixtures made in the test: a valid event is stored once and answered 200; the same event twice stores one row; a wrong signature, a missing header, a stale timestamp (over 5 minutes), a body changed by one byte, a body over the cap and a `livemode` mismatch are each refused and store nothing; a header with two `v1` values passes when either matches; unknown header entries are ignored; the route-rules test knows the new rule and refuses any second route that uses it; the log line holds the event id and type only.
- Needs: SB-1, SB-2.
