-- AI and Live tables (S7-3, docs/plans/S7.md): the one database job of stage S7. Every S7 table is
-- here, so S7-4 to S7-17 change no schema. This file only adds; nothing in 0001 to 0011 changes. No
-- route reads or writes any of it yet.
--
-- 1. company_ai_settings: a company's daily and monthly AI ceilings and its default Live voice. No
--    row, or an empty column, means the code default (web/src/lib/ai/ceilings.ts: $10 a day and $200
--    a month, owner decision V5 B; the voice Charon, V6). Only the platform operator sets ceilings
--    (S7-4, audited); a company member (the owner, through the profile route, S7-15) sets the voice
--    only. Test companies' ceilings are explicit rows the owner has the operator write (step H).
-- 2. ai_ledger: every AI reservation and its settlement, in whole micro-USD of Google's bill, per UTC
--    day and month. One row per call id. Made `reserved`; it moves to `settled` (with its real cost)
--    or to `held` (outcome unknown), and a held row only to `settled`. A settled row never changes.
-- 3. ai_results: the AI proposals. One per call, and only for a call the ledger holds. Made
--    `proposed`; a person moves it once to `accepted` or `rejected`. The proposal itself never changes.
-- 4. live_sessions: one walkthrough's state outside the relay (docs/plans/S7.md section 4): its job,
--    draft, person, voice and language, the epoch fence, the lease, the session capability's SHA-256,
--    the resumption handle (server-only, never logged) and its counter, the phone sequence the handle
--    covers, the next turn number, restarts, the sign-in time, the draft's scope fingerprint and the
--    ledger reservation. One open session per person (a partial unique key, the backstop to the admit
--    lock). An ended session never changes.
-- 5. live_usage: the highest cumulative cost posted per (session, epoch, connection). It only goes
--    up, and is closed once; a closed connection never changes. The session's cost is the sum.
-- 6. live_turns: the screened transcript, insert-only. Only a `passed` turn keeps its words; a
--    `blocked` or `unscreened` turn keeps its verdict category and no text.
-- 7. voice_notes: a voice note's transcript (the audio is never stored, V8). Made `transcribed`; it
--    is reviewed (with the technician's edit) or rejected once, and never changes after.
-- 8. member_voice_settings: a person's own Live voice (V6 C).
-- 9. live_session_due_companies(max): the sweeper's one lookup across companies, on the 0005 pattern.
-- 10. Every row belongs to a company and is held only inside withCompany (0003). A platform operator
--    reads a company's rows through withOperator with that company set, and every write policy
--    refuses an active operator, except the ceiling write in 1. Every key between rows carries
--    company_id, so a row can never point at another company's job, person, call or session.
-- 11. Nothing here is removed by the runtime: no DELETE and no TRUNCATE on any table.
--
-- Feature, model, end-reason and verdict-category names are checked for shape only; their closed
-- lists stay in code (web/src/lib/ai/registry.ts, pricing.ts, codes.ts), as 0008 keeps flag names,
-- so a new model or reason needs no migration. Money is bigint micro-USD, at most 2^53 - 1 so it
-- reads exactly as a JavaScript number.

-- 1. AI settings.
CREATE TABLE company_ai_settings (
  company_id uuid PRIMARY KEY REFERENCES companies (id),
  daily_ceiling_micro_usd bigint CHECK (daily_ceiling_micro_usd BETWEEN 0 AND 9007199254740991),
  monthly_ceiling_micro_usd bigint CHECK (monthly_ceiling_micro_usd BETWEEN 0 AND 9007199254740991),
  -- Which operator last set the ceilings, and when (the time from the trigger below).
  ceilings_set_by_operator_id uuid REFERENCES platform_admins (actor_id),
  ceilings_set_at timestamptz,
  -- One of Google's prebuilt voice names (the allowlist of 30 is in code, S7-15).
  default_voice text CHECK (default_voice ~ '^[A-Z][a-z]{2,29}$'),
  default_voice_set_by_actor_id uuid,
  default_voice_set_at timestamptz,
  CONSTRAINT company_ai_settings_default_voice_set_by_fkey FOREIGN KEY (company_id, default_voice_set_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT company_ai_settings_ceilings_stamp_check CHECK ((ceilings_set_by_operator_id IS NULL) = (ceilings_set_at IS NULL)),
  CONSTRAINT company_ai_settings_voice_stamp_check CHECK ((default_voice_set_by_actor_id IS NULL) = (default_voice_set_at IS NULL)),
  CONSTRAINT company_ai_settings_daily_within_monthly_check CHECK (
    daily_ceiling_micro_usd IS NULL OR monthly_ceiling_micro_usd IS NULL OR daily_ceiling_micro_usd <= monthly_ceiling_micro_usd
  )
);

-- 2. The spend ledger. The call id is the AI boundary's (a client call id where the route has one),
-- so a retried reservation or settlement finds its row.
CREATE TABLE ai_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  call_id uuid NOT NULL,
  -- The person the call was made for: the caller, or the walkthrough's technician.
  actor_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]{0,39}$'),
  model text NOT NULL CHECK (model ~ '^[a-z][a-z0-9.-]{0,63}$'),
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd BETWEEN 0 AND 9007199254740991),
  -- The real cost, set exactly when settled; it may be above or below the reservation.
  settled_micro_usd bigint CHECK (settled_micro_usd BETWEEN 0 AND 9007199254740991),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'held')),
  -- The UTC day the reservation counts against, and its month (the first day of that month).
  utc_day date NOT NULL,
  utc_month date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the trigger below when the row settles.
  settled_at timestamptz,
  PRIMARY KEY (company_id, id),
  CONSTRAINT ai_ledger_company_call_key UNIQUE (company_id, call_id),
  CONSTRAINT ai_ledger_actor_fkey FOREIGN KEY (company_id, actor_id) REFERENCES actors (company_id, id),
  CONSTRAINT ai_ledger_month_check CHECK (utc_month = date_trunc('month', utc_day)::date),
  CONSTRAINT ai_ledger_settled_check CHECK (
    (state = 'settled') = (settled_micro_usd IS NOT NULL) AND (state = 'settled') = (settled_at IS NOT NULL)
  )
);

