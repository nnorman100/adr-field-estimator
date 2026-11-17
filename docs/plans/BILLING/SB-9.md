# Billing plan, step SB-9

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-9 Read-only at the route boundary and the AI boundary (L, High: every write route).** Slice: server.
- BE: the identity carries `billingAccess`. `memberRoute` and `accountRoute` refuse non-`GET` requests of a read-only company with 403 `billing_read_only`, except routes that declare themselves allowed (the list in section 4.8). `linkRoute` passes only a token, so the signing and document link services refuse a signature after they have found the link's company. The AI boundary refuses with the same code before reserving. `GET /api/me` adds `billing: { access, reason }`. The Live relay's admission route (S7, `relayRoute`, not built yet) makes the same refusal when it is built; this step adds the shared check it will call and a guard that fails when a relay route exists without it.
- Docs: `docs/access/billing.md` (the allowed list, with a reason for each entry).
- Tests: a guard test walks the generated route list and fails when a non-`GET` member, account or link handler is neither refused in read-only nor on the written list; for a read-only company every `GET` in the isolation matrix still answers as before; create job, save customer, upload photo, submit, sign, create a signing link, invite a member, accept an invitation and every AI route are refused; each link handler has its own test (a signature refused, a document opened); the allowed routes work; a `manual` or `full` company is unchanged (the whole existing suite still passes).
- Needs: SB-1, SB-5. B12.
