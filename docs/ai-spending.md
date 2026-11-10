# Company AI spending

Each company starts with a **$10 monthly AI allowance before launch**, shared across
its members and AI features. A company without an explicit override uses the platform
default in code; reserving or reading AI work never writes that default to company
settings. Only deliberate private overrides are stored in
`_company_ai_budgets/{company_id}.monthly_cap_microusd` (integer micro-USD;
10,000,000 means $10). An existing override wins over the platform default and can
be raised at launch; no owner editing control is exposed. The runbook explains
[overrides and reserved holds](runbook/ai-allowance.md).
No migration or cloud configuration change is needed for the default.

The owner's dashboard shows one read-only line, **AI used this month: $X of $10.00**,
even while the separate optional AI request-count feature is off. Only the owner page
loads it, from `GET /api/companies/{company_id}/ai-spending`, which answers only the
current company's active owner; superadmin status alone grants no spending access.
`/api/session` carries no spending data. The response is private and not cached.
Offline, or when the read fails, the line makes no spending claim and has no refresh
control. Spending uses UTC calendar months, independently of the existing per-user
rolling quota windows. [Cloud Billing reports](https://docs.cloud.google.com/billing/docs/how-to/reports)
use Pacific time, so these UTC ledger totals need not line up exactly with a
billing report month.

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

The verified REST model is `gemini-3.8-flash`. Before each reservation, CountTokens
counts the actual contents with the same generation configuration and normalized
response schema. Counting makes no generation and creates no spending hold. If the
count is missing, invalid, over the model's 1,048,576 input-token limit or unavailable,
the paid request is refused. A zero-input precheck avoids counting work when the
operation's output bound already cannot fit. The final reservation transaction
always rechecks the complete counted bound, so concurrent requests cannot rely on
that earlier precheck.

The hold is counted input times $1.65 per million tokens plus the operation's
explicit output maximum times $8.25 per million tokens, rounded up to micro-USD.
These standard non-global rates omit promotional discounts. Output limits include
thinking: audit 16,384; scope 16,384; OCR 8,192; voice transcription 8,192; job summary
and drying summary 2,048 each. OCR keeps the model's existing default thinking;
scope keeps LOW thinking. The larger bounds provide headroom for reasoning and
quoted scope changes without changing those thinking settings. Observed real-provider
token counts and count-versus-billed-input comparisons remain release checks;
offline tests verify the emitted limits and corresponding holds, not model accuracy.
The SDK sends exactly that maximum. Small OCR calls
therefore reserve their own counted bound rather than the model's absolute $2.27
maximum. Successful usage metadata settles input plus output/thinking tokens;
cached input receives no discount. A hold can still refuse a request whose eventual
actual cost would fit. New models or operations fail closed until their rates and
bounds are reviewed in code.

Settlement is idempotent. A provider `APIError` carrying an HTTP error status
(400–599, including 429, 500 and 503) settles zero. A successful result survives a
failed settlement transaction: the server logs only the operation/model and error
class and returns the result, while the full durable hold continues to count.
Ledger checks, the reservation and settlement wait only until the request's AI
deadline (the 55-second REST deadline less its 5-second save reserve, an audit
attempt's share or a summary's 25 seconds); unfinished ledger work completes in the
background, and a reservation that arrives after its request gave up is released
unused. A cancelled request, timeout, transport error, lost response, missing
usage metadata or worker crash cannot prove that the provider did no paid work.
Such work consumes its full reservation, either as settled spending or as a durable
unconfirmed hold. Holds have **no expiry that refunds capacity**. They stay charged
to their original UTC month; a late settlement cannot refund the next month's allowance.
No TTL policy or automatic billing reconciliation is added.

A refusal is a 429 that says field work can continue. When settled spending alone
leaves no room for this particular call, it explains that this request does not fit
and that the allowance resets next month UTC, with `Retry-After: 3600`; it does not
claim every AI operation is unavailable. When the remaining allowance is only held by other
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

Company-ledger transaction contention also returns the held-allowance 429 with
`Retry-After: 60`, including Firestore's exhausted commit retries wrapped around
an `Aborted` error. A refused OCR attempt keeps its pending photo and reading state,
and the same client cooldown applies. Contention while settling a paid result still
returns that result and retains the hold. Unrelated validation and storage failures
keep their existing error handling.

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
tokens as a conservative transcription margin. These are the published standard
Live list rates, without an added regional premium; confirm the deployed tariff
against real billing before release. A $0.10/minute time floor estimates only the
connected time since the last valid usage report (or connection opening if none
arrived). A valid report replaces the floor through its arrival; the settled cost
is cumulative reported cost plus that unreported tail, not the larger of reported
usage and the entire session's elapsed floor. The hold grows with that estimate. Each usage report
and the existing heartbeat check the shared company total and end the session at
the cap; estimates above the cap are recorded, not clamped away. Shutdown settles
reported cost plus the unreported-tail floor. A provider connection that never
opened settles zero. Connected sessions without reports settle only their connected
time floor, with no $2 minimum. The admission margin is not a usage charge. Audio
in a provider message is forwarded before that message's spending transaction.
A Live 429 is terminal for automatic reconnects and carries Retry-After seconds in
the displayed refusal. Crashes leave
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
[Gemini 3.8 Flash token limits](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash),
[CountTokens and generation configuration](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/count-tokens),
and [Gemini API billing](https://aistudio.google.com/docs/billing).
The Gemini API FAQ identifies 400/500 failures and token counting as unbilled; the
retrieved Vertex documentation did not establish the equivalent error-billing rule.
The zero-settlement policy above follows the requested prelaunch accounting; verify
Vertex's treatment of these HTTP errors against its billing before release.

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

## Code boundaries

`backend/ai_generation.py` owns counted generation, reservations and bounded ledger
cleanup. `backend/main.py` binds it to the existing provider client, storage access,
workspace setting and logger; the routes retain their generation entry points.
`public/ai-spending-ui.js` owns authenticated dispatch and the existing per-user,
per-company cooldowns. The app shell loads it before `app.js` and precaches both.
`InsightUI.dashboardUsage` composes the existing request-count card and monthly
spending line in their original order. SDK wire and emulator reservation cases live
in `tests/test_ai_spending_sdk.py` and `tests/ai_spending_emulator.py`; the emulator
case keeps its entry point in the existing CI collector, with the same assertions
and shared fixtures as before extraction.