-- A company's spend for a day or a month, and what is still reserved or held.
CREATE INDEX ai_ledger_company_day ON ai_ledger (company_id, utc_day);
CREATE INDEX ai_ledger_company_month ON ai_ledger (company_id, utc_month);
CREATE INDEX ai_ledger_unsettled ON ai_ledger (company_id, created_at) WHERE state <> 'settled';

-- 3. AI results: one proposal per call.
CREATE TABLE ai_results (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  call_id uuid NOT NULL,
  job_id uuid NOT NULL,
  -- The Firestore field draft the proposal was made from (not a table here).
  draft_id uuid NOT NULL,
  -- The person who asked for it.
  actor_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- SHA-256 of the model input, and the prompt version (the SHA-256 of the prompt file).
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[0-9a-f]{64}$'),
  model text NOT NULL CHECK (model ~ '^[a-z][a-z0-9.-]{0,63}$'),
  -- The Zod-checked output, at most 256 KiB as text.
  output jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object' AND octet_length(output::text) <= 262144),
  -- Model Armor's verdict on the output (web/src/lib/ai/codes.ts).
  verdict_category text NOT NULL CHECK (verdict_category ~ '^[a-z][a-z_]{0,39}$'),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected')),
  decided_by_actor_id uuid,
  -- Set by the trigger below when the proposal is decided.
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT ai_results_company_call_key UNIQUE (company_id, call_id),
  CONSTRAINT ai_results_call_fkey FOREIGN KEY (company_id, call_id) REFERENCES ai_ledger (company_id, call_id),
  CONSTRAINT ai_results_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT ai_results_actor_fkey FOREIGN KEY (company_id, actor_id) REFERENCES actors (company_id, id),
  CONSTRAINT ai_results_decided_by_fkey FOREIGN KEY (company_id, decided_by_actor_id) REFERENCES actors (company_id, id),
  CONSTRAINT ai_results_decided_check CHECK (
    (status = 'proposed') = (decided_by_actor_id IS NULL) AND (status = 'proposed') = (decided_at IS NULL)
  )
);

-- A job's proposals, newest first.
CREATE INDEX ai_results_job ON ai_results (company_id, job_id, created_at DESC);

