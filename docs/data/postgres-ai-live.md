# Data: Rebuilt app Postgres: AI and Live tables

Part of [Data](../DATA.md).

`0012_ai_live_tables` adds every AI and Live table of stage S7 and the sweeper's lookup across companies
(S7-3, `docs/plans/S7.md`); it is S7's one database job, and no route uses the tables until S7-4 to S7-15. The
eight tables hold a company's rows only inside `withCompany`, with forced row-level security; every key
between rows carries `company_id`, and the runtime has no `DELETE` or `TRUNCATE` on any of them. Money is
whole micro-USD of Google's bill (`bigint`, at most 2^53 - 1). Feature, model, end-reason and verdict-category
names are checked for shape only; their closed lists stay in code (`web/src/lib/ai/`). The Drizzle view is
`web/src/db/ai-schema.ts`.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `company_ai_settings` | One optional row per company: `daily_ceiling_micro_usd` and `monthly_ceiling_micro_usd` (empty means the code default, $10 a day and $200 a month, V5 B, `web/src/lib/ai/ceilings.ts`; daily at most monthly), `ceilings_set_by_operator_id`, `ceilings_set_at`, `default_voice` (one capitalised word; the allowlist is in code), `default_voice_set_by_actor_id`, `default_voice_set_at` | `SELECT`; `INSERT` and `UPDATE` of the ceiling and voice columns. Only an active platform operator, stamped with its own id, may set ceilings, and it may set nothing else; a company member may set the voice only (a trigger enforces both). The times come from the database clock |
| `ai_ledger` | Each AI reservation, keyed `(company_id, id)`, one per `call_id`: `actor_id`, `feature`, `model`, `reserved_micro_usd`, `settled_micro_usd` (set exactly when settled), `state` (`reserved`, `held`, `settled`), `utc_day`, `utc_month` (the first day of that day's month), `settled_at` | `SELECT`, `INSERT`, and `UPDATE` of `state` and `settled_micro_usd` only |
| `ai_results` | One AI proposal per call (`call_id` names a ledger row of the same company): `job_id`, `draft_id`, `actor_id`, `feature`, `input_digest`, `prompt_version` (SHA-256 of the prompt file), `model`, `output` (a JSON object, at most 256 KiB), `verdict_category`, `status` (`proposed`, `accepted`, `rejected`), `decided_by_actor_id`, `decided_at` | `SELECT`, `INSERT`, and `UPDATE` of `status` and `decided_by_actor_id` only |
| `live_sessions` | One walkthrough, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `draft_id`, `actor_id`, `voice`, `language`, `started_at`, `ended_at` and `end_reason` (set together), `epoch`, `lease_expires_at` (set exactly while open), `capability_sha256`, `resumption_handle` (server-only, never logged; empty once ended), `handle_counter`, `covered_seq`, `next_turn_seq`, `restarts` (0 to 3), `signed_in_at`, `scope_fingerprint`, `reservation_id` (a ledger row of the same company, one session each) | `SELECT`, `INSERT`, and `UPDATE` of the end, epoch, lease, capability, handle, counter, sequence, restart and sign-in-time columns only |
| `live_usage` | The highest cumulative cost posted per `(company_id, session_id, epoch, connection)`: `max_cumulative_micro_usd`, `last_posted_at` (the database clock at each post), `closed` | `SELECT`, `INSERT`, and `UPDATE` of `max_cumulative_micro_usd` and `closed` only |
| `live_turns` | The screened transcript, keyed `(company_id, session_id, seq)`: `epoch`, `connection`, `speaker` (`technician`, `assistant`, `system`), `text` (at most 20,000 characters), `verdict` (`passed`, `blocked`, `unscreened`), `verdict_category` | `SELECT`, `INSERT`; never changed or removed |
| `voice_notes` | A voice note's transcript, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `draft_id`, `actor_id`, `duration_ms` (at most ten minutes), `audio_sha256` (the audio itself is not kept, V8), `transcript` (at most 20,000 characters), `state` (`transcribed`, `reviewed`, `rejected`), `reviewed_by_actor_id`, `reviewed_at` | `SELECT`, `INSERT`, and `UPDATE` of `state`, `transcript` and `reviewed_by_actor_id` only |
| `member_voice_settings` | A person's own Live voice: `(company_id, actor_id)`, `voice_name`, `updated_at` (the database clock) | `SELECT`; `INSERT`, and `UPDATE` of `voice_name` only |

- One open session per person: a partial unique key on `(company_id, actor_id)` where `ended_at` is empty,
  the backstop to the admit transaction's lock on the person's membership row (S7-11). An ended session never
  changes again (a trigger), so it cannot be reopened or settled twice.
- A ledger row is made `reserved`; it moves to `held` (outcome unknown) or `settled` (with its real cost, which
  may be above or below the reservation), and a held row only to `settled`. A settled row never changes, and a
  row's reservation, call, person, feature, model and days never change (a trigger).
- An AI result is made `proposed` and a person moves it once to `accepted` or `rejected`; its output and the
  rest of the proposal never change (a trigger), and a decided result is frozen.
- A connection's `max_cumulative_micro_usd` only goes up, a connection is closed once, and a closed one never
  changes (a trigger). The session's cost is the sum over its connections and epochs.
- A turn never changes, not even by the table owner (a trigger). Only a `passed` turn keeps its words, with the
  category `passed`; a `blocked` or `unscreened` turn keeps its category and no text.
- A voice note is made `transcribed`; it is `reviewed` by a person (with the technician's edit of the
  transcript) or `rejected` (by a person, or by the server for a screened-out transcript) once, and then never
  changes. Its recording's id, job, length and hash never change.
- `live_session_due_companies(max_companies)` is the sweeper's one lookup across companies, on the 0005 pattern:
  it returns company ids only, runs as the table owner with a setting that one SELECT policy needs, and only
  the runtime may call it. A company is due when it has an open session whose lease has lapsed. Size 1 to 100.
- Personal data: `live_turns.text`, `voice_notes.transcript` and `ai_results.output` (the technician's words
  and the model's text about the job, which may name people or places). `resumption_handle` is a secret of the
  server. The other columns hold ids, hashes, amounts, names from fixed lists and times. Logs and audit details
  hold ids and counts only.
- A platform operator reads a company's rows through `withOperator` with that company set; every write policy
  refuses an active operator, except the operator's own ceiling write on `company_ai_settings`.
