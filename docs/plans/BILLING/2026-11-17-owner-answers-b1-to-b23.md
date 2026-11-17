# Billing plan, correction, 2026-11-17: owner answers B1 to B23 and the citation check

Part of [the billing plan](../BILLING.md), section 15.

The owner approved the plan on 2026-11-17 and chose the recommended answer for every question B1 to B23 (section 8). An independent check of the plan's citations ran the same day. It found all 66 Stripe quotes and all 7 Google quotes exact, on the pages the plan names. Its corrections are folded into the plan as committed. Changes from the scouting draft:

- **B2 (Meters, not Metronome).** The quote now reads in full: the Meters API "remains fully supported for existing integrations", and Stripe's page says "Unless you're maintaining an existing Meters integration, use Metronome". The decision stays A. The reason no longer says DryScope is "far from the cases Stripe lists"; it says the choice goes against Stripe's guidance for new integrations and the owner accepts that for the sake of Checkout. Owner step B now includes asking Stripe support whether new Meters integrations have an end date, before SB-18 is built.
- **B4 (who may use a Stripe sandbox).** The anonymous sandbox needs an email address, lasts 7 days, and may not be able to change the Dashboard-only settings the proof needs. The decision is A with the address named by the owner (owner step B); if the sandbox cannot change those settings, items (c) and (f) fall back to the owner running the script (B) or to an extra owner sandbox with a restricted key for the SB-0 worker (C).
- **B10 (months spent read-only).** Stripe cannot delete or void a subscription's draft invoice, so the operator finalizes and then voids each monthly draft (section 4.7, the risk table and B10). Stripe offers a fourth outcome when retries end, pausing the subscription, which makes no invoice for a read-only month. The decision is A, to be confirmed by SB-0, which now proves both A and pausing (item (c)). Section 1, item 6 now lists all four outcomes. Moving to pausing after the proof is a new owner decision.
- **Six text fixes** (the citation check's M1 to M6):
  1. The Checkout Session carries `customer_update[address]=auto`, and `customer_update[name]=auto` with tax id collection, because the customer DryScope created has no saved address (section 4.3, SB-0 (b), SB-7's tests, B16).
  2. Only prices have lookup keys; meters are found by their event names (section 4.1, SB-6, owner step C).
  3. `checkout.session.completed` is cited from Stripe's event catalog; the other thirteen events are on the subscription webhooks page (section 13).
  4. The quote about tax behaviour now uses Stripe's own words (section 4.10).
  5. An export is removed from the live bucket by a rule at about 7 days, and recoverable copies remain until soft-delete and version retention end; the download route refuses an expired export (section 9, the risk table).
  6. The webhook route, not the sync route, answers `invoice.created` (section 4.6).
- **Seven behaviours no Stripe page states** (the citation check's N1 to N7) are listed in section 13 as plan follow-ups for SB-0 to prove or settle. SB-0 gains item (l), usage events under a simulated clock, run first because the test-copy proof and the phone check rest on it, and item (m), whether a replacement meter can reuse an event name.
- **Section 10** became the record of the corrections made to earlier plans and documents in the same pull request. Two rows wait for their steps: `docs/runbook/ai-allowance.md` changes with SB-17 and the project profile's Standard version with SB-25, because both describe what the app does today.
- **The steps** moved to one file each under this folder, as the S5, S6 and S8 plans do. No step changed its scope, its order or its risk rating.
