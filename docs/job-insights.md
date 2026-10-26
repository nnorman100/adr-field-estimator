# Job at a glance and AI usage

O1 and O3 are implemented behind independent `AI_FEATURES` entries `job_summary` and `ai_usage`,
both off by default. They are internal and read-only: no acceptance, pricing, document, email or
owner delivery switch is involved. Enabling either is a later release decision.

Open At a glance in Company jobs/My jobs, or the card at the top of Check scope. AI summary is an
internal description of saved facts; Saved job facts exposes its inputs. Refresh checks the cache and
regenerates only if facts changed or the cache expired. Restoring a draft or signed job and successful
fact-changing saves load fresh facts and mark an obsolete summary for Refresh, even without a new
revision. Changes during an active load trigger a facts reload after it settles. Offline summaries last only for jobs opened this session;
AI calls are never queued. Provider failure preserves the facts and offers Retry; 429 honors Retry-After.

Owners and office may read company jobs; estimators read only accessible jobs. `GET /api/jobs/{id}/insight`
checks job access before reading any sources and again inside the cache commit. IDs may be an inspection
or a signed authorization, resolved to the same private job sidecar. `?facts_only=true` performs no model
call. Signed scope and review facts use the immutable authorization snapshot; claim facts use the
current authorized job sidecar, alongside current delivery and monitoring sidecars. Readiness is optional for drafts; drying watch is optional for signed jobs. Unknown legacy
inputs are shown as missing, not inferred. Other company access is refused.

The model returns only one to four distinct topic enum values. The server renders every sentence from
deterministic facts, validates availability, an 80-word limit, numbers-in-facts, no money and no JSON or
field names. Customer identity strings appear only in the reader’s fact list; they never enter the
model prompt or logs. Even cached text is regenerated from validated selections. The summary cannot
write inspections, signed records, monitoring, deliveries or email. The default daily cap is 60 per
user and 6 per minute; cache and facts-only reads consume no slots. Failed generations consume a slot
and can be explicitly retried. Logs contain only operation, cache hit and existing model status fields.
Provider and validation failures use the existing Vertex AI call ERROR filter.

`_job_insights/{job_id}` stores company ID, facts hash, closed selection, rendered narrative,
generated_at and expire_at. Commits read access and facts in the same Firestore transaction;
a changed hash returns 409. Expiry is enforced before returning cached data. Deny-all rules already
protect the new sidecar; single-document reads need no index. No migration/backfill is needed. The
owner-run TTL script includes this collection group, but no policy was applied by this build. Cache
retention and TTL setup are owned by [Firebase isolation](firebase-isolation.md#firestore-ttl-policies).

`/api/session.quota` reports each user’s paid-operation used, limit and remaining counts. The Account
menu refreshes these when opened. `GET /api/companies/{id}/ai-usage` sums active members’ current
24-hour counters; only the owner may use it. The windows begin at the first request for each operation,
not at midnight. Failed requests reserve slots; Live counts new sessions. Counts are not billing and
there is no pricing table, history, scheduler or additional counter write. A read failure shows Usage
unavailable without blocking the session. Maps, manual monitoring actions and reminder emails are
excluded because they are not model operations.

Superadmin support uses `GET /api/admin/companies/{id}/jobs/{job}/insight` and
`GET /api/admin/companies/{id}/ai-usage`. They recheck the revoked account and support access, audit the
read, and never generate summaries or modify a cache. Missing/expired cache shows facts only.

## Verification and release gates

`python scripts/verify_job_summaries.py --dry-run` validates ten synthetic packs and adversarial
selections without a provider. Unit/API tests cover roles, tenant isolation, quota windows, caps,
invalid selections, retry, source immutability, stale/expired cache and access revocation during a call.
Emulator tests execute cache transactions, quota concurrency, deny-all rules and expiry/deletion
recovery (the emulator does not run TTL deletion itself). Browser specs exercise owner, office,
estimator and support at 390 and 320 pixels, loading, failure, rate limiting, stale/offline state,
feature hiding and Help. There is no approval state because the feature cannot act on the job.

A later authorized release must run the explicit `--live` evaluation on five packs in the dedicated
project, with five unmodified validator passes, then have the owner read each result for misleading
wording. No live model or production calls, deploys or emails belong to this build. WebKit CI and a
physical iPhone check remain separate from local Chromium evidence.

Kun’s input: reuse closed selections and deterministic facts rather than add a free-text narrative
trust boundary; keep the usage meter a read of existing counters instead of inventing a billing system.