-- 4. Live sessions. The id is made on the phone (the client session id), so a retried admit finds
-- its row.
CREATE TABLE live_sessions (
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  -- The voice and language the session was admitted with; a later voice change applies from the
  -- next session only (V6).
  voice text NOT NULL CHECK (voice ~ '^[A-Z][a-z]{2,29}$'),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}-[A-Z]{2}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text CHECK (end_reason ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- Bumped by every resume, quarantine and end; a call with an older epoch is refused (409).
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  -- Renewed by each heartbeat while the phone is there; released (empty) when the session ends.
  lease_expires_at timestamptz,
  -- SHA-256 of the random session capability; the capability itself is never stored.
  capability_sha256 text NOT NULL CHECK (capability_sha256 ~ '^[0-9a-f]{64}$'),
  -- Google's resumption handle: server-only, never logged, cleared by quarantine and end.
  resumption_handle text CHECK (char_length(resumption_handle) BETWEEN 1 AND 4096),
  -- Rises with each stored handle and survives GoAway, quarantine and resume.
  handle_counter bigint NOT NULL DEFAULT 0 CHECK (handle_counter >= 0),
  -- The highest phone frame sequence number the stored handle covers.
  covered_seq bigint NOT NULL DEFAULT 0 CHECK (covered_seq >= 0),
  next_turn_seq integer NOT NULL DEFAULT 1 CHECK (next_turn_seq >= 1),
  -- Clean restarts so far; the fourth ends the session instead.
  restarts integer NOT NULL DEFAULT 0 CHECK (restarts BETWEEN 0 AND 3),
  -- The member token's sign-in time, checked against the member's revocation time.
  signed_in_at timestamptz NOT NULL,
  -- SHA-256 of the draft's scope at admission (the old scope_fingerprint); a change ends the session.
  scope_fingerprint text NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The ledger row holding the session's reservation, settled when the session ends.
  reservation_id uuid NOT NULL,
  PRIMARY KEY (company_id, id),
  CONSTRAINT live_sessions_company_reservation_key UNIQUE (company_id, reservation_id),
  CONSTRAINT live_sessions_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT live_sessions_actor_fkey FOREIGN KEY (company_id, actor_id) REFERENCES actors (company_id, id),
  CONSTRAINT live_sessions_reservation_fkey FOREIGN KEY (company_id, reservation_id) REFERENCES ai_ledger (company_id, id),
  -- Ended exactly when it says why; an open session holds a lease and an ended one holds no lease
  -- and no handle.
  CONSTRAINT live_sessions_end_check CHECK (
    (ended_at IS NULL) = (end_reason IS NULL)
    AND (ended_at IS NULL) = (lease_expires_at IS NOT NULL)
    AND (ended_at IS NULL OR resumption_handle IS NULL)
    AND (ended_at IS NULL OR ended_at >= started_at)
  )
);

-- One open session per person. The admit transaction locks the person's membership row and ends
-- their open session before it inserts; this key refuses a second insert that gets past that.
CREATE UNIQUE INDEX live_sessions_one_open_per_person ON live_sessions (company_id, actor_id) WHERE ended_at IS NULL;

-- A person's sessions by start time (the daily count), a draft's sessions (Submit ends them), and the
-- open sessions whose lease the sweeper watches.
CREATE INDEX live_sessions_actor_started ON live_sessions (company_id, actor_id, started_at);
CREATE INDEX live_sessions_draft ON live_sessions (company_id, draft_id);
CREATE INDEX live_sessions_lease ON live_sessions (lease_expires_at, company_id) WHERE ended_at IS NULL;

-- 5. Live usage: one row per upstream connection, numbered from 1 within an epoch.
CREATE TABLE live_usage (
  company_id uuid NOT NULL REFERENCES companies (id),
  session_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch >= 1),
  connection integer NOT NULL CHECK (connection >= 1),
  max_cumulative_micro_usd bigint NOT NULL CHECK (max_cumulative_micro_usd BETWEEN 0 AND 9007199254740991),
  -- The database clock at the latest post (set by the trigger below).
  last_posted_at timestamptz NOT NULL DEFAULT now(),
  closed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (company_id, session_id, epoch, connection),
  CONSTRAINT live_usage_session_fkey FOREIGN KEY (company_id, session_id) REFERENCES live_sessions (company_id, id)
);

