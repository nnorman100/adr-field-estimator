# Company AI spending

Each company starts with a **$10 monthly AI allowance before launch**, shared across
its members and AI features. It is stored in the private `_company_ai_budgets/{company_id}` document
as `monthly_cap_microusd` (10,000,000). The server initializes a missing document when
the company first reserves AI work. Reading spending has no write side effects.
Until the first reservation, a company without a settings document sees the
platform default. An existing value wins over the platform default. The private
per-company override can be raised at launch; no owner editing control is exposed.
No migration or cloud configuration change is needed for the default.

The owner's dashboard shows one read-only line, **AI used this month: $X of $10.00**,
even while the separate optional AI request-count feature is off. Only the owner page
loads it, from `GET /api/companies/{company_id}/ai-spending`, which answers only the
current company's active owner; superadmin status alone grants no spending access.
`/api/session` carries no spending data. The response is private and not cached.
Offline, or when the read fails, the line makes no spending claim and has no refresh
control. Spending uses UTC calendar months, independently of the existing per-user
rolling quota windows.

The amount shown is estimated settled spending plus reservations for active or
unconfirmed work; both count against the allowance. These conservative estimates are
a safety control, not an invoice or customer job prices. All existing per-user and per-minute
quotas remain. The ledger never supplies job prices or changes an agreement.

## REST: hard reservations

Every provider generation for audit, scope extraction, OCR, offline voice-note
transcription, job summaries and drying summaries acquires a reservation before
dispatch; the generation helper has no unmetered mode. Audit retries reserve separately; implicit SDK HTTP retries are disabled
so a provider retry cannot multiply one reservation. Readiness, equipment recommendations,
estimate warnings, manual edits and price calculations that run without a model
make no paid generation and use no AI spending allowance. Cached and facts-only
summary reads also make no generation.

`backend/ai_spending.py` transacts on one company/month document in `_company_ai_months`
and a separate random-ID document in `_company_ai_reservations`. Acquiring the
hold reads settings and the month's spent and reserved totals, refuses a total above
the cap, and writes the increased total and reservation atomically. Concurrent
workers and members share this invariant. Money is integer micro-USD, rounded up.

The verified REST model is `gemini-3.8-flash`. The reservation uses its maximum
1,048,576 input tokens plus an explicit maximum of 65,536 output tokens, at standard
non-global list prices ($1.65/$8.25 per million input/output tokens), without
promotional credits. This reserves up to $2.270823 for one call. Successful usage
metadata settles input plus output/thinking tokens; cached input receives no
discount in this estimate. Local unused voice-note holds are released. A reservation
can refuse a call near the cap even if its eventual actual cost would have fit.
New model IDs fail closed until their price and token bounds are reviewed in code.

Settlement is idempotent. A cancelled request, timeout, lost response, missing
usage metadata or worker crash cannot prove that the provider did no paid work.
Such work consumes its full reservation, either as settled spending or as a durable
unconfirmed hold. Holds have **no expiry that refunds capacity**. They stay charged
to their original UTC month; a late settlement cannot refund the next month's allowance.
No TTL policy or automatic billing reconciliation is added.

A refusal is a 429 that says field work can continue. When settled spending alone
leaves no room for the call, it explains that AI is unavailable until next month UTC,
with `Retry-After: 3600`. When the remaining allowance is only held by other
reservations (calls in progress or awaiting confirmation), it says so instead, with
`Retry-After: 60`; those holds may settle at a lower actual cost, while crash holds
stay charged. The phone pauses photo readings or voice-note audio uploads for the
user and company workspace that sent the refused request, until the latest
`Retry-After` deadline, even if another job is open when the refusal arrives.
Autosave, newly recorded notes, queue restarts and Retry recognition do not resend
early. Draft saves and pending-note registration continue during the pause, and a
refused reading does not stop other queued drafts' manual work from syncing. It does not change the draft,
photos, voice-note ledger or agreement because of that refusal. Offline notes may
still be recorded and synced as pending field work. Ordinary manual work, document
reads and signing a previously prepared eligible agreement do not consult spending.

## Live: soft threshold, chosen by the owner

The owner chose to preserve provider automatic speech detection and current Live
interruption behavior. Live therefore has a **soft threshold**, not REST's hard
per-call billing bound. Google's Live service re-bills accumulated context on each
turn and may report usage after the billable work. A fixed cost per minute cannot
guarantee a hard cap with those speech boundaries.

Before **every** provider connection, resumed connections included, Live reserves
$2. New sessions are refused when spent plus reserved spending is at least the cap
minus $2, or the new hold would exceed the cap. Live token reports are accumulated
across turns. Known modalities use the standard Live list prices: $0.75/$1/$3 per
million text/image-or-video/audio input tokens and $4.50/$12 per million text/audio
output tokens. Unclassified input uses $3 and unclassified output/thinking uses
$12. A report without a reliable input/output split uses $16.50 per million total
tokens as a conservative transcription margin. A $0.10/minute estimate floor advances when
usage is absent or delayed. The hold grows with that estimate. Each usage report
and the existing heartbeat check the shared company total and end the session at
the cap; estimates above the cap are recorded, not clamped away. Shutdown settles
reported estimates, or at least the $2 hold when no usage arrived. Crashes leave
their durable hold in place. A UTC-month change ends the connection so a reconnect
must reserve on the new month.

**Live can overshoot by about an in-flight session while usage arrives.** This is
an approximate exposure, not a mathematical maximum: delayed reports and several
simultaneous sessions can add unreported work. The reserve reduces that exposure;
it does not make automatic speech turns a hard dollar bound. Exhaustion closes coaching without deleting the saved draft or
evidence. User quotas, access/revocation rechecks, audio acknowledgements, microphone
format, Finish cleanup and resumption behavior remain in place.

Sources verified November 6, 2026:
[Google's model pricing and Live billing details](https://cloud.google.com/model-garden/pricing),
[Gemini 3.8 Flash token limits](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash).

## Verification and release

Synthetic tests exercise concurrent reservations/settlements, two companies,
restart/crash holds, month rollover and late settlement, thinking-token cost, unknown
models, cap refusals through real API handlers, owner access, the dashboard line and a
refused queued photo reading that leaves later queued drafts syncing.
Mock/transactional-fake tests do not establish real-service billing accuracy.
Production Firestore/Vertex checks and physical iPhone camera, microphone,
Bluetooth, interruption, reconnect, Finish cleanup and conversational latency
remain open until observed. No production service or database was changed here.

Kun's input: research provider billing and existing call boundaries before choosing
the mechanism; use one transactional invariant across features and test concurrent
and crash behavior, rather than adding independent counters per feature.
