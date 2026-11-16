# AI features

Every AI feature in DryScope: model, limits, evaluation, switch and Model Armor status. This file
is the index; it links to the detailed docs instead of copying them:

- Every model call path, prompt hash, limit and the Model Armor modality contract, checked by a test: [ai-inventory.md](ai-inventory.md)
- Estimate assist (counts, range, warnings, job close): [estimate-assist.md](estimate-assist.md)
- Live walkthrough instructions for the rebuilt app (each section, and what changed from the old text): [ai/live-instructions.md](ai/live-instructions.md)
- Live walkthrough build review (historical, October 7, 2026): [gemini-live-build-review.md](gemini-live-build-review.md)
- Pricing and mandatory wording (server math, never a model): [pricing-source.md](pricing-source.md)
- Live protocol checkpoints and the feature-switch procedure: [firebase-isolation.md](firebase-isolation.md)
- What personal data reaches a model: [DATA.md](DATA.md)

## Rules that apply to all of them

1. A model never supplies a price, a total, a count that prices, or required wording
   (`backend/claims.py`, Decimal math on the server). The server also drops any sentence stating a
   price from the AI summary, suggestions and testing advice of each new audit.
2. A person approves anything a customer sees: the technician confirms scope before the audit and
   confirms the documents before signing; the homeowner signs the documents.
3. Output is structured JSON validated by Pydantic (`generate()` in `backend/main.py`); a provider
   failure returns a retry error, never a signable fallback.
4. Coordinates, equipment scans, price-table items and quantity overrides are never sent to a model
   (`backend/prompts.py`). Job summaries and drying summaries are built from verified facts without
   customer name, address or transcript.
5. Logs never hold prompts, transcripts or provider messages (`backend/cloud_log.py` allowlist).

## Configuration

| Setting | Default in code | Notes |
|---|---|---|
| `AUDIT_MODEL` | `gemini-3.8-flash` (`backend/main.py:207`) | scope, audit, transcription, job and drying summaries |
| `OCR_MODEL` | the value of `AUDIT_MODEL` | meter-photo reading |
| `LIVE_MODEL` | `gemini-3.8-live` (`backend/main.py:224`) | Live walkthrough |
| `GOOGLE_CLOUD_LOCATION` | `global` | REST calls |
| `LIVE_LOCATION` | `us-central1` | Live relay |
| `LIVE_VOICE` | `Charon` | |
| `AI_FEATURES` | deploy baseline `readiness` | comma list; empty enables nothing |

`scripts/deploy_backend.py` sets only `WORKSPACES_ENABLED`, `AI_FEATURES`, `PRICE_BOOKS_ENABLED`,
`RETENTION_ENABLED` (and optionally `STAFF_EMAILS`), so the model and location values above apply unless the serving
service already carries its own; check the revision before relying on them. Verify a model in the
dedicated project before enabling a different one (`AGENTS.md` section 2).

REST requests have a 55 s deadline (`REST_DEADLINE_SECONDS`, because Hosting times out at 60 s).
The Live relay runs under the Cloud Run 3600 s timeout.

## Features

