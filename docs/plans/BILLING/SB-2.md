# Billing plan, step SB-2

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-2 The Stripe boundary and its stand-in (M, High: money path, a new dependency).** Slice: server.
- BE: `web/src/lib/billing/stripe-port.ts`, one interface with exactly the calls this plan uses (create customer, create Checkout Session, create portal session, read a customer's subscriptions, read prices by lookup key, read meters, send a meter event, read a meter's totals). A real adapter and an in-memory stand-in that records calls and can be told to fail, time out or answer late. Every write carries an idempotency key built from DryScope ids. The API version is pinned in one place. `STRIPE_SECRET_KEY` becomes `reader: 'web'`; the key is a **restricted** key (Stripe: "use restricted API keys ... for most use cases"). When the key is absent every billing route answers 404, so the code can merge before any secret exists.
- Docs: `docs/SECURITY.md` (the key's permissions, listed); the dependency's reason and check in the pull request (B3).
- Tests: a guard test fails when any file outside the adapter imports the Stripe package or names `api.stripe.com`; the stand-in and the adapter pass one shared contract suite (the adapter against recorded, scrubbed responses); a write without an idempotency key fails a test; the settings test reads the key; no test opens a network connection.
- Needs: B3. Can start on approval.