-- 6. Live turns: the screened transcript, the record of the walkthrough (V8).
CREATE TABLE live_turns (
  company_id uuid NOT NULL REFERENCES companies (id),
  session_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  -- The epoch and upstream connection the turn was heard on.
  epoch integer NOT NULL CHECK (epoch >= 1),
  connection integer NOT NULL CHECK (connection >= 1),
  speaker text NOT NULL CHECK (speaker IN ('technician', 'assistant', 'system')),
  text text NOT NULL CHECK (char_length(text) <= 20000),
  verdict text NOT NULL CHECK (verdict IN ('passed', 'blocked', 'unscreened')),
  verdict_category text NOT NULL CHECK (verdict_category ~ '^[a-z][a-z_]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, session_id, seq),
  CONSTRAINT live_turns_session_fkey FOREIGN KEY (company_id, session_id) REFERENCES live_sessions (company_id, id),
  -- A passed turn's category is `passed` and no other turn's is. Only a passed turn keeps words:
  -- a blocked or unscreened turn is kept out of the record, as if it had not been said.
  CONSTRAINT live_turns_words_check CHECK ((verdict = 'passed') = (verdict_category = 'passed') AND (verdict = 'passed' OR text = ''))
);

-- 7. Voice notes. The id is made on the phone, so a resent note finds its row.
CREATE TABLE voice_notes (
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  -- The technician who recorded it.
  actor_id uuid NOT NULL,
  -- At most ten minutes.
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 1 AND 600000),
  -- SHA-256 of the audio bytes, which are not kept.
  audio_sha256 text NOT NULL CHECK (audio_sha256 ~ '^[0-9a-f]{64}$'),
  transcript text NOT NULL CHECK (char_length(transcript) <= 20000),
  state text NOT NULL DEFAULT 'transcribed' CHECK (state IN ('transcribed', 'reviewed', 'rejected')),
  -- Who reviewed it. A rejection may be the server's (a screened-out transcript), with no person.
  reviewed_by_actor_id uuid,
  -- Set by the trigger below at the review.
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT voice_notes_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT voice_notes_actor_fkey FOREIGN KEY (company_id, actor_id) REFERENCES actors (company_id, id),
  CONSTRAINT voice_notes_reviewed_by_fkey FOREIGN KEY (company_id, reviewed_by_actor_id) REFERENCES actors (company_id, id),
  CONSTRAINT voice_notes_review_check CHECK (
    (state = 'transcribed') = (reviewed_at IS NULL)
    AND (state <> 'transcribed' OR reviewed_by_actor_id IS NULL)
    AND (state <> 'reviewed' OR reviewed_by_actor_id IS NOT NULL)
  )
);

-- A job's notes, oldest first (the summary and scope fill read them in order).
CREATE INDEX voice_notes_job ON voice_notes (company_id, job_id, created_at);

