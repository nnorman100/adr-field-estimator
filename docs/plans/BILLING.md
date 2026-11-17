# "Billing": stage plan (SB)

Approved plan for the billing stage of the rebuilt app (the TypeScript app in `web/`). Planned 2026-11-17 on `master` at `f7c6d58f`; the owner approved it on 2026-11-17 and chose the recommended answer for every question B1 to B23, so section 8 holds decided answers and no question is open. An independent check of every Stripe and Google quote in sections 13 and 14 found all of them exact; its corrections (the wording of B2, B4 and B10, six text fixes, and seven behaviours Stripe does not document) are folded in, and the correction of 2026-11-17 (section 15) lists them. Reviewers: check each billing pull request against this file and its step file; a step that does more or less than it says needs a note in the pull request or a dated entry under Corrections ([README](README.md)). Sources: the owner's decisions of 2026-11-16 as recorded in the Technology Standard 2.13, Module A (Notion); `docs/plans/README.md`, `S3.md`, `S5.md`, `S6.md`, `S7.md`, `TC.md` and the S8 plan; `docs/ACCESS.md` and `docs/access/`; `docs/AI.md`; `docs/DATA.md`; `docs/data-ownership.md`; the `web/` code and `infra/dryscope/`; Stripe's documentation (section 13); Google's documentation (section 14).

## 1. Summary

