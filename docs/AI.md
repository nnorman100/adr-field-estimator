# AI features

Every AI feature in DryScope: model, limits, evaluation, switch and Model Armor status. This file
is the index; it links to the detailed docs instead of copying them:

- Every model call path, prompt hash, limit and the Model Armor modality contract, checked by a test: [ai-inventory.md](ai-inventory.md)
- Estimate assist (counts, range, warnings, job close): [estimate-assist.md](estimate-assist.md)
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

None in this repository at the commit this file describes. `backend/ai_usage.py` only reports the
sum of each active member's usage (`ai_usage` switch); it enforces nothing, and nothing watches
spend. The standard's per-company budget is covered by the open pull request for a per-company
monthly AI cap (#230); update this section when it merges.

## Evaluation tests

Run by CI (provider-free, `python -m pytest tests`, `npm test`): `test_audit_retry.py`,
`test_live*.py`, `test_voice_notes.py`, `test_voice_note_gate.py`, `test_late_transcript_gate.py`,
`test_scope.py`, `test_claims.py` with `tests/golden/v1-documents.json`, `test_insights.py`,
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

**Not in use.** Neither the code, the docs, the scripts nor CI refer to Model Armor, and no
Vertex safety setting or data-loss-prevention screen is configured. The standard puts Model Armor
on every AI call and, for live voice, screens the text transcript and replies, not the audio
stream (to be confirmed against Model Armor's supported inputs). The target coverage by modality, with raw audio and video pending the owner's decision R2, is in
[ai-inventory.md](ai-inventory.md#ai-modality-coverage-contract). Stand-ins that exist today are
application-level only: prompts label input as untrusted, output is schema-validated, the server
writes prices and prose, inputs are size-limited and rate-limited, and sensitive fields are kept
out of prompts.