-- 8. A person's own voice.
CREATE TABLE member_voice_settings (
  company_id uuid NOT NULL REFERENCES companies (id),
  actor_id uuid NOT NULL,
  voice_name text NOT NULL CHECK (voice_name ~ '^[A-Z][a-z]{2,29}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, actor_id),
  CONSTRAINT member_voice_settings_actor_fkey FOREIGN KEY (company_id, actor_id) REFERENCES actors (company_id, id)
);

-- Triggers. Each runs as the caller, so under the caller's row-level security, and sets the times it
-- names from the database clock, never from the caller.

-- 1. Who changes which settings: the platform operator the ceilings only, anyone else the voice only.
CREATE FUNCTION company_ai_settings_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  operator boolean := public.app_operator_active();
BEGIN
  IF operator THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.default_voice IS NOT NULL OR NEW.default_voice_set_by_actor_id IS NOT NULL THEN
        RAISE EXCEPTION 'the platform operator sets a company’s AI ceilings only' USING ERRCODE = '23514';
      END IF;
      NEW.default_voice_set_at := NULL;
    ELSIF (NEW.default_voice, NEW.default_voice_set_by_actor_id, NEW.default_voice_set_at)
          IS DISTINCT FROM (OLD.default_voice, OLD.default_voice_set_by_actor_id, OLD.default_voice_set_at) THEN
      RAISE EXCEPTION 'the platform operator sets a company’s AI ceilings only' USING ERRCODE = '23514';
    END IF;
    NEW.ceilings_set_at := now();
  ELSE
    IF TG_OP = 'INSERT' THEN
      IF NEW.daily_ceiling_micro_usd IS NOT NULL OR NEW.monthly_ceiling_micro_usd IS NOT NULL OR NEW.ceilings_set_by_operator_id IS NOT NULL THEN
        RAISE EXCEPTION 'only the platform operator sets a company’s AI ceilings' USING ERRCODE = '23514';
      END IF;
      NEW.ceilings_set_at := NULL;
    ELSIF (NEW.daily_ceiling_micro_usd, NEW.monthly_ceiling_micro_usd, NEW.ceilings_set_by_operator_id, NEW.ceilings_set_at)
          IS DISTINCT FROM (OLD.daily_ceiling_micro_usd, OLD.monthly_ceiling_micro_usd, OLD.ceilings_set_by_operator_id, OLD.ceilings_set_at) THEN
      RAISE EXCEPTION 'only the platform operator sets a company’s AI ceilings' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' OR (NEW.default_voice, NEW.default_voice_set_by_actor_id) IS DISTINCT FROM (OLD.default_voice, OLD.default_voice_set_by_actor_id) THEN
      NEW.default_voice_set_at := CASE WHEN NEW.default_voice_set_by_actor_id IS NULL THEN NULL ELSE now() END;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION company_ai_settings_guard() FROM PUBLIC;

CREATE TRIGGER company_ai_settings_guard
  BEFORE INSERT OR UPDATE ON company_ai_settings
  FOR EACH ROW EXECUTE FUNCTION company_ai_settings_guard();

-- 2. A ledger row starts reserved, may be held, and settles once; then it is frozen. Its identity
-- and reservation never change.
CREATE FUNCTION ai_ledger_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' THEN
      RAISE EXCEPTION 'a ledger row starts reserved' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'settled' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a settled ledger row cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.company_id, NEW.call_id, NEW.actor_id, NEW.feature, NEW.model, NEW.reserved_micro_usd, NEW.utc_day, NEW.utc_month, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.call_id, OLD.actor_id, OLD.feature, OLD.model, OLD.reserved_micro_usd, OLD.utc_day, OLD.utc_month, OLD.created_at) THEN
    RAISE EXCEPTION 'a ledger row''s reservation cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'held' AND NEW.state = 'reserved' THEN
    RAISE EXCEPTION 'a held ledger row can only be settled' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'settled' THEN
    NEW.settled_at := now();
  ELSE
    NEW.settled_at := OLD.settled_at;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION ai_ledger_guard() FROM PUBLIC;

CREATE TRIGGER ai_ledger_guard
  BEFORE INSERT OR UPDATE ON ai_ledger
  FOR EACH ROW EXECUTE FUNCTION ai_ledger_guard();

-- 3. A result starts proposed and is decided once; the proposal itself never changes.
CREATE FUNCTION ai_results_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'an AI result starts proposed' USING ERRCODE = '23514';
    END IF;
    NEW.decided_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.company_id, NEW.call_id, NEW.job_id, NEW.draft_id, NEW.actor_id, NEW.feature, NEW.input_digest,
      NEW.prompt_version, NEW.model, NEW.output, NEW.verdict_category, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.call_id, OLD.job_id, OLD.draft_id, OLD.actor_id, OLD.feature, OLD.input_digest,
      OLD.prompt_version, OLD.model, OLD.output, OLD.verdict_category, OLD.created_at) THEN
    RAISE EXCEPTION 'an AI result''s proposal cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'proposed' THEN
    IF (NEW.status, NEW.decided_by_actor_id, NEW.decided_at) IS DISTINCT FROM (OLD.status, OLD.decided_by_actor_id, OLD.decided_at) THEN
      RAISE EXCEPTION 'a decided AI result cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  NEW.decided_at := CASE WHEN NEW.status = 'proposed' THEN NULL ELSE now() END;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION ai_results_guard() FROM PUBLIC;

CREATE TRIGGER ai_results_guard
  BEFORE INSERT OR UPDATE ON ai_results
  FOR EACH ROW EXECUTE FUNCTION ai_results_guard();

-- 4. An ended session never changes, and never reopens. (Which columns an open one may change is
-- the grant below.)
CREATE FUNCTION live_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'an ended live session cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION live_sessions_guard() FROM PUBLIC;

CREATE TRIGGER live_sessions_guard
  BEFORE UPDATE ON live_sessions
  FOR EACH ROW EXECUTE FUNCTION live_sessions_guard();