| Feature | Model | Where | Switch | Limits (per user unless noted) |
|---|---|---|---|---|
| Live walkthrough (voice and video coach) | `LIVE_MODEL` | `WS /api/live`, `backend/main.py`, `live_support.py` | none (always on) | 40 sessions a day (a resumed session is free); one at a time per user (60 s lease); first message within 10 s and 16,384 bytes; audio chunk 64,000 bytes; JPEG frame 512,000 bytes; context compression at 64,000 tokens |
| Meter-photo reading (OCR) | `OCR_MODEL` | `POST /api/inspections/{id}/photos/{photo_id}/ocr` | none | 400 a day, 20 a minute; the 1,600 px copy only |
| Fill scope from walkthrough | `AUDIT_MODEL` | `POST /api/inspections/{id}/scope-suggestions` | none | 120 a day, 6 a minute; at most 100 changes and 20 questions; every change needs an exact quote from the technician's words |
| Voice-note transcription | `AUDIT_MODEL` | `POST /api/inspections/{id}/voice-notes` | none | 200 a day, 10 a minute; audio at most 10 MB and 660 s; audio is not stored |
| Audit (summary, next observations, unpriced work, testing advice) | `AUDIT_MODEL` | `POST /api/audit` | none | 60 a day, 3 attempts a minute; 25 s per attempt with one retry inside the 55 s deadline; at most 60 photos |
| Job summary | `AUDIT_MODEL` | `GET /api/jobs/{id}/insight` | `AI_FEATURES=job_summary` | 60 a day, 6 a minute; the model picks 1 to 4 topics from a fixed list and the server writes the sentences; cached 30 days |
| Drying-watch summary | `AUDIT_MODEL` | `POST /api/jobs/{id}/drying-watch/summary` | `AI_FEATURES=drying_watch` | 60 a day, 6 a minute; the model chooses up to two rooms and a fixed mention; the server renders the text |
| Readiness (job gaps) | none (deterministic, `backend/readiness.py`) | Review screen, Live prompt | `AI_FEATURES=readiness` (on in the baseline) | advisory: "requests, never blockers" |
| Estimate assist (suggested counts, range, warnings, job close, accuracy) | none (server arithmetic; reuses the scope output) | see estimate-assist.md | `AI_FEATURES=estimate_assist` (range needs no switch) | no model supplies a number |
| Priced extras | none | additional work quote and approval | `AI_FEATURES=priced_extras` | not AI; listed because it shares the switch list |

Per-user daily and per-minute limits are `DAILY_LIMITS` in `backend/inspection_store.py` and the
`store.quota` calls at each route. Per-address limits protect the anonymous link routes.

## Company budget and daily ceiling

In the Python app each company has a shared monthly AI spending allowance ($10 per UTC calendar month before launch) on top
of the per-user limits above. REST calls hold a counted-input reservation before dispatch; Live has a soft
threshold with an admission margin. The mechanism, refusals, overrides and crash behavior are owned by
[ai-spending.md](ai-spending.md). `backend/ai_usage.py` still only reports request counts (`ai_usage`
switch) and enforces nothing. The Python app has no separate daily company ceiling.

The rebuilt app (`web/`, S7-4) has its own ledger in Postgres, `web/src/lib/ai/budget.ts` over migration
0012's `ai_ledger` and `company_ai_settings`: a daily **and** a monthly ceiling per company ($10 and $200 by
default, owner decision V5 B; the operator can store others), per-person daily quotas per feature, a 429 with
`Retry-After` that says field work continues, settlement once per call id, and holds that never refund on
their own. The owner reads the use on Company settings; the routes are in [ACCESS.md](ACCESS.md), "AI usage
and ceilings".

## Evaluation tests

Run by CI (provider-free, `python -m pytest tests`, `npm test`): `test_audit_retry.py`,
`test_live*.py`, `test_voice_notes.py`, `test_voice_note_gate.py`, `test_late_transcript_gate.py`,
`test_scope.py`, `test_claims.py`, `test_claims_documents.py` with `tests/golden/v1-documents.json`, `test_insights.py`,
`test_drying_watch.py`, `test_readiness.py` (includes the `scripts/readiness_eval.py` accept and
reject cases), `test_sizing.py`, `test_estimate_warnings.py`, `test_outcomes.py`, `test_outcome_history.py`,
`test_pricing_v2.py`, `test_logging.py`.

Real-service checks, run by hand with synthetic data and **not** in CI: `scripts/verify_scope_extraction.py`,
`verify_estimate_prompts.py`, `verify_estimate_batch3.py`, `verify_job_summaries.py` and
`verify_drying_summaries.py` (`--live` is a separate release gate), `verify_live_reliability.py`,
`verify_live_release.py`, `verify_workspace_database.py`. Record their results separately from
mock tests.

