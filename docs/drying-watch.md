# Drying watch (A1)

Drying watch is behind `AI_FEATURES=drying_watch`, off by default. `/api/session`
advertises the enabled list. It requires company workspaces; legacy mode and
anonymous signing/document links have no watcher. No scheduler runs. Reading
and coordination hooks do nothing while the feature is off.

Owners and office staff see company jobs; estimators see only jobs they created
or are assigned. The card appears on Check Scope and Review after signing.
Superadmin support has audited read-only lists and cards. Owners and office
staff can remind, extend or close; a job's estimator can also mark it dry.
Every state change requires an explicit confirmation, a reason, a request ID
and the facts hash reviewed. A stale hash asks the person to reload.

The owner separately enables **Allow drying reminders after an office or owner
confirmation** in Company settings. It defaults off and is independent of
document delivery. Each confirmed reminder sends one email to the assigned
active estimator's membership email or the company's crew-lead email. The
preview states the recipient, address, signed drying day and reading gap.
The company Reply-To and existing sender/counter are reused. No customer name,
price or AI-generated prose goes into the reminder. Known failures are
retryable; a send with an uncertain outcome is never automatically retried.
Retries reuse the reminder ID and provider idempotency key. Reminders and
monitoring changes are never added to the offline draft queue.

The monitoring calculation uses the signed rooms and `drying_days`, and current
drying-log readings. Calendar days use `America/Los_Angeles`, including daylight
saving; parity fixtures compare with the browser's `summarizeLog` in that zone.
The signed time starts day 1. A reading is due 24 hours after the latest reading
(or signing if none); overdue means that instant has passed. Stalled means the
latest affected-air GPP has not fallen across three recorded days in a room.
Past signed plan means the calendar day exceeds the signed days, even when an
office extension note exists. Future-dated readings do not postpone a visit.

Automatic closure requires every affected material's latest reading to meet
its own dry standard in its own meter unit. Materials are identified by room,
material label and unit. Every signed room must have affected material readings,
at least its recorded wet-material count (or one when that count is absent).
Missing standards and incomplete room coverage keep monitoring active. Air
readings alone never prove material dryness. Mark dry and Close monitoring
record the named person's reason; Mark dry is shown as a staff decision rather
than an automatic dry-standard attestation. Removing or replacing a reading
recomputes automatic status. An explicit staff closure remains closed.

**Extend plan** adds a coordination note only. The signed days, equipment,
prices, revision, proposal hash, photos and agreement never change. Extra
billable days require **Copy to new draft** and a separate agreement.

The model receives a small fact pack with material/air measurements, day counts,
missing rooms and flags. No customer, address, transcript, notes, email or price
is sent. The validator rejects invented numbers, money, scope/equipment advice,
over 60 words, and dry/complete assertions unless all standards are met.
Summaries cache on `facts_hash` plus log update time; repeat views use the cache.
Provider or validation failure leaves facts visible with **Retry summary**.
Calls are limited to 6/minute and 60/day per user; state changes to 10/minute
and 120/day, reminders to 6/minute and 60/day. Quotas return Retry-After.

`_job_monitoring/{job_id}` is a private sidecar, never part of signed documents.
Reading additions/removals and assignment updates sync it in the same Firestore
transaction. It stores company/access IDs, the signed plan, current state,
summary, closure, up to 100 extension notes and 200 reminders. Send reservations
last 30 seconds; no expired ambiguous reservation can send again. The sidecar
is permanent coordination data: it has no `expire_at`, and the existing four
TTL groups remain unchanged. Firestore client rules remain deny-all.

The two `_job_monitoring` composite indexes are declared for company/status/due
and estimator-filtered queries. Initial lists scan the existing paginated
signed-job index so older jobs without sidecars appear and lazily gain one.
`scripts/preview_drying_watch.py --project <project> --company <id>` previews the
last 60 days, printing counts only. Its default creates nothing; `--apply`
creates only missing sidecars for jobs with readings and is idempotent. No
production backfill or deployment was performed for this change.

Validation uses eight status fixtures and ten summary packs, fake model/email
handlers, Chromium/WebKit phone specs, and local Firestore emulator transaction,
rule and retention checks. `scripts/verify_drying_summaries.py --dry-run` makes
no model calls. Its explicit `--live` mode is a later operator release gate:
five unchanged validated outputs from the dedicated Vertex project before the
feature is enabled. Real-service email/Vertex checks and physical iPhone
observations are separate, still-open release checks. Deploy indexes separately
before enabling the backend; follow `firebase-isolation.md` for isolated release.

Kun's input: deterministic status calculations keep monitoring independent of
model availability. Explicit approval provenance and idempotent reservations
make each outward action attributable to the person who confirmed it.