-- 5. A connection's cumulative cost only goes up, it closes once, and a closed one never changes.
-- Each post takes its time from the clock.
CREATE FUNCTION live_usage_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.closed THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a closed live connection cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.max_cumulative_micro_usd < OLD.max_cumulative_micro_usd THEN
    RAISE EXCEPTION 'a live connection''s cumulative cost only goes up' USING ERRCODE = '23514';
  END IF;
  NEW.last_posted_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION live_usage_guard() FROM PUBLIC;

CREATE TRIGGER live_usage_guard
  BEFORE UPDATE ON live_usage
  FOR EACH ROW EXECUTE FUNCTION live_usage_guard();

-- 6. A turn is never changed, by anyone.
CREATE FUNCTION live_turns_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'a live turn cannot change' USING ERRCODE = '23514';
END
$$;

REVOKE ALL ON FUNCTION live_turns_guard() FROM PUBLIC;

CREATE TRIGGER live_turns_guard
  BEFORE UPDATE ON live_turns
  FOR EACH ROW EXECUTE FUNCTION live_turns_guard();

-- 7. A note starts transcribed and is reviewed or rejected once; its transcript changes only at that
-- review (the technician's edit), and nothing changes after.
CREATE FUNCTION voice_notes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'transcribed' THEN
      RAISE EXCEPTION 'a voice note starts transcribed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.company_id, NEW.job_id, NEW.draft_id, NEW.actor_id, NEW.duration_ms, NEW.audio_sha256, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.job_id, OLD.draft_id, OLD.actor_id, OLD.duration_ms, OLD.audio_sha256, OLD.created_at) THEN
    RAISE EXCEPTION 'a voice note''s recording cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'transcribed' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a reviewed or rejected voice note cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'transcribed' THEN
    IF NEW.transcript IS DISTINCT FROM OLD.transcript THEN
      RAISE EXCEPTION 'a voice note''s transcript changes only at its review' USING ERRCODE = '23514';
    END IF;
    NEW.reviewed_at := NULL;
  ELSE
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION voice_notes_guard() FROM PUBLIC;

CREATE TRIGGER voice_notes_guard
  BEFORE INSERT OR UPDATE ON voice_notes
  FOR EACH ROW EXECUTE FUNCTION voice_notes_guard();

-- 8. A person's voice choice takes its time from the clock.
CREATE FUNCTION member_voice_settings_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION member_voice_settings_stamp() FROM PUBLIC;

CREATE TRIGGER member_voice_settings_stamp
  BEFORE INSERT OR UPDATE ON member_voice_settings
  FOR EACH ROW EXECUTE FUNCTION member_voice_settings_stamp();

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE company_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_ai_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_results FORCE ROW LEVEL SECURITY;
ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE live_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE live_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE member_voice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_voice_settings FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company, so the platform operator reads a
-- company's rows with that company set (S3-9). Every write also refuses an active operator, except
-- the operator's own ceiling write on company_ai_settings, stamped with its own id (the 0008
-- pattern). No policy allows DELETE, and none allows UPDATE on live_turns.
CREATE POLICY company_ai_settings_select ON company_ai_settings
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY company_ai_settings_member_insert ON company_ai_settings
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY company_ai_settings_member_update ON company_ai_settings
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY company_ai_settings_operator_insert ON company_ai_settings
  FOR INSERT TO dryscope_runtime
  WITH CHECK ((SELECT app_operator_active()) AND company_id = app_company_id() AND ceilings_set_by_operator_id = app_operator_id());

CREATE POLICY company_ai_settings_operator_update ON company_ai_settings
  FOR UPDATE TO dryscope_runtime
  USING ((SELECT app_operator_active()) AND company_id = app_company_id())
  WITH CHECK ((SELECT app_operator_active()) AND company_id = app_company_id() AND ceilings_set_by_operator_id = app_operator_id());

