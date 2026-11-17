# Billing plan, step SB-7

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-7 Owner billing API: state, Checkout and portal (M, High).** Slice: server.
- BE: two new capabilities, `billing_read` and `billing_manage`, owner only, in `web/src/lib/access/roles.ts` and `docs/access/roles.md` (the table grows from 23 keys to 25). `GET /api/billing` (state, next invoice date, read-only reason; syncs this company on load, rate-limited). `POST /api/billing/checkout` and `POST /api/billing/portal` (`billing_manage`, fresh sign-in): each answers with a Stripe address for the signed-in company's own customer. Return addresses are fixed by the server. Checkout is refused when the customer has a live subscription in any state (active, past due, unpaid or waiting for its first payment); an earlier unfinished session is expired before a new one is made.
- Docs: `docs/access/billing.md` (new), linked from `docs/ACCESS.md`.
- Tests: an estimator and an office user are refused; a company in mode `manual` gets no Stripe address; the customer id sent to the stand-in is always the caller's company's, whatever the request holds (a body or query naming another company's customer changes nothing); a second Checkout is refused for a company whose subscription is active, past due, unpaid or incomplete; the session carries `customer_update[address]=auto` (and `customer_update[name]=auto` with tax id collection); two taps make one open session; an old sign-in is asked to sign in again; isolation matrix rows; the capability count test reads 25.
- Needs: SB-5, SB-6.
