# AI inventory and parity baseline

Every place the current Python backend calls a model, written down so the TypeScript port can be proven equal to it.
Stage S1 of the rebuild pins today's behaviour; it changes no prompt, model, limit or switch. Read
[AI.md](AI.md) first for the rules that apply to all AI features; this file is the detailed, checked
inventory behind it.

**State:** `master` after pull request #229, Python backend, no Model Armor.

## How this file is kept true

- The two tables under [Pinned prompts](#pinned-prompts) and [Pinned settings](#pinned-settings) are read by
  `tests/test_ai_inventory.js` (run by `npm test`). The test runs `scripts/ai_inventory_facts.py`, hashes each prompt text
  with SHA-256 over its UTF-8 bytes, and fails with the id and the new hash if any prompt, model default, region,
  thinking level, timeout, quota or Live setting differs from the table, or if one is added or removed.
- A prompt, model or limit change is therefore a visible two-file change. To update after an intended change run
  `python3 scripts/ai_inventory_facts.py --table`, paste the rows, and say in the pull request why the behaviour should change.
  The port must leave every hash unchanged: a port that "improves" a prompt fails this test on purpose.
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
No call sets a maximum output token count, a temperature or a tool list; output size is bounded only by the schemas below
and by the thinking level. Application-level safety today is prompt labelling of untrusted data, schema validation, size
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
- **Limits:** thinking level provider default; call timeout 100 s inside the 55 s REST deadline; no retry.
- **Budget hooks:** 20 a minute, 400 a day (`ocr`). `Vertex AI call` log line with model, operation, time and outcome only.
- **Evals:** none in CI beyond fakes (`tests/test_image_handling.py`, `tests/test_backend.py`). Real-service check: the
  `ocr_case` in `scripts/verify_estimate_batch3.py` (non-meter image must give `meter_detected=false` and an empty value).
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
- **Limits:** thinking level LOW; timeout 100 s inside the 55 s REST deadline; no retry. Staged check on 2026-10-13: 10 calls
  at most 4.5 s, median 2.6 s (comment in `backend/main.py`).
- **Budget hooks:** 6 a minute, 120 a day (`scope`).
- **Evals:** `tests/test_scope.py` (provider-free); real service: `scripts/verify_scope_extraction.py`,
  `verify_estimate_prompts.py` (`extract` cases) and `verify_estimate_batch3.py` (`scope_case`). Each case must match the
  expected `(room, field) → value` map exactly.
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
- **Evals:** `tests/test_audit_retry.py`, `tests/test_claims.py` with `tests/golden/v1-documents.json` (provider-free);
  real service: `verify_estimate_prompts.py` (`audit_specialty`, `audit_priced_extra` run three times, `audit_cleaning_only`)
  and `verify_estimate_batch3.py` (health, evidence and open-extent cases). All assertions must hold; the priced-extra case
  must pass 3 of 3.
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
  `--live`: 5 of 5 summaries pass the validator unchanged, then the owner reads each).
- **Switch:** `AI_FEATURES=job_summary`.

### 6. Drying-watch summary

- **Code:** drying summary route in `backend/workspace_api.py`; prompt `DRYING_SUMMARY_INSTRUCTIONS`.
- **Input:** text only: monitoring facts without customer data and the deterministic room options.
- **Output:** `DryingSummary`: one or two `{room_index, trend, mention}` selections from fixed lists; the server renders every
  sentence and measurement; `validate_summary` rejects anything else (502).
- **Limits:** thinking level LOW; timeout 25 s; no retry.
- **Budget hooks:** 6 a minute, 60 a day (`drying_summary`); a stored summary costs nothing.
- **Evals:** `tests/test_drying_watch.py`; `scripts/verify_drying_summaries.py` (10 fixture packs, no model; `--live` 5 of 5).
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
- **Evals:** `tests/test_live*.py` and `test_late_transcript_gate.py` (fakes); real service: `scripts/verify_live_release.py`
  (ready packet, audio and transcript seen, checkpoint saved and resumed; `--readiness-audio`: three of three replies ask for
  exactly one listed gap and claim neither completion nor a block) and `scripts/verify_live_reliability.py` (direct Vertex
  session longer than 120 s with a resumption handle). No automated latency threshold exists.
- **Switch:** none for Live itself. `AI_FEATURES=readiness` adds the readiness text to the prompt.

## Budget and evaluation status

- **Spend budget:** none today. The only controls are the per-user per-minute and daily counts above. `ai_usage` reports the
  sum of those counts per company and enforces nothing; a per-company monthly cap is the open pull request #230.
- **Gating evals:** no numeric score or threshold gates a release. The thresholds that exist are exact-match assertions in
  the hand-run real-service scripts and the fixed pass bars named above (job and drying summaries 5 of 5, readiness 3 of 3,
  priced-extra audit 3 of 3). Provider-free tests run in CI; real-service checks are run by hand and recorded apart from
  mock tests. Physical iPhone, Bluetooth, interruption, reconnect and sub-second latency stay open until observed on a device.
- **Known gap:** `scripts/verify_estimate_batch3.py` calls `generate()` without the `operation` and `inspection_id`
  arguments the function now requires, so it fails with a `TypeError` before reaching the model. It is a protected script;
  the port's parity run needs its cases rewritten against the new signature with the owner's approval.

## Pinned prompts and settings

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

### Pinned settings