CREATE POLICY ai_ledger_select ON ai_ledger
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY ai_ledger_insert ON ai_ledger
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY ai_ledger_update ON ai_ledger
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY ai_results_select ON ai_results
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY ai_results_insert ON ai_results
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY ai_results_update ON ai_results
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY live_sessions_select ON live_sessions
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY live_sessions_insert ON live_sessions
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY live_sessions_update ON live_sessions
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY live_usage_select ON live_usage
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY live_usage_insert ON live_usage
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY live_usage_update ON live_usage
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY live_turns_select ON live_turns
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY live_turns_insert ON live_turns
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY voice_notes_select ON voice_notes
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY voice_notes_insert ON voice_notes
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY voice_notes_update ON voice_notes
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY member_voice_settings_select ON member_voice_settings
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY member_voice_settings_insert ON member_voice_settings
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY member_voice_settings_update ON member_voice_settings
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE anywhere (removing a row is not a runtime action, and
-- TRUNCATE would ignore the policies). Every UPDATE right names its columns, so a row's company, id
-- and links never change, an AI result's output and a turn's words are never rewritten, and a
-- ledger row's reservation is fixed. The times the triggers set are not granted at all.
GRANT SELECT ON company_ai_settings, member_voice_settings TO dryscope_runtime;
GRANT SELECT, INSERT ON ai_ledger, ai_results, live_sessions, live_usage, live_turns, voice_notes TO dryscope_runtime;
GRANT INSERT (company_id, daily_ceiling_micro_usd, monthly_ceiling_micro_usd, ceilings_set_by_operator_id, default_voice, default_voice_set_by_actor_id)
  ON company_ai_settings TO dryscope_runtime;
GRANT UPDATE (daily_ceiling_micro_usd, monthly_ceiling_micro_usd, ceilings_set_by_operator_id, default_voice, default_voice_set_by_actor_id)
  ON company_ai_settings TO dryscope_runtime;
GRANT INSERT (company_id, actor_id, voice_name) ON member_voice_settings TO dryscope_runtime;
GRANT UPDATE (voice_name) ON member_voice_settings TO dryscope_runtime;
GRANT UPDATE (state, settled_micro_usd) ON ai_ledger TO dryscope_runtime;
GRANT UPDATE (status, decided_by_actor_id) ON ai_results TO dryscope_runtime;
GRANT UPDATE (ended_at, end_reason, epoch, lease_expires_at, capability_sha256, resumption_handle, handle_counter, covered_seq,
              next_turn_seq, restarts, signed_in_at)
  ON live_sessions TO dryscope_runtime;
GRANT UPDATE (max_cumulative_micro_usd, closed) ON live_usage TO dryscope_runtime;
GRANT UPDATE (state, transcript, reviewed_by_actor_id) ON voice_notes TO dryscope_runtime;

-- 9. The sweeper's one lookup across companies (the 0005 pattern). It finds companies with an open
-- live session whose lease has lapsed: the phone is gone and no heartbeat renewed it, or the relay
-- died. It returns company ids only, never session rows, and runs as the table owner (SECURITY
-- DEFINER). Row-level security is forced, so the owner reads session rows only through the SELECT
-- policy below, and only while the function runs: the function sets app.live_session_scan around its
-- one read, and the policy needs that setting, the owner's rights and a session that signed in as
-- someone else (the runtime calling the function). The runtime is never a member of the owner role,
-- so setting the value itself shows it nothing; the owner signed in as itself fails the last test.
-- The policy is for SELECT only: the owner can never add, change or remove a row through it.
CREATE POLICY live_sessions_owner_scan ON live_sessions
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.live_session_scan', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.live_sessions'::regclass), 'USAGE')
  );

-- Companies with at least one lapsed open session, the one lapsed longest first, at most
-- max_companies of them (1 to 100). The setting is turned on for the one read and cleared after it;
-- if the read fails, the transaction or savepoint rolls back and the setting with it.
CREATE FUNCTION live_session_due_companies(max_companies integer) RETURNS SETOF uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF max_companies < 1 OR max_companies > 100 THEN
    RAISE EXCEPTION 'max_companies must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.live_session_scan', 'on', true);
  RETURN QUERY
    SELECT s.company_id
    FROM public.live_sessions s
    WHERE s.ended_at IS NULL AND s.lease_expires_at <= now()
    GROUP BY s.company_id
    ORDER BY min(s.lease_expires_at), s.company_id
    LIMIT max_companies;
  PERFORM set_config('app.live_session_scan', '', true);
  RETURN;
END
$$;

-- Functions are executable by everyone by default. Only the runtime may call this one.
REVOKE ALL ON FUNCTION live_session_due_companies(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION live_session_due_companies(integer) TO dryscope_runtime;