There is no automatic accuracy or hallucination score on the audit or scope prompts gating a
release, and physical-iPhone Live behaviour is open until observed on a device (`AGENTS.md`
section 7). The standard asks for evaluation tests before an AI feature turns on; that is not met
for those two prompts.

## Model Armor

**Not in use by any app.** No application code calls Model Armor and no Vertex safety setting or
data-loss-prevention screen is configured. Terraform now provisions the text template, the floor setting
and the sanitize grants (S7-2; `infra/dryscope/README.md`), with Model Armor's own logging held off by a
plan check, but nothing screens a call until the S7 features that use them. The standard puts Model Armor
on every AI call and, for live voice, screens the text transcript and replies, not the audio
stream (to be confirmed against Model Armor's supported inputs). The target coverage by modality, with raw audio and video under the narrow exception the owner decided on 2026-11-12 (R2 = S7 decision V1 B), is in
[ai-inventory.md](ai-inventory.md#ai-modality-coverage-contract). Stand-ins that exist today are
application-level only: prompts label input as untrusted, output is schema-validated, the server
writes prices and prose, inputs are size-limited and rate-limited, and sensitive fields are kept
out of prompts.

## Rules from Technology Standard 2.7 and 2.8 (planned for the rebuild)

Nothing below is built yet. The rebuilt app's AI is stage S7 ([plans/S7.md](plans/S7.md)); the Terraform
settings are in [plans/TC.md](plans/TC.md). The owner's decisions are D-018 to D-028 in
[DECISIONS.md](DECISIONS.md). Google statements cite documents read through the Developer Knowledge tool.

- **Model Armor is a baseline, not a guarantee.** The built-in Agent Platform integration covers the
  `generateContent` method and skips screening and carries on if Model Armor is unavailable,
  unreachable or errors, so a prompt or reply can occasionally go unscreened
  (`documents/docs.cloud.google.com/model-armor/model-armor-vertex-integration`). It does not
  sanitize documents or file uploads. Streamed replies and voice transcripts go through the
  Model Armor sanitize API, as S7 plans; no audio or video is screened, under the owner's R2
  exception ([ai-inventory.md](ai-inventory.md#ai-modality-coverage-contract)).
- **Model Armor logging stays off.** Logging sanitize operations writes full prompts and replies to
  Cloud Logging; in the console that setting is on by default for Agent Platform in the floor settings
  (`documents/docs.cloud.google.com/model-armor/configure-logging`). Rule 5 above applies to it too.
  The owner confirms the floor settings and the spike template `dryscope-live-spike` have it off before S7
  uses them; use audit logs (no payload) and the app's own counters instead.
- **Zero-data-retention checklist, one line per AI feature.** Google's guide lists what needs a
  deliberate choice: session resumption, grounding, explicit context caching, and stored files
  (`documents/docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention`).
  Each S7 feature records here whether it uses any of them. Today none of the rebuilt features is
  built, so the checklist is empty by design.
- **Live voice resumes after a drop, so it is not zero-retention (D-019).** Google stores the session's
  text, audio and video prompts and model outputs for up to 24 hours so a session can resume
  (`documents/docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session`).
  The Live relay in S7 turns resumption on; the customer terms say so.
- **Where text AI runs:** the `us` multi-region endpoint, because no current GA Flash model is served from
  `us-central1` (D-027); Live stays on `us-central1`.
- **Spend cap:** a monthly Agent Platform cap on each project with AI, above the company budgets
  (D-020). The app keeps working with AI off when it triggers.
- **Agents:** none in S7; the first will run on Cloud Run (D-028). The "Agent Gateway" and
  "Agent Identity" products are not relied on.

The old app's rows above (Model Armor "Not in use", `LIVE_LOCATION`, `GOOGLE_CLOUD_LOCATION`) describe
the Python backend and stay true until it is retired.