- **What the stage delivers.** Each company pays through one Stripe subscription: a company fee, a fee for each person who used the app that month, and charges for AI use above a monthly allowance. The company's owner sets a spending cap; AI pauses for that company when the cap is reached. When a payment fails, Stripe retries for about two weeks while the owner sees a notice. After that the company is read-only: its people can read and download, and cannot create or sign. Nothing is ever deleted for non-payment. A company can export its records and cancel.
- **What the stage does not deliver.** Self sign-up (the platform operator creates each company). Prices (they live in Stripe and the owner sets them after the pilot). Terms and privacy pages (they need the lawyer's text). Deleting a closed company's data (its own plan; an irreversible step that stays with the owner). DryScope's own emails (S9); until then Stripe's own emails and an in-app notice carry the message.
- **Size.** 28 steps, SB-0 to SB-26 and SB-12b. **Four database jobs** (SB-1, SB-11, SB-14, SB-21), one at a time in the database lane. Most steps are **High** risk by the rule in `AGENTS.md` (pricing, sign-in, company separation, secrets, rules, workflows); each pull request states its own rating.
- **Pilot companies are untouched.** Every company starts in billing mode `manual` (invoiced by hand, outside the app). Nothing in this stage changes what a `manual` company can do. A company moves to `stripe` only when the operator switches it and its owner completes Stripe's Checkout page.
- **Card numbers never reach DryScope.** The app holds Stripe's ids for the customer and the subscription, and nothing else about payment. The owner pays on Stripe's hosted page and changes the card in Stripe's portal. No Stripe script runs inside the app.
- **Stripe is the record of what was paid; DryScope is the record of what was used.** DryScope never decides that a payment failed, and Stripe never decides how many minutes were used.
- **The order that matters.** The Stripe boundary and its stand-in for tests, then the billing tables, then the webhook and the sync, then read-only at every layer, then usage and the cap, then export and cancellation, then the proof on the test copy with Stripe's simulated clock, then live.
- **Found while planning.**
  1. A company that is not `active` is refused on every request, so "suspended" cannot serve as read-only (`web/src/lib/auth/identity.ts:138`).
  2. No record says who signed in during a month.
  3. The AI ledger holds Google's cost in micro-dollars; nothing holds minutes or credits.
  4. Only the platform operator can set AI ceilings today; the owner's spending cap is new.
  5. Stripe's duplicate check for usage events is short ("at least 24 hours"), and a finalized invoice never takes late usage. The plan reports running totals to a last-value meter and reads the totals back before the month closes.
  6. The owner must choose what happens when retries end. Stripe offers four outcomes: cancel the subscription, mark it unpaid, leave it past due, or pause it. Cancelling ends the subscription. Leaving it past due never ends the retry state. Unpaid keeps the subscription and drafts an invoice every month. Pausing keeps the subscription and makes no new invoices until the overdue one is paid. This plan uses "mark as unpaid" unless B10 chooses pausing.
  7. Stripe's portal lets a customer cancel by default, and with a subscription like this one (several products, usage-based) a customer "can cancel it in the portal, but can't update it".
  8. Stripe requires the raw request body to check a webhook's signature; no route in `web/` checks a signed body today.
  9. The field database rules use one access record for both reading and editing (`web/firestore.rules:40-63`), so read-only needs a new mark on that record and a rules change.
  10. `docs/ai-spending.md` and `docs/runbook/ai-allowance.md` describe AI limits as operator-only, and the first describes the old app's $10 allowance. Section 10 asks for the corrections.

## 2. What exists today (evidence)

| Fact | Where |
| --- | --- |
| The owner's billing decisions, word for word: "Stripe subscription per company: a company fee, plus a fee per active user (signed in during the billing month), plus AI usage. Each user fee includes a monthly AI allowance; usage above it is billed per extra voice minute or AI credit, priced above Google's cost; the company owner sets a spending cap that pauses AI when reached. Prices live in Stripe and are set after the pilot. Failed payment: Stripe retries for about two weeks with an owner notice, then the company is read-only (can read and download, can't create or sign); data is never deleted for non-payment. Stripe Tax on; taxability confirmed with an accountant. The platform operator creates each company (no self sign-up for now); pilot companies are invoiced manually and in-app billing is its own stage after go-live. The app never handles card numbers (Stripe Checkout and billing portal)." | Technology Standard (Notion), version 2.13, "Module A: multi-company", read 2026-11-17 |
| The Standard also says: "Offboarding: when a subscription ends, 30 days read-only with export, then the company is closed. Export is a zip of CSV/JSON per table plus files." Tier 2 (before the first paying customer) lists "Stripe billing and offboarding (module A)". Secrets: "one secret per purpose"; "Stripe, Resend and the runner's keys are the recorded stored-key exceptions". | Same page: Module A; "Tiers"; "Core: operations and security" |
| A company has one status: `active`, `suspended` or `archived`. There is no read-only state. | `web/migrations/0002_identity.sql:26`, `:36`; `web/src/db/schema.ts:32` |
| Any request from a company that is not `active` is refused with `company_inactive` (403), reads included. The phone treats that code as "locked": it stops syncing and keeps unsent work. | `web/src/lib/auth/identity.ts:138`, `:72`; `web/src/lib/field/sync-gate.ts:403-406` |
| The operator suspends, reactivates and archives a company; archive needs a suspended company; each change queues every member's field access record. | `web/src/lib/platform/service.ts:197-215`; trigger `companies_guard_change`, `web/migrations/0006_platform_operator.sql:149-171` |
| A company is created by the operator (`POST /api/platform/companies`); its sign-in tenant is created by an owner-run command and bound once. | `web/src/lib/platform/service.ts:181-192`, `:241`; `web/scripts/create-tenant.ts` |
| Route wrappers: `publicRoute`, `memberRoute`, `requireFlag`, `accountRoute`, `linkRoute`, `operatorRoute`, `serviceRoute`. The rule kinds are `'public' \| 'member' \| 'account' \| 'service' \| 'link' \| 'operator'`. A test fails when a handler has no rule. | `web/src/lib/auth/route.ts:75`, `:101-146`, `:166`; `web/tests/unit/route-rules.test.ts` |
| The proxy refuses any `/api` path that is not on a list. Public paths today: health, echo, client errors, the sign-in address lookup. | `web/src/proxy.ts:14-27`; `web/src/lib/public-api.ts:3-12` |
| Roles are owner, estimator and office. The capability table has 23 keys; a test reads `docs/access/roles.md` and fails when the table and the document differ ("lists exactly 23 keys"). No key covers billing. | `web/src/lib/access/roles.ts:4-60`; `web/tests/unit/access.test.ts:49-52` |
| `memberships` holds role and status only; no last sign-in or last-seen column exists anywhere. `GET /api/me` runs on every app open and renews the field access record. | `web/migrations/0002_identity.sql:123-139`; `web/src/app/api/me/route.ts:14-28` |
| AI ledger: one row per AI call with `actor_id`, `feature`, `model`, reserved and settled amounts in whole micro-dollars of Google's bill, `utc_day` and `utc_month`. Budgets are per company, per UTC day and UTC month. A reservation runs under a per-company advisory lock. | `web/migrations/0012_ai_live_tables.sql:63-96`; `web/src/lib/ai/budget.ts:99-101`, `:213-251`; `web/src/lib/ai/utc.ts:8-15` |
| Default AI ceilings are $10 a day and $200 a month of Google's cost. Only the operator changes them (`PUT /api/platform/companies/{id}/ai-settings`, fresh sign-in, audited). The owner can read usage (`ai_usage_read`). | `web/src/lib/ai/ceilings.ts:13-16`; `web/src/lib/ai/settings.ts:42-88`; `web/src/lib/access/roles.ts:30` |
| A ceiling refusal answers 429 with `ai_budget` or `ai_quota` and `fieldWorkContinues: true`. | `web/src/lib/ai/budget.ts:158-172`, `:293-300` |
| Voice sessions are stored with start and end times; voice is charged to the ledger in micro-dollars from Google's usage figures. Nothing stores minutes as a billing unit. | `web/src/db/ai-schema.ts:144-220` |
| Google's cost per AI feature (planning figures): live voice about $0.044 a minute; findings summary about $0.01 (from 2027 about $0.02); fill scope about $0.014 (from 2027 about $0.027); meter reading about $0.002; voice notes about $0.005 a minute; job summary under $0.002. | `docs/plans/S7.md:806-813` |
| Feature switches are per company, in `company_feature_flags`, set by the operator. Seven flags exist; six are AI features. No platform-wide AI switch exists in code; the project-level cap is Google's (D-020). | `web/src/lib/flags/known.ts`; `web/migrations/0002_identity.sql:169-176`; `docs/AI.md:143-144` |
| The audit log is `audit_events` (company, actor, operator, action, target, details). The runtime may only read and insert. Each service writes its own rows; there is no shared writer. | `web/migrations/0002_identity.sql:150-165`; `web/migrations/0003_runtime_role.sql:116-126`; `web/migrations/0006_platform_operator.sql:127-133` |
| The scheduled worker: Cloud Scheduler calls `POST /api/internal/access-projection` every 5 minutes with a Google-signed token; the route accepts only the scheduler account and its audience. Rows are claimed under an advisory lock and retried with back-off. It exists in `test` only today (live is S8-10). | `infra/dryscope/app/scheduler.tf:1-35`; `web/src/app/api/internal/access-projection/route.ts:7-12`; `web/src/lib/projection/outbox.ts:173-238` |
| Field database rules: one `member()` check reads the company and the caller's access record; `canRead` and `canEdit` both use it. A record works until `expiresAt`. | `web/firestore.rules:40-63` |
| `STRIPE_SECRET_KEY` is declared with `reader: 'planned'`; the secret `stripe-secret-key` is in the naming module and the plan check, readable by the web app only. Terraform declares no secret values: the owner adds them by hand. | `web/src/lib/settings-contract.ts:52`; `infra/dryscope/modules/naming/main.tf:35-40`; `infra/dryscope/scripts/check-plan.js:77-82`; `infra/dryscope/data/secrets.tf`; `docs/runbook/terraform-apply.md:37` |
| No `stripe` package, no webhook route, and no HMAC or constant-time comparison anywhere in `web/src`. Three routes read a raw body, all to parse JSON. | `web/package.json`; `grep -rn "createHmac\|timingSafeEqual" web/src` (no hits); `web/src/lib/ai/http.ts:72` |
| The content security policy is report-only today; it lists `form-action 'self'` and no Stripe host. | `web/src/lib/csp.ts:24-47` |
| No email is sent by the server; invitations are handed over as a link; the second-step reset answers `email: 'not_sent'` until S9. | `web/src/lib/platform/service.ts:100-101`; `web/src/lib/team/service.ts:358` |
| Isolation gate: every route handler needs a row in the isolation matrix; every table with a company column is found from the catalog; every table must have row-level security enabled and forced. | `web/tests/db/isolation-matrix.ts:109`, `:249`; `web/tests/db/company-isolation-records.test.ts`; `web/tests/db/row-security-guard.ts` |
| No document in `docs/` mentions Stripe, a subscription, export or offboarding. `docs/data-ownership.md:7` already places "billing and feature flags" in Postgres. | `grep -rni "stripe\|subscription\|offboard" docs/` (no hits); `docs/data-ownership.md:7` |

## 3. Design rules every billing step follows

- **Stripe decides payment; DryScope decides use.** A company's payment state is whatever Stripe's subscription says. DryScope never infers a failed payment from silence. Usage, allowance and the cap are worked out from DryScope's own ledger and never read back from Stripe as truth.
- **An event is a nudge, not a fact.** A webhook's content is never applied. It names a Stripe customer; DryScope finds the company for that customer in its own table, reads the subscription from Stripe, and stores what it read. Doing this twice, late or out of order gives the same result.
- **A Stripe id reaches a company only through DryScope's own table.** The customer id is written when DryScope's server creates the customer. A company id is never taken from a webhook's content, a return address or Stripe's metadata.
- **Failing safe means failing open for access and closed for money.** If Stripe cannot be reached, nobody becomes read-only and nobody is restored: the stored state stands. If the usage figures cannot be worked out, AI above the allowance pauses; work that costs nothing extra continues.
- **Read-only is not suspension.** Read-only keeps sign-in, reading, documents, downloads, the export and the billing screens. Suspension (the operator's existing tool) blocks everything. Non-payment only ever causes read-only.
- **Unsent work is never dropped.** A phone holding unsent edits or photos when its company becomes read-only keeps them and sends them when access returns (the S6 decision O5, applied to billing).
- **Signed records never change.** Read-only, cancellation and closure change no signed record. Billing notes go in the billing tables, never on a job.
- **Prices and allowances come from Stripe.** No amount is written in code or in a DryScope setting. DryScope reads the prices of the company's own subscription and keeps a dated copy. A company with no prices in Stripe cannot be switched to `stripe` mode ("no price, no billing", after `AGENTS.md` rule 3).
- **Money figures shown in the app say where they come from.** The Billing screen shows usage and the expected extra charge as an estimate; the invoice is Stripe's.
- **No Stripe call in CI.** Tests use an in-process stand-in behind one interface, as the AI boundary does (S7-1). Stripe's own guidance: its hosted pages "have security measures in place that prevent automated testing", and it tells projects to "simulate the output of our interfaces and API requests using mock data".
- **One file talks to Stripe.** Only the adapter under `web/src/lib/billing/` may import the Stripe package or name `api.stripe.com`. A guard test fails on a second caller.
- **Test and live never mix.** The test copy uses a Stripe sandbox and its own keys and webhook secret; live uses live mode. The webhook route refuses an event whose `livemode` does not match its environment.
- **No card data, no payment data in logs.** Logs hold Stripe event ids, event types and outcome codes. They never hold a customer id next to a company name, an email, an amount or an address.
- **Every write that moves money or access is audited** in `audit_events`, with the operator or the member who did it, or `system` for the sync.
- **Multi-company wording.** Nothing in code, tests or documents names a company. The first company is "the first company (the owner's own)".
- **Same checks as S5 and S6:** every screen step uses the Modern Web Guidance skill, phone width (390 px), Chromium and WebKit, axe. Billing screens need a connection and say so.

## 4. How billing works

### 4.1 What is set up in Stripe

The owner sets these up in the Stripe Dashboard, first in a sandbox, then in live mode (section 7). DryScope finds the prices by fixed lookup keys and the meters by fixed event names, and never by ids typed into code.

| Stripe object | What it is | Billing |
| --- | --- | --- |
| Product and price `dryscope_company_monthly` | The company fee. A flat monthly price, quantity 1. | In advance, each month |
| Meter `dryscope_active_users` and its metered price `dryscope_active_user` | People who used the app this month. The meter bills on the last value sent in the month. | In arrears |
| Meter `dryscope_voice_extra_minutes` and its metered price `dryscope_voice_minute` | Voice minutes above the allowance. Last value. | In arrears |
| Meter `dryscope_ai_extra_credits` and its metered price `dryscope_ai_credit` | AI credits above the allowance. Last value. | In arrears |
| The allowance | Two numbers on the active-user price's metadata: voice minutes and AI credits included for each active user (question B8). | Read by DryScope |
| Customer | One per company, created by DryScope's server when the operator switches the company to `stripe` mode. | |
| Subscription | One per company, created by Stripe's Checkout page, holding the four prices, anchored to the first of the month in UTC (question B6), with automatic tax on. | |
| Settings | Retries: Smart Retries, up to 8 tries within 2 weeks (Stripe's default for new accounts). Outcome when retries end: **mark the subscription as unpaid**. Emails for failed payments, expiring cards and renewals: on (question B15). Invoice finalization for metered subscription invoices: 24 hours (question B22). Portal: update card and billing details, see invoices, cancel at the end of the period (question B13). Stripe Tax: head office address, tax code and registrations from the accountant. | |

### 4.2 The company's billing record

One row per company in `company_billing` (SB-1). The fields that matter:

| Field | Values | Meaning |
| --- | --- | --- |
| `mode` | `manual`, `stripe` | `manual` is every company's start and every pilot company's state: invoiced by hand, no Stripe objects, never made read-only by the sync. |
| `stripe_status` | Stripe's subscription status, or none | Stored as read from Stripe, for display and the rule below. |
| `access` | `full`, `read_only` | The only field the rest of the app reads. |
| `access_reason` | `unpaid`, `ended`, `operator` | Why a company is read-only; shown to its owner. |
| `override_until` | a time, or none | The operator's "keep full access until" for a dispute (question B17). |

**The rule from Stripe's status to access** (one pure function, SB-5; the only place it is written):

| Stripe says | DryScope access | The owner sees |
| --- | --- | --- |
| No live subscription yet (mode `stripe`; Checkout not completed, or a first payment that failed and expired: `incomplete_expired`) | `full` (question B14) | "Set up billing" |
| `incomplete` (first payment not finished; Stripe gives 23 hours) | `full` | "Finish setting up billing" |
| `active`, `trialing` | `full` | Next invoice date |
| `past_due` (a payment failed; Stripe is retrying) | `full`; AI above the allowance pauses (question B11) | A notice on every screen for the owner: "Payment failed. Update your card." |
| `unpaid` (retries ended) | `read_only`, reason `unpaid` | "Read-only until the bill is paid" with a pay button |
| `canceled`, and no other live subscription | `read_only`, reason `ended`, and the 30-day closing clock starts | "Subscription ended" with export |
| `paused` | `read_only`, reason `unpaid` (not used unless B10 moves to pausing after SB-0; handled so it cannot grant access by accident) | As unpaid |
| A status the code does not know | no change; an alert to the operator | |

The operator's override wins while it lasts. A company in mode `manual` is always `full` unless the operator sets read-only by hand.

**Which subscription counts.** A customer can hold more than one subscription over time (a cancelled one, then a new one). The sync reads all of the customer's subscriptions and uses the one that is neither `canceled` nor `incomplete_expired`. If none is live, the newest decides between "not yet" and "ended". If two are live, nothing changes and the operator is alerted: usage events name only the customer, so two live subscriptions would both bill the same totals. Checkout is therefore refused whenever a live subscription exists in any state (SB-7).

### 4.3 Setting a company up

1. The operator creates the company and its owner as today.
2. On the company's page the operator picks "Bill through Stripe". The server checks that the four prices and three meters exist in Stripe and are shaped as section 4.1 says (the catalog check, SB-6). It creates the Stripe customer with the company's id as the idempotency key, stores the customer id, and sets mode `stripe`. One audit row.
3. The company's owner opens Company settings, Billing, and taps "Set up billing". The server creates a Checkout Session for **that company's own customer** (subscription mode, the four prices, no quantity on the metered ones, automatic tax, billing address required, `customer_update[address]=auto` so that the address entered is the one taxed and saved, `customer_update[name]=auto` with tax id collection, the first-of-month anchor) and answers with Stripe's address. The browser goes there. The return addresses are built by the server from the environment's own public address. The server refuses when the customer already has a live subscription in any state, and expires an earlier unfinished session before making a new one.
4. The owner enters the card on Stripe's page. Stripe sends `checkout.session.completed` and the subscription events to the webhook.
5. The owner lands back on the Billing screen. The screen asks the server for the company's billing state; the server syncs that company from Stripe if the webhook has not arrived yet. Nothing in the return address is trusted.

### 4.4 Webhooks and the sync

1. **Receive.** `POST /api/stripe/webhook` reads the raw body (capped), checks the `Stripe-Signature` header (HMAC SHA-256 over `timestamp.body` with the endpoint's secret, constant-time comparison, any one `v1` signature may match, 5 minutes of tolerance), and refuses anything else with 400. It refuses an event whose `livemode` does not match the environment.
2. **Store.** It inserts one row in `billing_events` keyed by Stripe's event id (a second delivery of the same id changes nothing) with the event type and the Stripe customer id, and answers 200. It does nothing else before answering, because Stripe asks for a quick 2xx and Cloud Run gives a service no processor time after the response.
3. **Sync.** A scheduled route (`POST /api/internal/billing-sync`, the scheduler account only, every 5 minutes) claims due rows as the access worker does. For each it finds the company by customer id, takes that company's advisory lock, reads the customer's subscription from Stripe, applies the rule of section 4.2, and writes the row together with a dated copy of the subscription's prices, its allowance numbers and its current period. When `access` changes it queues every member's field access record and writes one audit row. A row whose customer is unknown is kept, marked, and raises an alert; it changes nothing.
4. **Reconcile.** Once a day the same route syncs every company in mode `stripe`, event or no event. A webhook outage of any length heals at the next pass. Stripe keeps retrying a failed delivery "for up to three days", so the two together cover an outage.
5. **On demand.** The Billing screen's load and its "Check again" button sync the signed-in company only, rate-limited.
6. **Alerts.** "Alerts the operator" means the same thing everywhere in this plan: a log line with a fixed code and no customer data, one log-based alert policy that sends it to the owner's phone (SB-3), and a row the operator's billing section lists until someone clears it (SB-10).

### 4.5 Usage, the allowance and the cap

- **The period counted.** Use, active people and the cap are counted for the subscription's current period: the UTC month, or for a company that starts mid-month, from the moment its subscription started to the month's end. Use made before the subscription started (while the company was billed by hand) is never billed.
- **Active users.** A person is active when they open the app signed in at least once in the period (question B5). `GET /api/me` already runs on every open; it keeps one row per person per month in `member_activity` with the first and the latest day seen. Operators looking at a company through the support tool are never counted.
- **AI units.** Voice minutes come from the voice sessions' recorded lengths. AI credits come from settled ledger rows, by a fixed table in code that gives each feature a number of credits (question B7). The table has a version; a month closes under the version it started with.
- **The allowance** is pooled for the company: the per-user allowance times the larger of this month's active people and last month's (questions B8 and B23). The pool therefore starts each month at last month's team and only grows during the month.
- **Extra use** is use minus the pool, never below zero, worked out separately for minutes and credits.
- **The expected extra charge** is extra use times the unit prices of the company's own subscription (DryScope's dated copy).
- **The owner's cap** is a monthly dollar limit on that extra charge, set by the owner on the Billing screen (SB-17). The AI boundary checks it inside the same locked transaction that reserves Google's cost today, before the call is made: a call that would take the expected extra charge past the cap is refused with `ai_cap`, and the screen says "AI is paused: the monthly AI limit your company set has been reached." Field work continues. The check counts calls still in progress at their full reservation, as the ceilings do, so calls made at the same moment cannot pass the cap together.
- **Voice and the cap.** A voice session is admitted once and can run for many minutes, so one check at the start cannot hold a cap. A session is admitted only when at least one minute fits under the cap; the session's existing spending check, made at each heartbeat, also checks the cap and ends the session with a spoken and written notice when it is reached. The cap can be passed by at most one heartbeat's worth of voice. Both checks live in the Live relay's admission and heartbeat routes of S7, which are not built yet; SB-17 names them. A cap of $0 means AI stops when the allowance is used up. The default is in question B9.
- **The operator's ceilings stay.** They are in Google's cost and guard the platform's own bill. The lower of the two limits applies.
- **A company in mode `manual`** has no allowance and no cap; the operator's ceilings alone apply, as today. Its owner sees usage without charges (question B21).

### 4.6 Reporting use to Stripe, and closing a month

1. **Through the month.** The scheduled route, once an hour, works out each `stripe` company's three running totals for the current period (active users, extra minutes, extra credits) and sends each to its meter as one event stamped inside the period. The meter bills on the last value, so sending the same total again changes nothing, and a total that falls (a new active user enlarges the pool) is simply the new last value. Every send is recorded in `billing_usage_reports`.
2. **At month end.** Stripe creates the month's invoice and sends `invoice.created`. The webhook route has already answered the event (Stripe delays finalizing invoices for up to 72 hours when that event gets no successful response). The sync route then waits until the month has no AI call still in progress and no open voice session (a call or session belongs to the month it started in; anything still open two hours before the window closes is counted at its reservation), freezes the month in `billing_month_close` (active users, minutes, credits, allowance, extras, the prices and the credit table version used), and sends the three final totals stamped one second before the month's end.
3. **Check.** Before the finalization window closes, the route reads Stripe's own totals for the three meters and compares them with the frozen row. A difference raises an alert to the operator and is written on the row. The window (question B22) is the time a person has to act.
4. **After finalization** nothing is re-sent for that month: Stripe does not add late usage "to the finalized invoice or the next invoice". A missed amount is the operator's decision (an invoice item by hand), recorded in the runbook.

**If the last-value meter does not behave as documented (SB-0):** the fallback is a summed meter. DryScope then sends differences, each with its own identifier from a table that records every send before it is made, and a send that fails is repeated with the same identifier only inside Stripe's 24-hour duplicate window; older failures are settled by reading Stripe's total and sending the difference. Negative differences are allowed by Stripe. This is more code and one more table, and is not built unless SB-0 requires it.

### 4.7 A failed payment, step by step

| Day | Stripe | DryScope |
| --- | --- | --- |
| 0 | The monthly charge fails. The subscription becomes `past_due`. Stripe emails the customer (if switched on) with a link to update the card. | Sync sets `stripe_status`. Access stays `full`. The owner sees the notice on every screen; other roles see nothing. AI above the allowance pauses. |
| 0 to about 14 | Smart Retries tries up to 8 times. A hard decline (a lost or stolen card, for example) is retried only after a new card is added. | Nothing changes. The Billing screen shows the next retry date when Stripe gives one. |
| Any day | The owner updates the card in the portal; Stripe charges it. The subscription becomes `active`. | Sync clears the notice. |
| About 14 | Retries end. With the setting of section 4.1 the subscription becomes `unpaid`. | Sync sets `read_only`, reason `unpaid`. Every member's field access record is rewritten as read-only. One audit row. |
| Later | The owner pays the open invoice from the portal. The subscription becomes `active`. If a month's end has passed meanwhile, Stripe has drafted a newer invoice and by default judges the subscription by its most recent invoice; SB-0 proves whether the drafts must be finalized and voided first, and the runbook follows the result. | Sync sets `full`. Phones send their kept work. |
| Later still | Each month Stripe drafts a new invoice and does not try to charge it. | Those months are not charged (B10): when the company pays its overdue invoice the operator finalizes and then voids each monthly draft. After 60 days read-only the operator ends the subscription. Data is never deleted. |

### 4.8 Read-only, enforced at five places

"Can read and download, can't create or sign" is enforced on the server. The screens only explain it.

| Place | What it does | Step |
| --- | --- | --- |
| Route wrappers | The identity carries the company's access. `memberRoute` and `accountRoute` refuse every request that is not a `GET` with 403 `billing_read_only`, unless the route is on a short written list: the billing routes, the export request, sign-out, error reports, and the owner's "disable a member" and "cancel an invitation". A link route learns its company only after its token is looked up, so the link services make the same refusal there. The Live relay's routes refuse a new voice session. A guard test walks every route and fails when a non-`GET` handler is neither refused in read-only nor on the list. | SB-9 |
| AI boundary | Every AI call is refused before any reservation. | SB-9 |
| Database | A second lock: one function says whether the current company may write, and restrictive policies on the work tables refuse inserts, updates and deletes when it says no. The billing tables, the audit log, the access outbox, the team tables and the two link tables (opening a link updates its read counter) are outside it. Scheduled workers set a marker so the repair of a Submit that was in progress can still finish. | SB-11 |
| Field database rules | The access record gains `readOnly`. `canEdit` refuses when it is true; `canRead` does not look at it. The projection writes it. | SB-12, SB-12b |
| Phone and screens | `GET /api/me` says the company is read-only. The phone keeps unsent work and sends nothing; when the rules refuse a write the phone asks `/api/me` at once, so it learns of read-only within one request and not at the access record's next renewal; create, edit, sign and AI controls are replaced by one line saying why. The photo queue treats `billing_read_only` as "waiting", never as a refusal that drops the photo. | SB-13 |

A property owner who opens a signing link for a read-only company sees "This company can't accept signatures right now. Please contact them." and cannot sign (question B12). Document links keep working: they are reading.

### 4.9 Export, cancellation and closure

- **Export.** The owner asks for an export on the Billing screen. A Cloud Run job writes one zip to a private place in the evidence bucket: CSV and JSON for every table that holds the company's rows, the field drafts, and the files (photos, signatures, documents), with a list of what is inside. The owner downloads it through the app, signed in. An export works in read-only. The list of tables comes from the database catalog, so a new table is either exported or named in a written list of exclusions with the reason; a test fails otherwise.
- **Cancellation.** The owner cancels in Stripe's portal, at the end of the paid month (question B13). When the month ends Stripe marks the subscription `canceled`; DryScope sets read-only, reason `ended`, and records the date.
- **Closure.** Thirty days later the company appears on the operator's "due to close" list. The operator closes it with the existing suspend and archive actions (question B18). Until then the owner can export and can come back by setting up billing again.
- **Deletion** of a closed company's data is not in this stage (question B1).

### 4.10 Going back, and the points of no return

| Moment | How to go back | Cost |
| --- | --- | --- |
| Any billing code is wrong | Every company in mode `manual` is untouched by it. A company goes back to `manual` once its Stripe subscription has been ended in Stripe's Dashboard; the app refuses the switch while a live subscription exists, so Stripe never keeps charging a company that is also invoiced by hand. | Minutes, plus the owner's step in Stripe |
| A company is read-only by mistake | The operator's "keep full access until" override, then find the cause. | Minutes |
| The webhook is down | Nothing changes for anyone; the daily pass and Stripe's three days of retries catch up. | None |
| A wrong amount on a draft invoice | The finalization window: correct the totals, or the operator edits the draft in Stripe. | Inside the window |
| A wrong amount on a finalized invoice | A credit note or refund in Stripe, by the owner. | Owner time |
| A migration is wrong | Add first, switch over, remove later; nothing is dropped in this stage. | A forward fix |
| **No return: a customer is charged** | A refund puts the money back; the charge, the receipt and Stripe's fee remain. | Owner-only |
| **No return in practice: a price's tax behaviour** | Stripe: "You can't change `tax_behavior` after it's been set to exclusive or inclusive"; a new price is needed. | Owner checks with the accountant first |
| **No return: a meter's settings** | Stripe: after a meter is configured "you can't make any changes aside from the display name". A wrong meter is replaced by a new one. | SB-0 proves the settings in a sandbox first |

## 5. Ordered steps

Format: **UI** screens, **FE** frontend, **BE** server routes and services, **DB** migration (or no), **FS** Firestore rules, **Infra** Terraform, **CI** workflows, **Docs**, **Owner** steps, **Tests**, **Needs**. **Slice:** database, server, screens, rules, infrastructure or documents; one slice per pull request. Size S, M or L. Risk follows `AGENTS.md`: sign-in, company separation, pricing, signing, `firestore.rules`, IAM, secrets, workflows or unsure means **High**. Each step is one pull request with a test that fails without it; each pull request states its own rating. A layer not named in a step is "none". Every step keeps its feature unreachable until the steps it needs are merged: a company in mode `manual` never reaches billing code paths.

Each step is in its own file under [`BILLING/`](BILLING/); a pull request changes its own step's file and adds any correction as a new file listed in section 15.

- [SB-0 Sandbox proof of the Stripe facts the design rests on (M, Medium)](BILLING/SB-0.md)
- [SB-1 Billing tables (M, High: company separation, a database job)](BILLING/SB-1.md)
- [SB-2 The Stripe boundary and its stand-in (M, High: money path, a new dependency)](BILLING/SB-2.md)
- [SB-3 Terraform: the webhook secret and the billing schedule (S, High: secrets, IAM)](BILLING/SB-3.md)
- [SB-4 The webhook route (M, High: a public route that changes access)](BILLING/SB-4.md)
- [SB-5 The sync worker and the status rule (L, High)](BILLING/SB-5.md)
- [SB-6 Operator billing API and the catalog check (M, High)](BILLING/SB-6.md)
- [SB-7 Owner billing API: state, Checkout and portal (M, High)](BILLING/SB-7.md)
- [SB-8 The owner's Billing screen (M, High: money screens)](BILLING/SB-8.md)
- [SB-9 Read-only at the route boundary and the AI boundary (L, High: every write route)](BILLING/SB-9.md)
- [SB-10 The operator's billing section (S, High: operator screens)](BILLING/SB-10.md)
- [SB-11 Read-only in the database (M, High: row-level security, a database job)](BILLING/SB-11.md)
- [SB-12 The access record carries read-only (S, High: the access projection)](BILLING/SB-12.md)
- [SB-12b Read-only in the field database rules (S, High: `firestore.rules`)](BILLING/SB-12b.md)
- [SB-13 Read-only on the phone and the screens (M, High: sync state)](BILLING/SB-13.md)
- [SB-14 Usage tables (M, High: a database job)](BILLING/SB-14.md)
- [SB-15 Recording who was active (S, High: touches `/api/me`)](BILLING/SB-15.md)
- [SB-16 Billable units, the allowance and the extra (M, High: pricing)](BILLING/SB-16.md)
- [SB-17 The owner's spending cap (M, High: pricing, the AI boundary)](BILLING/SB-17.md)
- [SB-18 Reporting use to Stripe and closing the month (L, High: what a customer is charged)](BILLING/SB-18.md)
- [SB-19 Use and the cap on the Billing screen (M, High: money screens)](BILLING/SB-19.md)
- [SB-20 Terraform: the export job (S, High: IAM)](BILLING/SB-20.md)
- [SB-21 Export records (S, High: a database job)](BILLING/SB-21.md)
- [SB-22 The export job and its routes (L, High: reads every table of a company)](BILLING/SB-22.md)
- [SB-23 Export, cancellation and the due-to-close list on screen (M, High)](BILLING/SB-23.md)
- [SB-24 Cancellation and the closing clock (M, High)](BILLING/SB-24.md)
- [SB-25 Close-out: the isolation and money gate, and the documents (M, High)](BILLING/SB-25.md)
- [SB-26 Live switch-on (M, High: live, money)](BILLING/SB-26.md)

## 6. What can run in parallel

| Wave | Steps | Waits on |
| --- | --- | --- |
| A (on approval) | SB-1, SB-2, then SB-4 | Nothing but B3. No Stripe account, no cloud step. SB-1 takes the database lane. |
| B | SB-0 | B4; SB-2 for its CI part; a Stripe sandbox |
| C | SB-5, then SB-6, SB-7; SB-9 beside them; SB-3 when the test copy has its public address | SB-1, SB-2, SB-4; S8-13 on test for SB-3; B12, B17 |
| D | SB-8, SB-10 (screens); SB-11 (database lane), SB-12 (server), then SB-13 (screens), then SB-12b (rules) | Wave C; the rules release job for SB-12b |
| E | SB-14 (database lane), then SB-15, SB-16, SB-17, then SB-18, SB-19 | B5 to B9, B11, B22; SB-0's results for SB-18 |
| F | SB-20, SB-21 (database lane), SB-22, SB-24, then SB-23 | B1, B13, B18 |
| G | SB-25, then SB-26 | Everything; a test release; the owner's sandbox; S8 complete for SB-26 |

The four database jobs (SB-1, SB-11, SB-14, SB-21) go one at a time through the database lane and never rename or drop. SB-9 changes the route wrappers and SB-15 and SB-9 both touch `/api/me`: they merge one after the other. SB-12b is the only rules change, and it merges after the phone knows how to keep its work (SB-13). SB-3 and SB-20 edit the Terraform roots and the plan check after S8's Terraform steps, one at a time. The stage can run beside S9. It does not need S9's email: Stripe's own emails and the in-app notice carry the failed-payment message until then.

## 7. Owner steps, in order, and the phone check

Agents run none of these. Each is ticked only after its check passes. Steps A to G are on the test copy with a Stripe sandbox; H to L are live.

| # | Step | Needs | Verify |
| --- | --- | --- | --- |
| A | **Answer B1 to B23.** Done 2026-11-17: the recommended answer for each. | this plan | Recorded in section 8 and the correction of 2026-11-17 |
| B | **Create the Stripe account** (the business's legal name and bank account, two-step sign-in on the account). Create one sandbox for the test copy. Before SB-0 starts, name the email address the SB-0 worker may give Stripe for its anonymous sandbox (B4). Before SB-18 is built, ask Stripe support whether new Meters integrations have an end date (B2). | B4 | The sandbox shows in the Dashboard's account picker |
| C | **In the sandbox:** the four prices and three meters of section 4.1 with their lookup keys and event names; the allowance numbers on the active-user price; Smart Retries left at 8 tries in 2 weeks; the outcome "mark the subscription as unpaid"; the finalization window (B22); the portal settings (B13); the customer emails (B15); Stripe Tax's head office address, the accountant's tax code and a test registration. Placeholder amounts are fine. | SB-0's results | The operator's catalog check (SB-10) reports every item found |
| D | **Keys and the webhook in the sandbox:** a restricted key with the permissions listed in `docs/SECURITY.md`; a webhook destination at `https://test.<domain>/api/stripe/webhook` with the events of section 13; copy the key and the signing secret into Secret Manager by hand. | SB-3 applied on test | A test event from the Dashboard is stored and answered 200 |
| E | **Apply SB-3 and SB-20 on test.** | each merged | Plan check passes; no deletes |
| F | **Accountant:** is the subscription taxable where the first companies are; which tax code; where to register. | B16 | The answers recorded; the code and registrations set in step C and step I |
| G | **The test-copy proof** of SB-25 with the simulated clock, on a phone. | SB-25 | The invoice equals the closed month; read-only and recovery seen on the phone |
| H | **Live Stripe account:** complete Stripe's activation; set real prices (after the pilot). | S8 complete; the owner's price decisions | Stripe shows the account as active |
| I | **In live mode, repeat C and D** with real amounts, real registrations and `https://app.<domain>/api/stripe/webhook`. Apply SB-3 and SB-20 on live. | H, F | The catalog check on live reports every item found; a live test event is stored |
| J | **Lawyer:** the billing items of the S8 checklist (automatic renewal wording, refunds, price changes, the terms link shown in Stripe's portal). | S8-1 | Answers recorded; the terms link set in the portal |
| K | **The first company:** switch it to Stripe billing, complete Checkout with a real card, watch the first invoice. | I, J as the owner decides | The subscription is `active`; the Billing screen shows the next invoice date |
| L | **The first month end:** compare the invoice with the closed month; record it. | K | SB-26's record |

**Phone check** (about 20 minutes, the owner's iPhone, on the test copy with the sandbox, recorded apart from mock results):
1. Sign in as a company's owner. Open Company settings, Billing. Tap "Set up billing"; pay on Stripe's page with a test card; land back on the Billing screen showing the next invoice date.
2. Open "Manage billing"; change the card in Stripe's portal; come back.
3. Set the AI cap to $0. Use AI until the allowance is gone: "AI is paused" appears and the job screens still work.
4. With the sandbox's failing test card and the simulated clock: the owner sees "Payment failed"; an estimator's phone shows nothing.
5. Put the estimator's phone in Airplane mode, add a room and a photo, then move the clock past the retries and turn Airplane mode off: the phone says read-only, keeps the room and the photo, and sends nothing.
6. On the read-only company: open a job, the estimate and the documents (they open); try to create a job and to sign (both refused with the reason); open a signing link on a second device (it says the company can't accept signatures now).
7. Pay the open invoice in the portal: the read-only line goes, and the estimator's room and photo arrive once.
8. Export everything and open the zip.
9. Cancel in the portal; after the clock passes the month's end the screen shows the closing date.

## 8. Owner decisions (2026-11-17)

The owner approved this plan on 2026-11-17 and chose the recommended answer for every question B1 to B23. Each row is the decision, the reason for it, and the first step that needs it. No question is open. Two owner inputs remain, and they are owner steps, not questions: the email address for SB-0's anonymous sandbox (B4, owner step B) and the question to Stripe support about Meters (B2, owner step B). B2, B4 and B10 use the wording of the independent citation check of 2026-11-17 (section 15).

| # | Question | Decided | Why | Applies to |
| --- | --- | --- | --- | --- |
| B1 | **What the stage includes.** The Standard pairs billing with offboarding: an export, 30 days read-only after a subscription ends, then closure, then deletion. | **A.** Billing, the export, cancellation and closure. Deleting a closed company's data gets its own plan. | "Can read and download" and a cancel button both need the export and the closing clock. Deletion is irreversible, needs a fresh backup and the owner, and no paying company will reach it for months. | SB-20 |
| B2 | **How use is metered in Stripe.** Stripe now recommends Metronome (a second Stripe product) for new usage-based integrations; the Meters API "remains fully supported for existing integrations", and Stripe's page says "Unless you're maintaining an existing Meters integration, use Metronome". Metronome's Checkout support is "Limited" and needs "custom API calls and webhook configuration". | **A.** The Meters API with Checkout. | The owner chose Checkout, which Stripe marks "Supported" for Meters and "Limited" for Metronome; the Stripe Dashboard is not available for Metronome. DryScope reports only three small totals a month and needs none of what Metronome adds (prepaid credits, contracts, very high volume). This goes against Stripe's guidance for new integrations; the owner accepts that for the sake of Checkout. Ask Stripe support whether new Meters integrations have an end date (owner step B, before SB-18 is built). | SB-0 |
| B3 | **Stripe's official package or a hand-written client.** A new dependency needs a reason and reviewer approval. | **A.** Stripe's official `stripe` package, pinned to an exact version, used in one file behind the interface. | Stripe: "We recommend using our official libraries to verify signatures." Its types follow the pinned API version, and it sends idempotency keys and retries correctly. This is the money path; fewer hand-made parts. | SB-2 |
| B4 | **Who may use a Stripe sandbox.** A sandbox moves no money. Stripe's command-line tool can make an anonymous one with no account. It needs an email address, lasts 7 days, and may not be able to change the Dashboard-only settings the proof needs (the outcome when retries end, the finalization window). | **A.** The worker on SB-0 uses an anonymous sandbox, created with an address the owner names for this purpose (owner step B), for the proof and to record test fixtures. It lasts 7 days. If it cannot change the three Dashboard settings, the proof falls back for items (c) and (f) to **B** (the owner runs the proof script) or, if the owner prefers, **C** (the owner creates one extra sandbox in the owner's Stripe account for SB-0 only, sets the three Dashboard settings in it, and gives the SB-0 worker a restricted key for that sandbox; it moves no money and is separate from the test copy's sandbox). The owner's own sandbox keys for the test copy stay in Secret Manager, never with an agent. | A sandbox moves no money, and the proof should not wait for the owner's time unless the anonymous sandbox cannot do the job. SB-0's first hour settles which (N7, section 13). | SB-0 |
| B5 | **What "active user" means.** | **A.** A person who opened the app signed in at least once in the month. Disabled before their first open that month: not counted. In two companies: counted in each. Operators: never. | It matches "signed in during the billing month" as a customer would read it, and a session that lasts over the month's turn does not hide a real user. | SB-14 |
| B6 | **The billing month.** The AI ledger counts by UTC calendar month. | **A.** Every subscription runs on the calendar month in UTC, starting the 1st. A company that starts mid-month pays a part of the company fee for the rest of that month (Stripe works it out), the normal fee for each person active in it, and gets the full allowance. | One month for the invoice, the allowance and the ledger. The month turns at 4 or 5 in the afternoon Pacific on the last day, which the Billing screen states. | SB-14 |
| B7 | **What an AI credit is, and how a voice minute is counted.** | **A.** Fixed credits per action, in a table in code: findings summary 2, fill scope 2, meter reading 1, job summary 1, a voice note 1 for each started minute. Voice: the month's total seconds, rounded up once to a minute. A monthly report compares what was charged with Google's cost per feature. | A customer can tell what an action costs before tapping. The numbers are the planner's first proposal from Google's cost figures; the owner sets them with the prices. | SB-16 |
| B8 | **The allowance.** | **A.** Pooled: active people times the per-person allowance, shared by the company. The two numbers (minutes, credits) sit on the active-user price in Stripe. | One heavy user and four light ones is the normal shape of a crew. Keeping the numbers on the Stripe price keeps "prices live in Stripe" true for the allowance as well. | SB-16 |
| B9 | **The cap before an owner sets one.** | **A.** $0 of extra charges: AI pauses when the allowance is used up, and the screen invites the owner to raise the limit. | No company gets an AI charge it did not choose. Voice can pass a cap by a few seconds of one session (section 4.5). | SB-17 |
| B10 | **Months spent read-only.** While unpaid, Stripe drafts an invoice each month and does not charge it. | **A.** A read-only month is not charged: the operator finalizes and then voids each monthly draft (Stripe cannot delete or void a subscription's draft invoice) when the company pays its overdue invoice. After 60 days read-only the operator ends the subscription; the company stays read-only with its data and can return. To be confirmed by SB-0, which proves both A and the alternative **D**: set Stripe's outcome to "Pause the subscription" when retries end, with automatic resume when the overdue invoice is paid; Stripe then makes no invoice for a read-only month and nothing needs voiding, but if Stripe cannot pause a subscription it cancels it instead. Moving from A to D after the proof is a new owner decision, recorded as a dated correction. | A company that could not use the product is not billed for it, and the unpaid invoice itself still stands. | SB-24 |
| B11 | **AI during the two weeks of retries.** | **A.** Everything works; AI above the allowance pauses until the payment succeeds. | No new unpaid extras pile up, and nothing a crew relies on stops. | SB-17 |
| B12 | **A signing link in a read-only company.** | **A.** The property owner cannot sign; the page says the company can't accept signatures right now. Document links still open. | It is the owner's rule ("can't create or sign"), and a signature creates a record. | SB-9 |
| B13 | **Cancelling.** Stripe's portal allows it by default. | **A.** The owner may cancel in the portal, effective at the end of the paid month; then 30 days read-only with export. | The owner's self-service path, with the export and the closing clock behind it. | SB-24 |
| B14 | **A company switched to Stripe billing whose owner never completes Checkout.** | **A.** Nothing automatic: full access; the operator follows up, and can suspend by hand. | The operator knows each early company. | SB-5 |
| B15 | **Who tells the owner a payment failed.** DryScope sends no email until S9. | **A.** Stripe's own emails (failed payment, expiring card, upcoming renewal) switched on, with their link to the portal, plus the in-app notice. DryScope's own email after S9. | An owner who does not open the app still hears of a failed payment. | Owner step C |
| B16 | **Tax details.** | **A.** Stripe Tax on every subscription; the billing address always collected at Checkout, with `customer_update[address]=auto` so that the address entered is the one taxed and saved; a business tax id accepted and not required, with `customer_update[name]=auto`; the tax code and the registrations from the accountant before live. | The code path is the same whatever the accountant says; only Dashboard settings change. | SB-7 |
| B17 | **An operator override for disputes.** | **A.** "Keep full access until" a date, at most 30 days ahead, renewable, audited. | A billing dispute should not lock a crew out of creating jobs while it is sorted out. | SB-6 |
| B18 | **Closing a company 30 days after its subscription ends.** | **A.** The company appears on the operator's list; a person closes it. | Closing stops all sign-in; a person should look first. Either way nothing is deleted. | SB-24 |
| B19 | **Payment methods.** | **A.** Cards only. | Stripe retries a failed bank debit at most twice over up to 40 days, which does not fit "about two weeks". | Owner step C |
| B20 | **Checking that a webhook comes from Stripe's addresses.** Stripe's security page says to verify signatures and to allow only Stripe's published addresses; the list can change with seven days' notice. | **A.** The signature and the 5-minute rule authenticate the request; count requests from other addresses and alert, without refusing. Refuse by address at the edge if Cloud Armor is adopted (S8, L13). | A stale address list would silently drop real events; a forged event cannot pass the signature, and a real one only makes DryScope re-read Stripe. | SB-4 |
| B21 | **Pilot companies (billed by hand).** | **A.** Their owners see use without charges; no allowance and no cap; the operator's AI ceilings apply as today. | The pilot is where the owner learns what a normal month's use is before setting prices. | SB-19 |
| B22 | **How long after the month ends before an invoice is final.** Stripe's default is 1 hour; the most is 72 hours. Use reported later is never billed. | **A.** 24 hours for invoices with metered prices. | A day for the final report, the check, and a person to act on a difference; customers get their invoice on the 2nd. | SB-18 |
| B23 | **The allowance pool on the first days of a month.** The pool is per-person allowance times active people, and on the 1st only one person may have opened the app. | **A.** The pool uses the larger of this month's active people and last month's. A company that shrinks keeps the larger pool for one month. | With the $0 default cap (B9), counting this month's people only would pause a heavy user on the 1st after one person's allowance. A never bills above the cap, because the pool only grows inside a month. | SB-16 |

## 9. The eight checks for the billing stage

| Check | For these steps |
| --- | --- |
| Rules and indexes | One rules change: `canEdit` refuses a read-only record (SB-12b), released by the existing rules job. No Firestore index. Four Postgres migrations, all additive (SB-1, SB-11, SB-14, SB-21). |
| Older records | Every existing company gets a `manual`, `full` billing row and behaves as before. An access record written before SB-12 has no `readOnly` field and counts as writable. Signed records never change. No row is dropped or renamed. |
| Offline | Billing screens, Checkout, the portal and the export need a connection and say so. A phone that is offline when its company becomes read-only keeps its unsent work and sends it when access returns (SB-13). The service worker caches no billing answer. |
| Who may use it | Two new capability keys, `billing_read` and `billing_manage`, owner only, in the role matrix and `docs/access/` (SB-7). The operator's billing actions (SB-6). One new public route, the webhook, authenticated by signature (SB-4). One new scheduled route, scheduler account only (SB-5). The read-only allowed list is written and tested (SB-9). |
| App cache | No billing route is cacheable; every answer is `no-store`. No Stripe page is framed or cached. Return pages hold no data. |
| Help and docs | Help lines for each billing state, the cap and read-only; `docs/DATA.md`, `docs/ACCESS.md`, `docs/AI.md`, `docs/SECURITY.md`, the two runbooks and the incident entries (SB-25); `docs/status/` in the batch after merges. |
| Privacy and logs | DryScope holds Stripe ids and states, never card data. Logs hold event ids, types and codes. The usage sent to Stripe is three numbers per company per month: no names, no job data. The owner's billing email and address are entered on Stripe's page and held by Stripe. An export is the company's own data, downloaded signed in, removed from the live bucket by a rule at about 7 days; recoverable copies remain until the bucket's soft-delete and version retention end (inside the Standard's 35 days). The download route itself refuses an export past its expiry time. |
| Phone check | Section 7, on the owner's iPhone, on the test copy with a Stripe sandbox, recorded apart from mock results. The first live invoice is checked in step L. |

The Standard's required tests, for this stage: **company A never reads company B** (billing state, use, cap, closed months, exports, Checkout and portal sessions, and the webhook's effect: SB-1, SB-5, SB-7, SB-14, SB-16, SB-22, gathered in SB-25); **a double submit makes one record** (the same webhook twice, the same usage total three times, two "switch to Stripe" calls: SB-4, SB-18, SB-6); **exactly once under a cut connection** (a crash between Stripe's answer and the write; kept phone work arriving once after read-only: SB-5, SB-13, SB-18); **a locked record is rejected** (every write refused for a read-only company at the routes, the database and the rules: SB-9, SB-11, SB-12b).

## 10. Corrections this plan made to earlier plans and documents

Recorded in the pull request that committed this plan, except the two rows marked "with SB-17" and "with SB-25": those documents describe what the app does today, so they change when the behaviour does.

| File | Change |
| --- | --- |
| `S7.md` section 4 (budgets) and S7-4 | The operator's ceilings stay, in Google's cost. A second limit, the company owner's spending cap in customer prices, is checked in the same reservation (SB-17). A read-only company's AI calls are refused before reservation (SB-9). |
| `docs/runbook/ai-allowance.md` (with SB-17) | "Only an authorized platform operator changes AI allowances" becomes: the operator sets the ceilings on Google's cost; the company's owner sets the spending cap on extra charges. |
| `docs/ai-spending.md` | It describes the old app's $10 allowance. Marked as old-app history, with a pointer to `docs/AI.md` and `docs/access/billing.md`. |
| `S6.md` section 3 (sync gate) and S6-5 | A new verdict, read-only: unsent work is kept and not sent, as for the lock codes; the photo queue treats `billing_read_only` as waiting (SB-13). |
| `S3.md` (company status) | `suspended` and `archived` remain the operator's tools and block all sign-in. Non-payment never sets them; it sets `company_billing.access` to `read_only`. |
| The S8 plan, section 13 and part C section I | "Export and offboarding are built with billing": they are SB-20 to SB-24; deletion is its own later plan (B1). The lawyer's billing items are owner step J here. The webhook reaches the app through the front door at the public address; S8-13b's caller-address function is reused for B20's count. |
| `docs/DECISIONS.md` (D-012's status line) | "Billing for other companies does not exist here yet" gains a pointer to this plan. |
| `docs/data-ownership.md` (the Postgres row) | "billing" in the Postgres row points to the tables planned in SB-1, SB-14 and SB-21. |
| `docs/architecture/project-profile.md` (with SB-25) | Module A's billing line and the Standard version (2.13), when the owner moves the profile to that version. |

## 11. Risks

| Risk | Effect | Handling |
| --- | --- | --- |
| A webhook is forged or replayed. | A company's access changes wrongly. | Signature over the raw body, 5-minute rule, `livemode` check (SB-4). An event's content is never applied: the worst a forged event could do is make DryScope re-read Stripe. |
| Webhooks are missed, late or out of order. | Stale access: read-only too long, or full too long. | Sync reads state from Stripe, never from the event; the daily pass; Stripe's three days of retries; "Check again" for the owner. |
| DryScope cannot reach Stripe. | Sync and reports stall. | Stored state stands; nobody is locked by an outage; reports resume; the finalization window (B22) covers a month-end outage of up to a day. |
| A company is made read-only by a bug. | A crew cannot create jobs. | One rule function with a table test; the operator's override (B17) as the way out; an alert on every change to read-only. |
| A read-only company can still write somewhere. | The owner's rule is not kept. | Five layers; the route guard test; the database policies as the second lock; the rules; the close-out gate (SB-25). |
| Usage is billed twice, or not at all. | A wrong invoice; lost trust or lost income. | Last-value meters and running totals; the month's freeze; the read-back check before finalization; SB-0 proves the meter first; the fallback of section 4.6. |
| The month's final use arrives after the invoice is final. | That use is never billed. | Hourly reports through the month (the loss is at most the last hour); the 24-hour window; `invoice.created` answered at once. |
| A price or a meter is set up wrongly in Stripe. | Wrong charges for every company. | The catalog check refuses to switch a company to Stripe (SB-6); sandbox first; a meter's settings cannot be edited, so a wrong one is replaced. |
| A price is changed in Stripe in the middle of a month. | Stripe: late usage of that month is dropped ("doesn't appear on current or subsequent invoices"). | The runbook: change prices only at a month's start; the dated price copy shows a mid-month change and raises an alert. |
| The cap is passed under load. | An invoice above the owner's limit. | The check runs inside the ledger's locked transaction, on the call's worst case and with calls in progress counted (SB-17, the fifty-at-once test). Voice can pass it by one heartbeat at most, which the Billing screen's help says. |
| A customer ends up with two live subscriptions. | Two company fees and the same use billed twice. | Checkout refused while any live subscription exists; the sync alerts on two and changes nothing; the stored customer is always reused (SB-5, SB-6, SB-7). |
| A company switched from invoicing by hand in the middle of a month. | Use from before the switch billed through Stripe, possibly above the cap. | Use is counted from the subscription's start (section 4.5); SB-0 proves the first period; the test in SB-18. |
| A Submit is in progress when the company becomes read-only. | A draft stays fenced after the company pays. | The repair worker is outside the database lock by a marker only workers set; the test in SB-11. |
| The allowance pool is small on the first days of a month. | With a $0 cap, a heavy user is paused after one person's allowance. | The pool starts at last month's team (B23). The estimate still falls when a new person becomes active; the screen says "estimate" and the closed month is the record. |
| Paying an old invoice does not restore access because a newer draft exists. | A company that paid stays read-only. | SB-0 proves the behaviour; the runbook's order (finalize and void the drafts of read-only months, then pay) follows it; "Check again" and the override cover the gap. |
| Voice is not built when billing is. | The voice meter and the voice cap have nothing to check. | SB-17's voice half waits for S7's relay routes; until then no session can start and the meter reports zero. |
| A person counted as active by an accident (a support view, a refused sign-in). | An unfair user fee. | Only a successful `GET /api/me` by an enabled member counts (SB-15); the tests name each excluded case. |
| The month turns in the afternoon in US time zones. | Use late on the last day falls in the next month. | Stated on the Billing screen and in help (B6). |
| A Stripe key or the webhook secret leaks. | Charges made in the platform's name, or forged events. | A restricted key with listed permissions; one secret per purpose; Secret Manager; rotation with Stripe's overlap of up to 7 days for the webhook secret; the incident entry; a guard test that fails on a Stripe key prefix in any tracked file. |
| Test and live are crossed. | A sandbox event changes a live company, or the reverse. | Separate keys, secrets and destinations per environment; the `livemode` check; the customer id lookup finds nothing across environments. |
| The Stripe package is a new dependency on the money path. | A supply-chain or version surprise. | Exact version pin, one importing file, the guard test, Dependabot's major-version rule; B3's alternative. |
| Stripe changes its API. | A breaking change at an upgrade. | The API version is pinned in one place; Stripe releases breaking changes twice a year in named versions; the contract suite runs against recorded answers of the pinned version. |
| The owner never sees the failed-payment notice. | Read-only arrives as a surprise. | Stripe's emails after each failed payment (B15), the in-app notice on every screen, DryScope's email after S9. |
| A hard decline (lost or stolen card). | Stripe does not retry until a new card is added; the two weeks pass without attempts. | The notice says "Update your card" from the first day; the outcome after two weeks is the same read-only. |
| Tax cannot be worked out for a customer's address. | Stripe cannot finalize the invoice. | The address is required at Checkout; `invoice.finalization_failed` raises an operator alert and asks the owner to correct the address in the portal. |
| Tax is collected where the business is not registered, or not collected where it must be. | A liability. | Stripe: "you must register with the local tax authority" before collecting; the accountant (owner step F); Stripe's threshold monitoring. |
| A chargeback or a refund. | Money leaves after the invoice was paid. | `charge.dispute.created` and `charge.refunded` raise an operator alert; access does not change by itself; the runbook. |
| An export holds another company's rows. | A data leak. | The job runs in one company's database context under row-level security; the planted-rows test (SB-22). |
| An export link is shared. | A company's data reaches an outsider. | No public link: the download is a signed-in route for the owner; the object is removed from the live bucket by a rule at about 7 days; recoverable copies remain until the bucket's soft-delete and version retention end (inside the Standard's 35 days). The download route itself refuses an export past its expiry time. |
| The rules change breaks editing for everyone. | Nobody can save field work. | Absent `readOnly` means writable; the existing rules suite must pass unchanged; released to the test copy first by the existing job. |
| The route guard's allowed list grows quietly. | Read-only leaks. | Each entry needs a written reason in `docs/access/billing.md`; the test compares the code with the document. |
| Agents handle money settings. | A wrong live charge. | Agents never hold live keys, never change Stripe settings and never run a live charge; every Stripe Dashboard step is the owner's (section 7). |
| The lawyer's or the accountant's answers arrive late. | Live billing slips. | The build and the sandbox proof need neither; only steps H to K wait. |

## 12. Costs

**Stripe's own fees were not checked in this task.** Stripe's documentation, not its price list, was the source. Before the owner sets prices, read the current fees on Stripe's pricing pages for: card payments, Stripe Billing (a share of recurring charges), Stripe Tax, and disputes. They come out of each invoice and belong in the owner's margin sums beside Google's cost.

**Google, each month:** one more Cloud Scheduler job, one more secret, the export job's minutes when an owner exports, and the export zips for 7 days. All small against the figures in the S8 plan's section 12; none checked against a price list (Google Developer Knowledge returned no prices, as in the S8 scout).

**Margin check built into the stage.** The monthly close row holds Google's cost for the company's AI (from the ledger) beside the units charged. A report for the operator shows, per feature, what was charged against what it cost. "Priced above Google's cost" then has a number behind it every month, and a credit weight that has fallen below cost shows up at once.

**Later (not in this stage):**
- Deleting a closed company's data, with a receipt (its own plan; the owner runs it).
- Self sign-up, and Checkout before a company exists.
- Annual plans, discounts, coupons and trials.
- Different prices for different companies (the lookup keys allow a second price set).
- DryScope's own billing emails (after S9).
- Refusing webhook requests by address at the edge (with Cloud Armor, B20).
- Stripe's usage alerts and credit grants, if the allowance ever moves into Stripe.
- A dedicated Google Cloud project for a company that pays for one (Module A).
- A click-through record of accepted terms (with the lawyer's text).

## 13. Stripe documentation checked

Checked 2026-11-17 by reading Stripe's pages directly (each page's own Markdown copy, the page address followed by `.md`). The API version Stripe named as current that day was `2026-10-28.endive`. Quotes are word for word. Nothing below comes from memory or a web search; where a page did not say something, the last list says so.

| # | Fact the plan uses | What Stripe's page says | Page |
| --- | --- | --- | --- |
| 1 | A failed renewal makes the subscription `past_due`; the Dashboard setting decides what follows. | "For subscriptions with `collection_method=charge_automatically`, a failed renewal payment makes the subscription `past_due`. ... After retries end, your failed payment settings in the Dashboard determine whether the subscription remains `past_due` or changes to `unpaid` or `canceled`." | https://docs.stripe.com/billing/subscriptions/overview |
| 2 | `unpaid` is the state to remove access in. | "Revoke access to your product when the subscription is `unpaid` because Stripe already attempted and retried payment while the subscription was `past_due`." | same |
| 3 | An unpaid subscription keeps drafting invoices. | "For `unpaid` subscriptions, Stripe stops attempting payment. The subscription continues to generate invoices each billing period, which remain in `draft` status." | same |
| 4 | `canceled` cannot be undone. | "This is a terminal state that can't be updated." | same |
| 5 | A first payment has 23 hours. | For `incomplete_expired`: "The initial payment on the subscription failed and the customer didn't make a successful payment within 23 hours of subscription creation." | same |
| 6 | Paying the open invoice restores `active`. | "To move the subscription to `active`, pay the most recent non-voided invoice or manually mark it as uncollectible when status resolution uses the most recent invoice". | same |
| 7 | Retries last about two weeks by default. | "For new Stripe accounts, Stripe enables Smart Retries by default and configures it for up to 8 retries within 2 weeks." The periods offered: "1 week, 2 weeks, 3 weeks, 1 month, or 2 months". | https://docs.stripe.com/billing/revenue-recovery/smart-retries |
| 8 | The outcome when retries end is a setting with four choices. | The settings table lists "Cancel the subscription", "Mark the subscription as unpaid", "Leave the subscription past-due" and "Pause the subscription". For unpaid: "The subscription changes to `unpaid` after the maximum number of days defined in the retry schedule. Invoices continue to be generated and stay in a draft state." | same |
| 9 | A hard decline is not retried until a new card exists. | "Retries continue to be scheduled, and attempt_count continues to increment, but retries only execute after detecting a new payment method." | same |
| 10 | The event for a failed payment. | The page says to use the `invoice.payment_failed` webhook "to receive subscription payment failure events and retry attempt updates." | same |
| 11 | Bank debit retries differ (B19). | The table of local payment methods gives, for ACH Direct Debit: retryable failures, insufficient funds; maximum retries, 2; maximum retry period, 40 days. | same |
| 12 | Stripe can email the customer about a failed payment, with a link to update the card. | "When you enable this setting, Stripe automatically sends an email to your customer after each failed payment." "You can set the link destination to a Stripe-hosted Customer Portal". | https://docs.stripe.com/billing/revenue-recovery/customer-emails |
| 13 | Stripe steers new usage billing to Metronome; Meters stay supported (B2). | "Metronome is Stripe's primary usage-based billing platform and the recommended starting point for all new integrations. Basic usage-based billing, built on the Meters API, is a lower-level primitive that remains fully supported for existing integrations." "Basic usage-based billing also offers fuller compatibility with Connect, Checkout, Adaptive Pricing, and Workflows." | https://docs.stripe.com/billing/subscriptions/usage-based |
| 14 | Metronome with Checkout is limited. | The compatibility table marks Checkout as supported for basic usage-based billing and as Limited for Metronome, with the footnote "Requires custom API calls and webhook configuration." | https://docs.stripe.com/billing/subscriptions/usage-based/compare-metronome |
| 15 | The old usage-records API is legacy. | "This page documents legacy usage-based billing." | https://docs.stripe.com/billing/subscriptions/usage-based-legacy |
| 16 | A meter's settings are fixed once made. | "After you configure the meter, you can't make any changes aside from the display name." | https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure |
| 17 | A meter can bill on the last value. | "**Last**: Bill customers based on the most recent usage event's value for the billing period." | same |
| 18 | Stripe's duplicate check for usage events is short. | "Stripe enforces uniqueness within a rolling period of at least 24 hours. The enforcement of uniqueness primarily addresses issues arising from accidental retries or other problems occurring within extremely brief time intervals." | https://docs.stripe.com/api/billing/meter-event/create |
| 19 | A usage event may be stamped in the past. | "Must be within the past 35 calendar days or up to 5 minutes in the future." | same |
| 20 | Usage is processed after the call returns. | "Stripe processes meter events asynchronously, so aggregated usage in meter event summaries and on upcoming invoices might not immediately reflect recently received meter events." | https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api |
| 21 | Late usage is never billed. | "Stripe might accept an event after finalization and include it in meter summaries without updating the finalized invoice or adding the usage to the next invoice." | same |
| 22 | One call at a time per customer and meter. | "Meter Events are additionally limited to one *concurrent* call per customer per meter." | same |
| 23 | Rejected usage events are announced only by separate events. | "Stripe asynchronously processes meter events. If we find an error, we create one of the following Events": `v1.billing.meter.error_report_triggered`, `v1.billing.meter.no_meter_found` (payload type `thin`). | same |
| 24 | Wrong usage can be cancelled for a day, or offset. | "You can only cancel events sent to Stripe within the last 24 hours." "You can also fix incorrectly recorded usage data by recording negative quantities. If the overall cycle usage is negative, Stripe reports the invoice line item usage quantity as 0." | https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure |
| 25 | Stripe's own totals for a meter can be read back. | The API page "List billing meter event summaries" says: "Retrieve a list of billing meter event summaries." | https://docs.stripe.com/api/billing/meter-event-summary/list |
| 26 | The finalization window is 1 hour by default and at most 72. | "All invoices have a default finalization grace period of 1 hour. During the finalization grace period, you can continue to report usage for the previous billing period." "You can set a delay of up to 72 hours (3 days)." A rule can apply to invoices that have "a metered price" and are "from a subscription cycle". | https://docs.stripe.com/billing/subscriptions/usage-based/configure-grace-period |
| 27 | An unanswered `invoice.created` delays finalization. | "If Stripe fails to receive a successful response to `invoice.created`, we delay finalizing all invoices with automatic collection for up to 72 hours". | same |
| 28 | A price change mid-month loses late usage. | "If a subscription item's price changes during a billing cycle ... the grace period doesn't capture late usage. ... any usage reported during the grace period doesn't appear on current or subsequent invoices." | same |
| 29 | Checkout's hosted page is Stripe's recommended form and carries Billing and Tax. | The comparison table heads the first column "FULL PAGE (Recommended)", lists "Built-in UI support for Billing, Tax" for it, and gives its hosting as "Hosted or Embedded". | https://docs.stripe.com/payments/checkout |
| 30 | A subscription Checkout Session; no quantity on metered prices; the event that follows. | For `mode`: "Pass `subscription` if the Checkout Session includes at least one recurring item." "For usage-based billing, don't pass quantity". "After the subscription signup succeeds, the customer returns to your website at the `success_url`, which initiates a `checkout.session.completed` webhook." | https://docs.stripe.com/api/checkout/sessions/create ; https://docs.stripe.com/billing/subscriptions/build-subscriptions (Stripe-hosted page variant) |
| 31 | A session expires by itself. | For `expires_at`: "It can be anywhere from 30 minutes to 24 hours after Checkout Session creation. By default, this value is 24 hours from creation." | https://docs.stripe.com/api/checkout/sessions/create |
| 32 | The first-of-month anchor through Checkout, and the part-month charge. | For `subscription_data.billing_cycle_anchor`: "A future timestamp to anchor the subscription's billing cycle for new subscriptions." For `subscription_data.proration_behavior`: "If no value is passed, the default is `create_prorations`." | same |
| 33 | The anchor is in UTC; Stripe bills the part month. | "The billing cycle anchor uses Coordinated Universal Time (UTC)." "Stripe automatically creates a prorated invoice to bill for the period between the subscription creation date and the first full invoice date." | https://docs.stripe.com/billing/subscriptions/billing-cycle |
| 34 | What the portal lets a customer do. | "Update billing information, including their tax IDs"; "Update payment methods"; "Cancel subscriptions immediately or at the end of the current billing period". | https://docs.stripe.com/customer-management |
| 35 | The portal's limit for this kind of subscription. | "If a subscription uses any of the following, the customer can cancel it in the portal, but can't update it". The list that follows starts with multiple products and usage-based billing. | same |
| 36 | A portal session is short-lived and must follow DryScope's own sign-in. | "Portal sessions are temporary. New portal sessions expire after a 5 minute period." "Make sure to authenticate customers on your site before creating sessions for them." | same ; https://docs.stripe.com/customer-management/integrate-customer-portal |
| 37 | Cancelling in the portal is on by default; the portal shows a terms link. | The settings table: "Cancel subscription ... On". For the terms of service link: "Enter a link to your terms of service." | https://docs.stripe.com/customer-management/configure-portal |
| 38 | A webhook's signature needs the raw body. | "Stripe requires the raw body of the request to perform signature verification. If you're using a framework, make sure it doesn't manipulate the raw body." | https://docs.stripe.com/webhooks |
| 39 | How the signature is made and checked. | "Compute an HMAC with the SHA-256 hash function. Use an active endpoint signing secret as the key, and use the `signed_payload` string as the message." "Use a constant-time string comparison to compare the expected signature to every `v1` signature in the header." | same |
| 40 | The 5-minute rule against replays. | "Our libraries have a default tolerance of 5 minutes between the timestamp and the current time." "Don't use a tolerance value of `0`. Using a tolerance value of `0` disables the recency check entirely." | same |
| 41 | Stripe recommends its libraries for the check (B3). | "We recommend using our official libraries to verify signatures." | same |
| 42 | Answer quickly. | "Your endpoint must quickly return a successful status code (`2xx`) before any complex logic that could cause a timeout." | same |
| 43 | Deliveries are retried for three days in live mode. | "Stripe attempts to deliver events to your destination for up to three days with an exponential back off in live mode." "We retry event deliveries created in a sandbox three times over the course of a few hours." | same |
| 44 | Events can arrive in any order. | "Stripe doesn't guarantee the delivery of events in the order that they're generated." | same |
| 45 | The same event can arrive twice, and one change can make two events. | "Webhook endpoints might occasionally receive the same event more than once." "In some cases, two separate Event objects are generated and sent." | same |
| 46 | The webhook secret can be rolled with an overlap. | "You can choose to immediately expire the current secret or delay its expiration for up to 7 days ... During this time, multiple secrets are active for the endpoint." | same |
| 47 | Two event formats; a stored copy can be stale. | "For new integrations, use thin events." "Because this snapshot can be stale by the time your application processes it, fetch the latest version of the resource from the API before acting on the data." "If you're using thin events, you'll need to register a separate webhook endpoint." | https://docs.stripe.com/events/how-events-work ; https://docs.stripe.com/webhooks |
| 48 | Missed events can be listed for 30 days. | "Stripe only returns events created in the last 30 days." | https://docs.stripe.com/webhooks/process-undelivered-events |
| 49 | Stripe says to check signatures and allow only its addresses (B20). | "You must also verify webhook signatures and allowlist Stripe's IP addresses to make sure that every Stripe webhook you receive is sent exclusively by Stripe." Address changes: "We provide seven days' notice through that mailing list before making changes." | https://docs.stripe.com/security/guide ; https://docs.stripe.com/ips |
| 50 | Hosted payment pages keep card data off DryScope's servers. | "You can instead use one of our low risk payment integrations to securely collect and transmit payment information directly to Stripe without it passing through your servers, reducing your PCI obligations." | https://docs.stripe.com/security/guide |
| 51 | Use restricted keys. | "Use restricted API keys (RAKs) for most use cases." "Because you can't limit their permissions, we don't recommend using secret keys for new use cases". Sandbox keys start `rk_test_` and `sk_test_`; live keys `rk_live_` and `sk_live_`. | https://docs.stripe.com/keys |
| 52 | Idempotency keys. | "All `POST` requests accept idempotency keys." "You can remove keys from the system automatically after they're at least 24 hours old." | https://docs.stripe.com/api/idempotent_requests |
| 53 | API versions; the package pins one. | "The current version is 2026-10-28.endive." "Starting from `stripe-node v12`, the requests you send using `stripe-node` align with the API version that was current when your version of `stripe-node` was released." "Webhook events also use your account's default API version unless you set an API version during endpoint creation." | https://docs.stripe.com/api/versioning |
| 54 | Sandboxes, one per purpose. | "A sandbox is an isolated test environment." "Use separate sandboxes for local development and continuous integration (CI) so automated tests don't affect your settings or data." An anonymous sandbox: "It doesn't require account registration." | https://docs.stripe.com/sandboxes |
| 55 | Simulated time for renewals and failures. | "Use test clocks to advance simulated time in a sandbox and see how your subscriptions and invoices change." "You can advance the clock by any increment, up to two subscription intervals at a time". | https://docs.stripe.com/billing/testing/test-clocks |
| 56 | Stand-ins in CI, not Stripe's pages. | "Front-end interfaces, like Stripe Checkout ..., have security measures in place that prevent automated testing, and Stripe APIs are rate limited. However, you can simulate the output of our interfaces and API requests using mock data". | https://docs.stripe.com/automated-testing |
| 57 | Tax on a Checkout Session, from the customer's address. | "Setting `automatic_tax.enabled` to `true` applies automatic tax to the entire Checkout Session." "Set `billing_address_collection` to `required` to always collect a billing address". | https://docs.stripe.com/tax/checkout/page |
| 58 | Registration comes first. | "Before you start collecting tax from your customers, you must register with the local tax authority." | https://docs.stripe.com/tax/set-up |
| 59 | A bad address stops an invoice. | "When you start using Stripe Tax, make sure to listen to `invoice.finalization_failed` events. If the `automatic_tax.status` of the invoice is `requires_location_inputs`, it means that the address details of your customer are invalid or insufficient." | https://docs.stripe.com/tax/subscriptions |
| 60 | Tax behaviour is permanent; tax codes are never guessed. | "You can't change `tax_behavior` after it's been set to **exclusive** or **inclusive**." "Treat `txcd_` identifiers as opaque, exact strings. Never construct, guess, or infer a code from a product description". | https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior |
| 61 | Prices found by a fixed key. | For `lookup_key`: "A lookup key used to retrieve prices dynamically from a static string." | https://docs.stripe.com/api/prices/object |
| 62 | Invoicing by hand for the pilot is also possible inside Stripe. | "`send_invoice`: Sends an invoice for manual payment." | https://docs.stripe.com/billing/collection-method |
| 63 | The alternative for the allowance that the plan did not take. | Credit grants: "You can only apply credit grants to subscription items that use metered prices and report usage through Meters." "Credits are only reconciled at invoice time. Customers can exceed their balance during the cycle." | https://docs.stripe.com/billing/subscriptions/usage-based/billing-credits ; https://docs.stripe.com/billing/subscriptions/usage-based/compare-metronome |
| 64 | A seat price, for B5 option C. | "Per-seat pricing is a linear pricing model where the number of seats ... maps to the number of units". | https://docs.stripe.com/subscriptions/pricing-models/per-seat-pricing |
| 65 | Which invoice decides the status after a payment (section 4.7). | "**Most recent invoice**: This is the default behavior. Stripe uses the most recent non-voided invoice. Other outstanding invoices don't prevent the subscription from becoming `active`." | https://docs.stripe.com/billing/subscriptions/overview |
| 66 | An unfinished Checkout Session can be expired by the server (SB-7). | The page says: "You can also expire the session instead if you want to cancel the session's subscription". | same |

**Webhook events the destination subscribes to** (from https://docs.stripe.com/billing/subscriptions/webhooks; `checkout.session.completed` from https://docs.stripe.com/api/events/types): `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.created`, `invoice.finalized`, `invoice.finalization_failed`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `charge.dispute.created`, `charge.refunded`. Every one only triggers a sync; four also raise an operator alert (finalization failed, action required, dispute, refund).

**Not found on the pages read, and how the plan treats it:**
- Whether every event above exists in the thin format (the catalog page was not read line by line): the design works with either; SB-0 decides.
- How a last-value meter treats values across the month's edge and inside the finalization window: one sentence in the documentation; SB-0 proves it; section 4.6 holds the fallback.
- The largest size of an event: SB-0 measures; SB-4 sets its cap from it.
- The self-assessment form Stripe expects from a business using only hosted Checkout: the security page read here does not name it; the owner's Dashboard shows the requirement under compliance documents.
- Stripe's fees: not on the documentation pages; section 12.
- That a browser's page change to Stripe's address is unaffected by `form-action`: a browser rule, not a Stripe fact. SB-8 uses a page change, not a form post, and tests it with the policy enforced.

**Plan follow-ups to verify in the sandbox step (SB-0).** The independent citation check of 2026-11-17 found seven behaviours the plan relies on that no Stripe page it read states. "Not found" means those pages do not say it, not that Stripe does not do it. Each is proved or settled by SB-0 before a step depends on it:
- **N1. Usage under a simulated clock.** Nothing says usage events can be sent, and are billed, for a customer on a simulated clock. A usage event's stamp "Must be within the past 35 calendar days or up to 5 minutes in the future", which reads as real time, and for an existing customer "The initial `frozen_time` can't be in the past". SB-0 item (l) proves it first. If it fails, the month-end comparison in SB-25, owner step G and phone check steps 3 to 5 are redesigned (for example a clock started up to 35 days in the past on a fresh customer) before the owner is asked to run them.
- **N2. Stripe's default outcome when retries end.** No page states it. Harmless: owner step C sets the outcome explicitly (section 1, item 6).
- **N3. Which invoice decides the status after an old one is paid.** Whether a newer draft counts as "the most recent non-voided invoice". SB-0 item (f) proves it.
- **N4. A last-value meter at the edges.** That it bills the last value stamped inside the month, including one sent during the finalization window, and how it treats two events with the same stamp ("The aggregation includes the multiple events" is not explained for a last-value meter). SB-0 items (a) and (k) prove it; SB-18 never sends two different totals with the same stamp.
- **N5. Replacing a wrong meter.** A meter's event name is unique ("You can only use an event name with a single meter"), and no page says a deactivated meter frees its name. SB-0 item (m) proves it. Until then the catalog check takes the three event names as a setting, not as constants, so a replacement meter can use a new name.
- **N6. The largest size of a webhook event.** Not documented. SB-0 item (g) measures it; SB-4 sets its body cap from it.
- **N7. What an anonymous sandbox may change.** No page says an unclaimed anonymous sandbox can change the Dashboard-only settings SB-0 needs (the outcome when retries end, the finalization window, Smart Retries). SB-0's first hour settles it; B4 names the fallback.

## 14. Google documentation checked

Checked 2026-11-17 with Google Developer Knowledge (`search_documents`). Document names are the tool's resource names. No tool call failed. No Google product is added by this stage; the rows confirm how existing ones are used.

| Choice in this plan | What the documentation says | Document |
| --- | --- | --- |
| Stripe's two secrets reach the web app as environment variables pinned to a version (as the existing secrets do). | "Environment variables are resolved at instance startup time, so if you use this method, Google recommends that you pin the secret to a particular version instead of using latest as the version." | `documents/docs.cloud.google.com/run/docs/configuring/services/secrets` |
| Rotation of the Stripe secrets is a reminder plus a runbook step. | "Secret Manager does this by sending notifications to Pub/Sub topics associated with your secrets"; "You must configure a Pub/Sub subscriber to receive and act on the SECRET_ROTATE messages." | `documents/docs.cloud.google.com/secret-manager/docs/secret-rotation` |
| The webhook stores the event and answers; the work is done by a scheduled call, not after the response. | "With request-based billing, CPU is only allocated during request processing." Background work after a response needs instance-based billing; "Consider using Cloud Tasks for executing asynchronous tasks." | `documents/docs.cloud.google.com/run/docs/configuring/billing-settings` |
| The billing-sync route is called by Cloud Scheduler with a Google-signed token, like the access worker. | "To authenticate between Cloud Scheduler and an HTTP target, Cloud Scheduler creates a header token based on your client service account ... You can use either an ID (OIDC) token or an OAuth (access) token." | `documents/docs.cloud.google.com/scheduler/docs/http-target-auth` |
| One scheduled call has at most 30 minutes; the sync works in bounded batches. | "Cloud Scheduler HTTP targets (3-minute default) ... have a maximum timeout of 30 minutes (1,800 seconds)." | `documents/docs.cloud.google.com/run/docs/configuring/request-timeout` |
| The export runs as a Cloud Run job with a longer task timeout. | "By default, each task runs for a maximum of 10 minutes: you can change this to a shorter time or a longer time up to 168 hours (7 days)." | `documents/docs.cloud.google.com/run/docs/configuring/task-timeout` |
| Export zips are removed by a rule on one prefix. | "The matchesPrefix and matchesSuffix conditions are satisfied when the beginning or end of an object's name is an exact case-sensitive match with the specified prefix or suffix." "By default, when you delete a live object, it becomes soft-deleted, and Cloud Storage retains it for a duration of seven days." Setting a configuration by Terraform "replaces all existing lifecycle rules on the bucket", so SB-20 adds its rule beside the existing ones. In a bucket with versioning a deleted object "exist[s] in a noncurrent state for some amount of time": an export leaves the bucket inside the Standard's 35 days, not at day 7. | `documents/docs.cloud.google.com/storage/docs/lifecycle` |

**Not in the corpus:** prices for Cloud Scheduler, Secret Manager and Cloud Run jobs (section 12 gives no figures).

## 15. Corrections

Later changes to this plan, newest last.

- [2026-11-17: owner answers B1 to B23 and the citation check](BILLING/2026-11-17-owner-answers-b1-to-b23.md)