| Setting | Value in code |
| --- | --- |
| `ai_features.default` | `os.getenv('AI_FEATURES', '') split on commas; empty enables nothing` |
| `call.audit` | `backend/main.py: model=AUDIT_MODEL; thinking=AUDIT_THINKING_LEVEL; timeout=timeout` |
| `call.drying_watch` | `backend/workspace_api.py: model=bm.AUDIT_MODEL; thinking='LOW'; timeout=25` |
| `call.job_summary` | `backend/workspace_api.py: model=bm.AUDIT_MODEL; thinking='LOW'; timeout=25` |
| `call.ocr` | `backend/main.py: model=OCR_MODEL; thinking=provider default; timeout=default 100` |
| `call.scope` | `backend/main.py: model=AUDIT_MODEL; thinking=SCOPE_THINKING_LEVEL; timeout=default 100` |
| `call.transcribe` | `backend/main.py: model=AUDIT_MODEL; thinking=SCOPE_THINKING_LEVEL; timeout=REST_DEADLINE_SECONDS - 5` |
| `deploy_backend.py:DEFAULT_AI_FEATURES` | `'readiness'` |
| `deploy_backend.py:KNOWN_AI_FEATURES` | `frozenset({'readiness', 'drying_watch', 'priced_extras', 'job_summary', 'ai_usage', 'estimate_assist'})` |
| `inspection_store.py:DAILY_LIMITS` | `{'ocr': 400, 'scope': 120, 'transcribe': 200, 'audit': 60, 'job_summary': 60, 'drying_summary': 60, 'live': 40}` |
| `inspection_store.py:TRANSCRIPT_LIMIT` | `80000` |
| `job_store.py:MODEL_PIXELS` | `1600` |
| `live_config.fields` | `response_modalities, input_audio_transcription, output_audio_transcription, speech_config, context_window_compression, session_resumption, system_instruction` |
| `live_config.response_modalities` | `['AUDIO']` |
| `live_config.target_tokens` | `32000` |
| `live_config.trigger_tokens` | `64000` |
| `main.py:AUDIT_ATTEMPT_SECONDS` | `25` |
| `main.py:AUDIT_MODEL` | `os.getenv('AUDIT_MODEL', 'gemini-3.8-flash')` |
| `main.py:AUDIT_PHOTO_DOWNLOADS` | `6` |
| `main.py:AUDIT_RETRY_MIN_SECONDS` | `10` |
| `main.py:AUDIT_SAVE_RESERVE_SECONDS` | `5` |
| `main.py:AUDIT_THINKING_LEVEL` | `types.ThinkingLevel.LOW` |
| `main.py:LIVE_LOCATION` | `os.getenv('LIVE_LOCATION', 'us-central1')` |
| `main.py:LIVE_MODEL` | `os.getenv('LIVE_MODEL', 'gemini-3.8-live')` |
| `main.py:LIVE_RECHECK_SECONDS` | `20` |
| `main.py:LIVE_REPLY_WAIT_SECONDS` | `5` |
| `main.py:LIVE_VOICE` | `os.getenv('LIVE_VOICE', 'Charon')` |
| `main.py:LOCATION` | `os.getenv('GOOGLE_CLOUD_LOCATION', 'global')` |
| `main.py:OCR_MODEL` | `os.getenv('OCR_MODEL', AUDIT_MODEL)` |
| `main.py:REST_DEADLINE_SECONDS` | `55` |
| `main.py:SCOPE_THINKING_LEVEL` | `types.ThinkingLevel.LOW` |
| `main.py:VOICE_NOTE_BYTES` | `10 * MB` |
| `quota.audit` | `per-minute limit none` |
| `quota.audit_attempt` | `per-minute limit 3` |
| `quota.drying_summary` | `per-minute limit 6` |
| `quota.job_summary` | `per-minute limit 6` |
| `quota.live` | `per-minute limit none` |
| `quota.ocr` | `per-minute limit 20` |
| `quota.scope` | `per-minute limit 6` |
| `quota.transcribe` | `per-minute limit 10` |

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
| Still photos for OCR and audit | Screen each image separately and the text separately, then send the approved exact bytes and prompt | JPEG, PNG or BMP, at most 4 MB, one image per request, `us` or `eu` multi-region only, currently Preview; mixed text-and-image screening is unsupported; needs the image-residency decision R3 |
| **Raw audio and video (Live spoken replies, Live camera stream, offline recorded voice notes)** | **Not screened.** If approved: unscreened audio and video are allowed only in their narrow form, with streamed text screening, stop and quarantine on a bad verdict, no Live business tools, and transcription-only processing for recorded voice notes with the transcript screened before it is accepted or reused | **PENDING OWNER DECISION R2.** Until the owner decides, the plan's fail-closed default applies: these modalities stay off in the port. Never claim all speech is blocked before playback, or sub-second latency, without observation |

Rules that hold whichever way R2 and R3 are decided:

- Screening is an explicit step in the TypeScript AI boundary for every supported payload; it is not assumed from a project setting.
- A call that cannot be screened is not allowed by default; manual capture and pricing keep working with AI off.
- An adverse verdict on Live stops playback and the upstream session, discards queued output and the checkpoint, and needs a
  clean restart; the affected transcript is not reused by later AI calls.
- Durable data stays central (Firestore and the evidence bucket in `us-west2`); any AI processing exception is recorded honestly.
- Image screening in the `us` multi-region and the Preview status of image screening are owner decisions (R3), separate from R2.

Source: Model Armor [overview](https://docs.cloud.google.com/model-armor/overview),
[locations](https://docs.cloud.google.com/model-armor/locations) and
[streaming sanitization](https://docs.cloud.google.com/model-armor/sanitize-prompts-responses), as read for the plan on
2026-11-06. Re-check them before building; the plan says streaming text screening became generally available on 2026-07-10.
