# AI inventory and parity baseline

Every place the current Python backend calls a model, written down so the TypeScript port can be proven equal to it.
Stage S1 of the rebuild pins today's behaviour; it changes no prompt, model, limit or switch. Read
[AI.md](AI.md) first for the rules that apply to all AI features; this file is the detailed, checked
inventory behind it.

**State:** `master` after pull request #229, Python backend, no Model Armor.

## How this file is kept true

- The [Pinned prompts](#pinned-prompts) table is read by `tests/test_ai_inventory.js` (run by `npm test`). The test runs
  `scripts/ai_inventory_facts.py`, hashes each prompt text with SHA-256 over its UTF-8 bytes, and fails with the id and the
  new hash if any prompt text differs from the table, or if one is added or removed.
- A prompt change is therefore a visible two-file change. To update after an intended change run
  `python3 scripts/ai_inventory_facts.py --table`, paste the rows, and say in the pull request why the behaviour should change.
  The port must leave every hash unchanged: a port that "improves" a prompt fails this test on purpose.
- **Two checks, one exception to "new tests use Vitest".** The prompt-text hashes need no backend packages, so they
  stay in Vitest (`tests/test_ai_inventory.js`, run by the Node CI job). What each path actually
  sends (model, client, config, parts, response schema with its full SHA-256, quota charges, and the prompt text as emitted)
  can only be observed by running the legacy Python routes, which needs pydantic, FastAPI and the Gen AI SDK. The Node job
  installs none of them and workflow files are protected, so those assertions live in the existing Python suite
  (`tests/test_ai_inventory.py`; the legacy Python suite was retired from CI on 2026-11-10, so it no longer runs there). This is a recorded exception: the assertions exercise the legacy
  backend, so they belong to its suite until that area is rewritten in TypeScript (stage S7), when they convert to Vitest
  ("old suites convert by area").
- Only the text each prompt owns is hashed. Data the server adds at call time (inspection JSON, photo log, claim details,
  facts packs) is not a prompt and is described in the call-path sections instead.
- Everything below is read from the code. Deployed environment variables (`AUDIT_MODEL`, `OCR_MODEL`, `LIVE_MODEL`,
  `GOOGLE_CLOUD_LOCATION`, `LIVE_LOCATION`, `LIVE_VOICE`) can override a default; `scripts/deploy_backend.py` does not
  set them, so check the serving revision before treating a default as live (see [AI.md](AI.md)).

## Summary

| Path | Route or trigger | Model (env, default) | Region | Prompt ids | Switch |
| --- | --- | --- | --- | --- | --- |
| Meter-photo reading (OCR) | `POST /api/inspections/{id}/photos/{photo_id}/ocr` | `OCR_MODEL`, follows `AUDIT_MODEL` = `gemini-3.8-flash` | `global` | `ocr.instructions` | none, always on |
| Voice-note transcription | `POST /api/inspections/{id}/voice-notes` | `AUDIT_MODEL` = `gemini-3.8-flash` | `global` | `transcribe.instructions` | none, always on |
| Scope extraction ("Fill scope from walkthrough") | `POST /api/inspections/{id}/scope-suggestions` | `AUDIT_MODEL` | `global` | `scope.instructions`, `scope.claim_details` | none, always on |
| Audit (summary, unpriced work, testing advice) | `POST /api/audit` | `AUDIT_MODEL` | `global` | `audit.instructions`, `audit.age_rule_*`, `shared.company_identity` | none, always on |
| Job summary | `GET /api/jobs/{job_id}/insight` | `AUDIT_MODEL` | `global` | `job_summary.instructions` | `AI_FEATURES=job_summary` (off in the baseline) |
| Drying-watch summary | `POST /api/jobs/{inspection_id}/drying-watch/summary` | `AUDIT_MODEL` | `global` | `drying_summary.instructions` | `AI_FEATURES=drying_watch` (off in the baseline) |
| Live walkthrough | `WS /api/live` | `LIVE_MODEL` = `gemini-3.8-live` | `us-central1` | `live.*`, `shared.company_identity` | none, always on; readiness text in the prompt needs `AI_FEATURES=readiness` (on in the baseline) |

All REST calls go through one function, `generate()` in `backend/main.py`, with `response_mime_type='application/json'`, a
response schema and Pydantic validation of the reply. The Gen AI client is built with `enterprise=True` for the dedicated
project `alert-disaster-field-2026` and a 95-second HTTP timeout. The Live relay builds its own client for `LIVE_LOCATION`.
No call sets a temperature or a tool list. Every REST call sets a per-operation maximum output token count and holds a
reservation against the company's monthly AI allowance before dispatch (limits and rates in [ai-spending.md](ai-spending.md)). Application-level safety today is prompt labelling of untrusted data, schema validation, size
and rate limits, and server-written prices and prose (see [AI.md](AI.md#model-armor)).

Features that are **not** model calls and so are not inventoried: readiness gaps (`backend/readiness.py`), estimate assist
(counts, range, warnings, job close), priced extras, `ai_usage` reporting, address suggestions.

## Call paths

Each section lists what goes in, what may come out, the limits, the budget hooks, the checks and the switch. "Per-minute"
and "daily" limits are per signed-in user and enforced by `store.quota` in Firestore (`_limits`); a rejected call
returns 429 before any model call.

### 1. Meter-photo reading (OCR)

- **Code:** `ocr_photo()` in `backend/main.py`; prompt `OCR_INSTRUCTIONS`.
- **Input:** one image (a JPEG of at most 1,600 px on its longest side, made by `fit_jpeg()` through `model_image()`) plus the instruction text.
  No transcript, address or job data. Modality: image only.
- **Output:** `OcrResult` (`meter_detected`, `meter_type` ≤100, `value` ≤100, `classification` ≤100, `notes` ≤1,000
  characters). A failed or timed-out call stores no reading (`ocr_status` stays unverified); pending, failed, no-meter and
  unreadable results are never treated as verified.
- **Limits:** thinking level provider default; call timeout 50 s (the 55 s REST deadline less its 5 s save reserve); no retry.
- **Budget hooks:** 20 a minute, 400 a day (`ocr`). `Vertex AI call` log line with model, operation, time and outcome only.
- **Evals:** none in CI; the legacy OCR fakes (`tests/test_image_handling.py`) belong to the Python suite retired from CI on 2026-11-10.
  Historical real-service check: the `ocr_case` in `scripts/verify_estimate_batch3.py` (non-meter image must give
  `meter_detected=false` and an empty value); the script no longer runs because it imports the removed first-company price book.
- **Switch:** none.

### 2. Voice-note transcription

- **Code:** voice-note route in `backend/main.py`; prompt `TRANSCRIBE_INSTRUCTIONS`.
- **Input:** raw **audio** (MP4, WebM or Ogg, at most 10 MB and 660 s, signature-checked) sent inline with the instruction.
  This is the only path that sends recorded audio. Audio is never stored or logged.
- **Output:** `TranscriptionResult` (`text` ≤20,000 characters), appended to the technician transcript (80,000 character
  cap); the note must then be reviewed before scope, audit or signing. A note whose label is already in the transcript skips
  the model call.
- **Limits:** thinking level LOW; timeout `REST_DEADLINE_SECONDS - 5` (50 s); no retry; a quota 429 leaves the note pending.
- **Budget hooks:** 10 a minute, 200 a day (`transcribe`).
- **Evals:** fakes only (`tests/test_voice_notes.py`, `test_voice_note_gate.py`, `test_late_transcript_gate.py`). No
  real-service script exists for transcription accuracy.
- **Switch:** none.

### 3. Scope extraction

- **Code:** `suggest_scope()` in `backend/main.py`; prompt built by `scope_prompt()` in `backend/scope.py`, with
  `CLAIM_PROMPT` added only when company workspaces supply claim details; wire schema `scope_response_schema()`.
- **Input:** text only: the current form (without assistant transcript, equipment scans, coordinates, priced items or
  quantity overrides), the technician transcript and notes, and the saved claim details when present.
- **Output:** `ScopeSuggestions`: at most 100 `changes` (each needs an exact `source_quote` from the technician's words),
  `claim_changes` checked one by one, at most 20 `questions`. The server drops unverifiable quotes and applies nothing on its
  own; the technician confirms in the form. No price, rate or reading is ever accepted.
- **Limits:** thinking level LOW; timeout 50 s (the 55 s REST deadline less its 5 s save reserve); no retry. Staged check on 2026-10-13: 10 calls
  at most 4.5 s, median 2.6 s (comment in `backend/main.py`).
- **Budget hooks:** 6 a minute, 120 a day (`scope`).
- **Evals:** `tests/test_scope.py` (provider-free); historical real-service checks, no longer runnable because they import the retired
  backend: `scripts/verify_scope_extraction.py`, `verify_estimate_batch3.py` (`scope_case`; the `verify_estimate_prompts.py` `extract`
  cases were removed). Each case had to match the expected `(room, field) → value` map exactly.
- **Switch:** none.

### 4. Audit

- **Code:** `audit_inspection()` and `generate_audit()` in `backend/main.py`; prompt `audit_prompt()` in `backend/prompts.py`
  (`AUDIT_INSTRUCTIONS`, the app age rule line, the inspection JSON, the photo log with each photo's OCR status and result,
  the priced scope, and the company identity suffix when workspaces are on).
- **Input:** text plus **images**: every photo on the job (at most 60), each as the stored 1,600 px model copy (hash-checked)
  or a 1,600 px JPEG made on the spot, downloaded six at a time. The audit waits up to 30 s for pending OCR first.
- **Output:** `AIResult`: `summary` ≤6,000, `suggestions` ≤30 × 1,000, `unpriced_work` ≤30 × 1,000, `testing_advice` ≤10 × 1,000
  characters. The server removes any sentence stating a price, writes all prices and mandatory wording itself (Decimal math in
  `backend/claims.py`) and binds the result to a saved revision and proposal hash.
- **Limits:** thinking level LOW. REST deadline 55 s, 5 s reserved to save. One attempt of 25 s, cancelled and retried once
  when at least 10 s remain; with less than 35 s left at start a single attempt gets all remaining time. Each retry logs
  `Vertex AI retry`.
- **Budget hooks:** 3 attempts a minute (`audit_attempt`, charged before the checks) and 60 a day (`audit`, charged only
  when no saved audit can be reused). A reusable audit makes no model call.
- **Evals:** `tests/test_audit_retry.py` (provider-free); the claim and document tests and the `verify_estimate_prompts.py`
  audit cases were removed with the first company's price book files (historical bar: three of three priced-extra cases); the
  `verify_estimate_batch3.py` real-service cases (health, evidence and open-extent) are historical too, since the script no longer imports. Every assertion had to hold.
- **Switch:** none.

### 5. Job summary

- **Code:** `job_insight()` in `backend/workspace_api.py`; prompt `JOB_SUMMARY_INSTRUCTIONS`.
- **Input:** text only: a fact pack built from verified records without customer name, address or rooms, and the list of
  allowed topics.
- **Output:** `JobSummary`: one to four topics from nine fixed names (`rooms`, `equipment`, `evidence`, `readiness`, `sizing`,
  `review`, `claim`, `delivery`, `monitoring`). The server writes every sentence; `validate_insight` rejects anything else
  (502). Cached by facts hash for 30 days.
- **Limits:** thinking level LOW; timeout 25 s; no retry.
- **Budget hooks:** 6 a minute, 60 a day (`job_summary`); a cached summary costs nothing.
- **Evals:** `tests/test_insights.py`; `scripts/verify_job_summaries.py` (default: 10 fixture packs, no model;
  `--live` is historical, since it imports `backend.main`: it required 5 of 5 summaries to pass the validator unchanged, then the owner read each).
- **Switch:** `AI_FEATURES=job_summary`.

### 6. Drying-watch summary

- **Code:** drying summary route in `backend/workspace_api.py`; prompt `DRYING_SUMMARY_INSTRUCTIONS`.
- **Input:** text only: monitoring facts without customer data and the deterministic room options.
- **Output:** `DryingSummary`: one or two `{room_index, trend, mention}` selections from fixed lists; the server renders every
  sentence and measurement; `validate_summary` rejects anything else (502).
- **Limits:** thinking level LOW; timeout 25 s; no retry.
- **Budget hooks:** 6 a minute, 60 a day (`drying_summary`); a stored summary costs nothing.
- **Evals:** `tests/test_drying_watch.py`; `scripts/verify_drying_summaries.py` (10 fixture packs, no model; `--live` was 5 of 5 and is historical, since it imports `backend.main`).
- **Switch:** `AI_FEATURES=drying_watch`.

### 7. Live walkthrough

- **Code:** the `/api/live` WebSocket relay in `backend/main.py`, `live_config()` in `backend/live_support.py`, prompts in
  `backend/prompts.py` (`live_prompt()`, `shot_list_instructions()`, readiness and shot-status updates, greeting trigger).
- **Input:** a system prompt (instructions, shot list, inspection JSON, claim details, and the saved shot and readiness
  status), then **audio** (16 kHz mono PCM, chunks of at most 64,000 bytes), **video** (JPEG frames of at most 512,000 bytes,
  one 640 px frame every 2 s from the phone), and text context updates (photo shot status, readiness) sent between replies.
- **Output:** spoken **audio** replies (voice `Charon`, 24 kHz) with input and output **transcriptions**. No tools, no function
  calls. Transcripts are suggestions; the technician's form is changed only through "Fill scope from walkthrough".
- **Limits:** context compression from 64,000 to 32,000 tokens, session resumption handles saved as checkpoints, a renewable
  60 s Firestore lease allows one session per user, first message within 10 s and 16,384 bytes, relay connection up to
  3,600 s (Cloud Run), access rechecked every 20 s.
- **Budget hooks:** 40 new (non-resumed) sessions a day (`live`); no per-minute limit; the lease limits concurrency.
  Counters in the final `Live session ended` log line contain no content.
- **Evals:** `tests/test_live*.py` and `test_late_transcript_gate.py` (fakes; legacy Python suite, retired from CI on 2026-11-10);
  real service: `scripts/verify_live_reliability.py` (direct Vertex session longer than 120 s with a resumption handle). The live
  release verifier `verify_live_release.py` (ready packet, audio and transcript seen, checkpoint saved and resumed; `--readiness-audio`:
  three of three replies ask for exactly one listed gap and claim neither completion nor a block) was removed from the repository,
  so that check and its three-of-three bar are historical. No automated latency threshold exists.
- **Switch:** none for Live itself. `AI_FEATURES=readiness` adds the readiness text to the prompt.

## Budget and evaluation status

- **Spend budget:** a shared per-company monthly AI allowance applies to every path above ([ai-spending.md](ai-spending.md)),
  beside the per-user per-minute and daily counts. `ai_usage` reports those counts per company and enforces nothing.
- **Gating evals:** no numeric score or threshold gates a release. The thresholds that exist are exact-match assertions in
  the hand-run real-service scripts and the fixed pass bars named above (job and drying summaries 5 of 5 in their historical `--live` mode; the readiness 3 of 3 bar belonged to the removed live release verifier).
  The earlier priced-extra audit bar (3 of 3) is historical: its cases were removed with the first company's price book
  files. The legacy Python suite is retired from CI (2026-11-10); the DryScope rebuild's provider-free tests run in CI, and
  real-service checks are run by hand and recorded apart from mock tests. Physical iPhone, Bluetooth, interruption, reconnect and sub-second latency stay open until observed on a device.
- **Known gap:** `scripts/verify_estimate_batch3.py` calls `generate()` without the `operation` and `inspection_id`
  arguments the function now requires, and it imports the removed `backend/adr_price_book.py`, so it stops at import before
  reaching the model. It is a protected script;
  the port's parity run needs its cases rewritten against the new signature with the owner's approval.

## Pinned prompts and requests

The tables below are the machine-checked part (see [How this file is kept true](#how-this-file-is-kept-true)). Keep the
header cells exactly as they are.

### Pinned prompts

| Prompt id | Source | sha256 of the UTF-8 text |
| --- | --- | --- |
| `live.instructions` | backend/prompts.py LIVE_INSTRUCTIONS with shot_list_instructions() | `8406410718c6958a263c92cf776e96eead00eb25de84d0cd70a846bf8761efe6` |
| `live.readiness_instructions` | backend/prompts.py READINESS_INSTRUCTIONS | `3133b7daaa0cdc63eefdbd45df6f5935259f98cca857a31d3626dbec524ea1e0` |
| `live.readiness_update` | backend/prompts.py READINESS_UPDATE | `53530824f8881c3b09608fbee5dd4c40682103c383cd15419ce932895223da7c` |
| `live.shot_status_update` | backend/prompts.py SHOT_STATUS_UPDATE | `c514c28b9ee22cfe383d9801466f20e4d61bc75e82b6112a0b0b226b409d0bb6` |
| `live.greeting_trigger` | backend/prompts.py GREETING_TRIGGER | `9563a456f3ed369a745e501aab72e6f5eece5b84282744bfa060a5a8bbff8cff` |
| `shared.company_identity` | backend/prompts.py company_instructions() suffix | `d5c6e66a38ceea64f8dfe87b0bf17d8ea21fb2ddac76d6dce86b53759822adca` |
| `audit.instructions` | backend/prompts.py AUDIT_INSTRUCTIONS | `76851f0517d0703a069788039edcc5b236aa55f88dfe82680d08577b0c655ae3` |
| `audit.age_rule_pre_1978` | backend/prompts.py audit_prompt() year < 1978 line | `e43fadebb6436300a6b06aca78959da2eb0f4b6ffc9dbba444ee3f0074d8ed3b` |
| `audit.age_rule_1978_plus` | backend/prompts.py audit_prompt() year >= 1978 line | `9995a9f89dde3cee81042f49d09d519c94bfa298a444403af3f7576ae597d670` |
| `ocr.instructions` | backend/prompts.py OCR_INSTRUCTIONS | `b3f0d443ed6db0c83b405aaa4208d59cb11e6223084617b8bd8af65583213758` |
| `transcribe.instructions` | backend/prompts.py TRANSCRIBE_INSTRUCTIONS | `b010bead4a2cf8d78c5d030179c77992309491ec6deafe3b48b62ad138d02e27` |
| `scope.instructions` | backend/scope.py scope_prompt() text | `c29744e89edb52848c918c9877855232302097aa1f9c32da0a08673224c4214e` |
| `scope.claim_details` | backend/scope.py CLAIM_PROMPT | `6217cbcd8cb85ba265ab93be384e4ddbbe44a10d8a52fc5219a2a0ae63edb0b5` |
| `job_summary.instructions` | backend/prompts.py JOB_SUMMARY_INSTRUCTIONS | `6331da95053400e752abe1081e59dedf4103d89f64fbc42d1be34c08589152d4` |
| `drying_summary.instructions` | backend/prompts.py DRYING_SUMMARY_INSTRUCTIONS | `097f609f773dd068ffde7a2d7f4753c31e94da5241799267d216ee91fe15ad6a` |

### Pinned requests

These two tables are read by `tests/test_ai_inventory.py`, which drives every call path through its real route (and the Live relay through its real WebSocket) with a recording stand-in for the Gen AI client, and compares what was actually emitted: model, client, config, parts, response schema (full SHA-256 of the schema content), quota charges and the prompt text with server-added JSON data lines replaced by `<json>`.

| Request id | sha256 of the normalized emitted text |
| --- | --- |
| `audit_1978_plus.request` | `d7bf7b5fdd2c0d27d6e87414afc37f46b1f6de377c36139f9a2342b3e4b9e576` |
| `audit_company.request` | `1cac7780dfd0e09eecde9b2509afd664fe0c3b200098892a8c998a2b58f88a15` |
| `audit_pre_1978.request` | `9559ab6f53d25b5a4df490f596793cd06c4126dcfc4bd4ed8f8ee0c858b3f68a` |
| `drying_summary.request` | `53efffe99a2aa706213dc9db8422929e7f0ccc033c9dd03651f11e69e3a66a2a` |
| `job_summary.request` | `de7ef9921761fd4ff76c62f20d0a4bfef951e85fab46235b0590321bd5b97d49` |
| `live.greeting` | `9563a456f3ed369a745e501aab72e6f5eece5b84282744bfa060a5a8bbff8cff` |
| `live.shot_update` | `df0a3e1c96cffba6a86bd58d00ede6244e023684b5f0f6e9d81365c6feb55924` |
| `live.system_instruction` | `928155bb367d6adf51d863b89261ef2a807c1be8add7f98fb82d3c283cc4eea7` |
| `ocr.request` | `b3f0d443ed6db0c83b405aaa4208d59cb11e6223084617b8bd8af65583213758` |
| `scope.request` | `436fc930b0954b7924c21aba4e0f0c36b1f8df0269c8a4c08ac4d6a0bfbdd15b` |
| `scope_with_claim.request` | `52da5f5227114e2712cea2e49e38ff90d1f03bbf2aed7c6b880b20a0970815af` |
| `transcribe.request` | `b010bead4a2cf8d78c5d030179c77992309491ec6deafe3b48b62ad138d02e27` |

| Observed setting | Observed value |
| --- | --- |
| `ai_features.parse` | `unset -> []; ' Job_Summary,,readiness ' -> ['job_summary', 'readiness']` |
| `call.audit_1978_plus` | `model=gemini-3.8-flash; thinking=LOW; timeout=25; response=application/json AIResult; parts=text` |
| `call.audit_company` | `model=gemini-3.8-flash; thinking=LOW; timeout=25; response=application/json AIResult; parts=text, image/jpeg; image=JPEG 120x60` |
| `call.audit_pre_1978` | `model=gemini-3.8-flash; thinking=LOW; timeout=25; response=application/json AIResult; parts=text, image/jpeg; image=JPEG 1600x1200` |
| `call.drying_summary` | `model=gemini-3.8-flash; thinking=LOW; timeout=25; response=application/json DryingSummary; parts=text` |
| `call.job_summary` | `model=gemini-3.8-flash; thinking=LOW; timeout=25; response=application/json JobSummary; parts=text` |
| `call.ocr` | `model=gemini-3.8-flash; thinking=provider default; timeout=50; response=application/json OcrResult; parts=image/jpeg, text; image=JPEG 1600x1200` |
| `call.scope` | `model=gemini-3.8-flash; thinking=LOW; timeout=50; response=application/json wire schema; parts=text` |
| `call.scope_with_claim` | `model=gemini-3.8-flash; thinking=LOW; timeout=50; response=application/json wire schema; parts=text` |
| `call.transcribe` | `model=gemini-3.8-flash; thinking=LOW; timeout=50; response=application/json TranscriptionResult; parts=audio/mp4, text` |
| `client.live` | `enterprise=True; project=alert-disaster-field-2026; location=us-central1; http_timeout_ms=95000` |
| `client.rest` | `enterprise=True; project=alert-disaster-field-2026; location=global; http_timeout_ms=95000` |
| `deploy.AI_FEATURES` | `default deploy sets 'readiness'; choose from ai_usage, drying_watch, estimate_assist, job_summary, priced_extras, readiness, or none` |
| `inspection_store.TRANSCRIPT_LIMIT` | `80000` |
| `live.connect` | `model=gemini-3.8-live; config={"context_window_compression": {"sliding_window": {"target_tokens": 32000}, "trigger_tokens": 64000}, "input_audio_transcription": {}, "output_audio_transcription": {}, "response_modalities": ["AUDIO"], "session_resumption": {}, "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": "Charon"}}}}` |
| `live.greeting.turn_complete` | `True` |
| `live.shot_update.turn_complete` | `False` |
| `main.AUDIT_ATTEMPT_SECONDS` | `25` |
| `main.AUDIT_PHOTO_DOWNLOADS` | `6` |
| `main.AUDIT_RETRY_MIN_SECONDS` | `10` |
| `main.AUDIT_SAVE_RESERVE_SECONDS` | `5` |
| `main.LIVE_RECHECK_SECONDS` | `20` |
| `main.LIVE_REPLY_WAIT_SECONDS` | `5` |
| `main.REST_DEADLINE_SECONDS` | `55` |
| `main.VOICE_NOTE_BYTES` | `10485760` |
| `quota.audit` | `no per-minute limit, 60 a day` |
| `quota.audit_attempt` | `3 a minute, no daily limit` |
| `quota.drying_summary` | `6 a minute, 60 a day` |
| `quota.job_summary` | `6 a minute, 60 a day` |
| `quota.live` | `no per-minute limit, 40 a day` |
| `quota.ocr` | `20 a minute, 400 a day` |
| `quota.scope` | `6 a minute, 120 a day` |
| `quota.transcribe` | `10 a minute, 200 a day` |
| `schema.audit_1978_plus` | `3e393c2353600538f286f7bdce5086b13c0a9a6a04550ce7605a4b5fc0d332b3` |
| `schema.audit_company` | `3e393c2353600538f286f7bdce5086b13c0a9a6a04550ce7605a4b5fc0d332b3` |
| `schema.audit_pre_1978` | `3e393c2353600538f286f7bdce5086b13c0a9a6a04550ce7605a4b5fc0d332b3` |
| `schema.drying_summary` | `452d3a84f64cd6f71bc6eca6be465b6d3b6340ea73d7625fe7d49bc508497727` |
| `schema.job_summary` | `e9cc36472e07723935f19aa746c78dc52dca1789da0857b46c300c8b2ed7ac70` |
| `schema.ocr` | `9f710594b5a03a7bd046fc5c872c07e7308d0bca29d5a06c147860f703cec650` |
| `schema.scope` | `7033facf7ebfa5bde048a47305a1dfbef73e3e092c5e2c1b71858d2fa71a656e` |
| `schema.scope_with_claim` | `7033facf7ebfa5bde048a47305a1dfbef73e3e092c5e2c1b71858d2fa71a656e` |
| `schema.transcribe` | `a0cc4f83b9dd9a9614909a0064dba4eb61f9ffefc7bd1d8c85d0c92fc38404df` |

## AI modality coverage contract

This is the contract the TypeScript port must meet for Model Armor screening, from section 5 of the rebuild plan
(`dry-standard-replan`, stage S1, accepted by the owner). It describes the target. **Today no call is screened:** the code
has no Model Armor integration, so every row below is a requirement for the port, not a description of the Python backend.
Text and supported images are screened; raw audio and video are not, because Model Armor cannot inspect them.

| Path | Treatment | Limit or activation gate |
| --- | --- | --- |
| Text prompt to scope, audit, job summary or drying summary | Screen the complete prompt and context before generation; screen the generated text before storing, showing or using it; validate the output against its schema; keep human approval | A timeout, a failed or skipped required filter, or an unsupported payload is not an allow verdict: retry within the deadline or leave the feature unavailable |
| Live system prompt and text context updates | Screen before opening or updating the session, including field notes and shot context, not only the static instruction | Never log content to demonstrate coverage |
| Live user transcript | Feed the input transcription to streaming screening; also screen each completed utterance and the full accepted transcript before scope or audit reuse | Gemini has already heard the audio: this is detection and downstream containment, not protection before input |
| Live assistant text replies and captions | Screen text before it is shown or saved as accepted; track generation and turn ids so a stale verdict cannot approve later text | Chunk screening can miss meaning split across chunks, so complete-utterance screening supplements it |
| Still photos for OCR and audit | Screen each image separately and the text separately, then send the approved exact bytes and prompt | JPEG, PNG or BMP, at most 4 MB, one image per request, `us` or `eu` multi-region only, currently Preview; mixed text-and-image screening is unsupported; R3 decided 2026-11-12 (S7 decision V3 C): the `us` multi-region template is used |
| **Raw audio and video (Live spoken replies, Live camera stream, offline recorded voice notes)** | **Not screened.** If approved: unscreened audio and video are allowed only in their narrow form, with streamed text screening, stop and quarantine on a bad verdict, no Live business tools, and transcription-only processing for recorded voice notes with the transcript screened before it is accepted or reused | **PENDING OWNER DECISION R2 at the S1 baseline; since decided, 2026-11-12 (S7 decision V1 B, [S7 plan](plans/S7.md) section 8):** the narrow form above is approved for S7, with no camera frames (V7 A). Never claim all speech is blocked before playback, or sub-second latency, without observation |

Rules that hold for the R2 and R3 decisions:

- Screening is an explicit step in the TypeScript AI boundary for every supported payload; it is not assumed from a project setting.
- A call that cannot be screened is not allowed by default; manual capture and pricing keep working with AI off.
- An adverse verdict on Live stops playback and the upstream session, discards queued output and the checkpoint, and needs a
  clean restart; the affected transcript is not reused by later AI calls.
- Durable data stays central: the port's active app and data are in `us-central1`; the existing `us-west2` Firestore and evidence bucket are the legacy source. Any AI processing exception is recorded honestly.
- Image screening in the `us` multi-region and the Preview status of image screening were owner decisions (R3), decided 2026-11-12 as S7 decision V3 C, separate from R2.

Source: Model Armor [overview](https://docs.cloud.google.com/model-armor/overview),
[locations](https://docs.cloud.google.com/model-armor/locations) and
[streaming sanitization](https://docs.cloud.google.com/model-armor/sanitize-prompts-responses), as read for the plan on
2026-11-06. Re-check them before building; the plan says streaming text screening became generally available on 2026-07-10.
