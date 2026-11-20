-- Drying log and outcomes (S5b-10 slice 10A, docs/plans/S5/S5b-10.md; the S5b-10/11 plan, "10A -
-- Database"). This file adds: three tables, their guards and policies, and one column on
-- job_coordination; and it widens two rules of job_coordination (4, below) so the first watch action
-- can make the row at revision 0. No table, column, row or policy of 0001 to 0019 is removed or renamed,
-- nothing is backfilled, and no Firestore record changes. No route reads or writes these yet (slices 10B
-- and 10C).
--
-- 1. drying_readings: one drying-log entry (air, material or thermal) on a job, made on the phone with
--    its own uuid, so a reading resent after a lost response is stored once. Removing a reading is a
--    void, never a delete: the raw reading never changes, and a void sets who, when, its change uuid and
--    the request's digest once. The server works out the air values (GPP, dew point, dew-point
--    depression, vapor pressure, enthalpy) and stores them beside the air reading; the phone never
--    supplies them. A whole-job or outside reading has no room; a room reading keeps the room's stable
--    field id and its label as captured, so a later rename or removal of the room keeps its history.
-- 2. job_closes: the close of a signed job, append-only. Each close or correction is a new row with the
--    next job-local close revision; the newest row is the job's close, and every earlier receipt stays
--    readable by its request id. A row states the agreement the close was confirmed against, the final
--    invoice in cents, the actual drying days (or none) and a note, and keeps the comparison it was
--    classified by: the price mode, the baseline cents, where the invoice landed (inside, above or
--    below), and the baseline agreement, which is its own reference apart from the confirmed agreement.
--    The owner's answer (2026-11-20, Q1 option A): the final invoice is compared with the first signed
--    estimate of the job.
-- 3. estimate_history: one insert-only sample per signed agreement, the signed figures the accuracy
--    numbers compare closes with: the price mode, the low and high ends in cents (no high end for one
--    price), the low end's labor and materials total, the room categories, and the planned days and
--    area when the signed record has them. The baseline is the signed priced result after any approved
--    S5b-8 named adjustment, multipliers and additions (so approved extras sit inside it, and an invoice
--    above it is an overrun of what was signed). Every sample is kept; a reporting window, if the
--    product wants one, is a query, not an eviction. A close's baseline is the sample of the job's
--    original agreement, and its price mode and cents are that sample's (the owner's Q1, option A).
-- 4. job_coordination.drying_watch: the drying watch's explicit decisions on a signed job, as one
--    checked document with its own revision (one per accepted action) and the accepted action receipts:
--    up to 100 plan extensions and one closing action (mark dry or close monitoring), after which the
--    watch takes no more. Each receipt names its action, the agreement, the reason, the actor, the time
--    (from the database's clock), the request uuid and the request's digest. The current watch status
--    is not stored: it comes from the signed facts, the live reading log and the clock. A watch change
--    leaves the office notes and the coordination revision (notes and field owner) as they are, and an
--    office change leaves the watch. The first watch action on a job with no coordination row makes the
--    row at coordination revision 0 ("no office change yet") with the existing defaults otherwise; on
--    conflict only the watch column is updated. A row made at revision 0 does not raise the job's field
--    revision (the insert trigger of 0018 fires from revision 1), so an office save opened before the
--    first watch action (expected revision 0) still succeeds and moves the revision to 1, and that
--    update raises the field revision as before.
-- 5. Every row belongs to a company and is held only inside withCompany (0003). A platform operator
--    reads a company's rows through withOperator with that company set; every write policy refuses an
--    active operator. Every key carries company_id. No DELETE and no TRUNCATE for the runtime.

-- Adding a column to job_coordination and keys to jobs, agreements and actors takes locks on them. A
-- lock this file waits for more than 5 seconds fails it, and the whole file rolls back with nothing
-- applied (the release is then run again), as 0018 and 0019 do. For this file's transaction only.
SET LOCAL lock_timeout = '5s';

-- The checks below call these functions. Each reads no table, and each answers false (never null)
-- for a value that is not what it checks, so a check cannot pass on a null answer.

-- At least one character that is not whitespace, Unicode spaces included, by a class that does not
-- depend on the database locale (the class of 0019).
CREATE FUNCTION drying_nonblank(value text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(value ~ '[^ \t\n\v\f\r\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]', false)
$$;

-- One line of text a person reads back: 1 to `max` characters, no control character, and not blank.
CREATE FUNCTION drying_line_ok(value text, max integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    char_length(value) BETWEEN 1 AND max
      AND public.drying_nonblank(value)
      AND value !~ '[[:cntrl:]]',
    false)
$$;

-- Free text that may run over several lines (a note): at most `max` characters, a tab, a line feed or
-- a carriage return allowed, no other control character (the rule of 0015's office notes). Empty is none.
CREATE FUNCTION drying_note_ok(value text, max integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(char_length(value) <= max AND value !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', false)
$$;

-- A JSON number from `low` to `high`, both included; anything else (a string, a null, no value) is not.
CREATE FUNCTION drying_number_in(value jsonb, low numeric, high numeric) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric BETWEEN low AND high ELSE false END
$$;

-- A JSON string that drying_line_ok (`note` false) or drying_note_ok (`note` true) accepts.
CREATE FUNCTION drying_text_in(value jsonb, max integer, note boolean) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'string' THEN false
    WHEN note THEN public.drying_note_ok(value #>> '{}', max)
    ELSE public.drying_line_ok(value #>> '{}', max)
  END
$$;

-- An object's keys, sorted (null for a value that is not an object).
CREATE FUNCTION drying_keys(value jsonb) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN
    coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value) AS k), '{}')
  END
$$;

-- What a reading of each kind holds, exactly these keys and no others (the strict variants of the old
-- app's contracts, backend/contracts.py): no supplied derived value, no stray field.
--   air: zone (outside, unaffected, affected, dehu_inlet, dehu_outlet), temperature_f (-40 to 150),
--        relative_humidity (1 to 100), note;
--   material: material (a label, one line, at most 100 characters), moisture (0 to 1000), unit (the
--        meter's scale as entered, one line, at most 20 characters), dry_standard (on the same scale,
--        0 to 1000, or null), affected (true or false), note;
--   thermal: delta_t_f (-200 to 200), pattern (cold_anomaly, thermal_bridge, evaporative_cooling),
--        boundary (a note on its edge, at most 300 characters, '' when none), note.
-- A note is at most 500 characters ('' when none). Every field is bounded as above, so the payload is.
CREATE FUNCTION drying_reading_payload_ok(kind text, payload jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN false
    WHEN NOT public.drying_text_in(payload->'note', 500, true) THEN false
    WHEN kind = 'air' THEN coalesce(
      public.drying_keys(payload) = ARRAY['note', 'relative_humidity', 'temperature_f', 'zone']
        AND public.drying_text_in(payload->'zone', 20, false)
        AND payload->>'zone' IN ('outside', 'unaffected', 'affected', 'dehu_inlet', 'dehu_outlet')
        AND public.drying_number_in(payload->'temperature_f', -40, 150)
        AND public.drying_number_in(payload->'relative_humidity', 1, 100),
      false)
    WHEN kind = 'material' THEN coalesce(
      public.drying_keys(payload) = ARRAY['affected', 'dry_standard', 'material', 'moisture', 'note', 'unit']
        AND public.drying_text_in(payload->'material', 100, false)
        AND public.drying_text_in(payload->'unit', 20, false)
        AND public.drying_number_in(payload->'moisture', 0, 1000)
        AND (jsonb_typeof(payload->'dry_standard') = 'null' OR public.drying_number_in(payload->'dry_standard', 0, 1000))
        AND jsonb_typeof(payload->'affected') = 'boolean',
      false)
    WHEN kind = 'thermal' THEN coalesce(
      public.drying_keys(payload) = ARRAY['boundary', 'delta_t_f', 'note', 'pattern']
        AND public.drying_number_in(payload->'delta_t_f', -200, 200)
        AND public.drying_text_in(payload->'pattern', 30, false)
        AND payload->>'pattern' IN ('cold_anomaly', 'thermal_bridge', 'evaporative_cooling')
        AND public.drying_text_in(payload->'boundary', 300, true),
      false)
    ELSE false
  END
$$;

-- The signed rooms' categories: each of '1', '2', '3' and 'mold' at most once, at least one, in that order.
CREATE FUNCTION drying_categories_ok(value text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    cardinality(value) >= 1
      AND value = ARRAY(SELECT c FROM unnest(ARRAY['1', '2', '3', 'mold']) WITH ORDINALITY AS known(c, n) WHERE c = ANY (value) ORDER BY n),
    false)
$$;

-- The drying watch document: {"revision": n, "receipts": [...]}, exactly those keys, n the number of
-- receipts (1 to 101). Each receipt has exactly action (mark_dry, extend, close), agreement_id,
-- actor_id and request_id (lower-case uuids), reason (1 to 500 characters, not blank; line breaks
-- allowed as in a note), at (the database's UTC time, as the guard stamps it) and request_digest (a
-- SHA-256). At most 100 extensions, at most one closing action (mark_dry or close) and only as the last
-- receipt, and no request id twice.
CREATE FUNCTION drying_watch_ok(watch jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
DECLARE
  receipts jsonb;
  receipt jsonb;
  total integer;
  seen integer := 0;
  extensions integer := 0;
  uuid_form constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF public.drying_keys(watch) IS DISTINCT FROM ARRAY['receipts', 'revision'] THEN
    RETURN false;
  END IF;
  receipts := watch->'receipts';
  IF jsonb_typeof(receipts) <> 'array' OR jsonb_typeof(watch->'revision') <> 'number' THEN
    RETURN false;
  END IF;
  total := jsonb_array_length(receipts);
  IF total NOT BETWEEN 1 AND 101 OR (watch->>'revision') <> total::text THEN
    RETURN false;
  END IF;
  FOR receipt IN SELECT e.value FROM jsonb_array_elements(receipts) AS e LOOP
    seen := seen + 1;
    IF public.drying_keys(receipt) IS DISTINCT FROM ARRAY['action', 'actor_id', 'agreement_id', 'at', 'reason', 'request_digest', 'request_id'] THEN
      RETURN false;
    END IF;
    IF NOT (public.drying_text_in(receipt->'agreement_id', 36, false) AND public.drying_text_in(receipt->'actor_id', 36, false)
            AND public.drying_text_in(receipt->'request_id', 36, false) AND public.drying_text_in(receipt->'request_digest', 64, false)
            AND public.drying_text_in(receipt->'at', 27, false) AND public.drying_text_in(receipt->'action', 10, false)
            AND public.drying_text_in(receipt->'reason', 500, true) AND public.drying_nonblank(receipt->>'reason')) THEN
      RETURN false;
    END IF;
    IF receipt->>'agreement_id' !~ uuid_form OR receipt->>'actor_id' !~ uuid_form OR receipt->>'request_id' !~ uuid_form
       OR receipt->>'request_digest' !~ '^[0-9a-f]{64}$'
       OR receipt->>'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' THEN
      RETURN false;
    END IF;
    CASE receipt->>'action'
      WHEN 'extend' THEN
        extensions := extensions + 1;
      WHEN 'mark_dry', 'close' THEN
        IF seen <> total THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
    END CASE;
  END LOOP;
  IF extensions > 100 THEN
    RETURN false;
  END IF;
  RETURN (SELECT count(DISTINCT e.value->>'request_id') FROM jsonb_array_elements(receipts) AS e) = total;
END
$$;

-- The checks call these as the writer, so the runtime may run them.
REVOKE ALL ON FUNCTION drying_nonblank(text), drying_line_ok(text, integer), drying_note_ok(text, integer), drying_number_in(jsonb, numeric, numeric),
  drying_text_in(jsonb, integer, boolean), drying_keys(jsonb), drying_reading_payload_ok(text, jsonb),
  drying_categories_ok(text[]), drying_watch_ok(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION drying_nonblank(text), drying_line_ok(text, integer), drying_note_ok(text, integer), drying_number_in(jsonb, numeric, numeric),
  drying_text_in(jsonb, integer, boolean), drying_keys(jsonb), drying_reading_payload_ok(text, jsonb),
  drying_categories_ok(text[]), drying_watch_ok(jsonb) TO dryscope_runtime;

-- 1. Drying readings.
CREATE TABLE drying_readings (
  -- Made on the phone (a uuid), so a resent reading finds its row.
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('air', 'material', 'thermal')),
  -- The room's stable field id and its label as captured, or neither for a whole-job or outside reading.
  room_id text CHECK (char_length(room_id) BETWEEN 1 AND 64 AND room_id ~ '^[A-Za-z0-9_-]+$'),
  room_label text CHECK (room_label IS NULL OR (char_length(room_label) BETWEEN 1 AND 100 AND drying_nonblank(room_label) AND drying_note_ok(room_label, 100))),
  -- When the technician took it (as sent), and when the server received it (the database's clock).
  taken_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL,
  -- An air reading's values, worked out on the server (the port of backend/psychrometrics.py), rounded
  -- as it rounds: whole grains and degrees, vapor pressure to 0.001 inHg, enthalpy to 0.1 BTU/lb.
  gpp integer CHECK (gpp BETWEEN 0 AND 2000),
  dew_point_f integer CHECK (dew_point_f BETWEEN -200 AND 150),
  dew_point_depression_f integer CHECK (dew_point_depression_f BETWEEN 0 AND 300),
  vapor_pressure_inhg numeric CHECK (vapor_pressure_inhg BETWEEN 0 AND 10 AND scale(vapor_pressure_inhg) <= 3),
  enthalpy_btu_lb numeric CHECK (enthalpy_btu_lb BETWEEN -50 AND 500 AND scale(enthalpy_btu_lb) <= 1),
  -- SHA-256 of the canonical create request: the same id and body is the same reading.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_by_actor_id uuid NOT NULL,
  -- The void, set once (the guard below stamps its time): who, when, the void request's uuid and digest.
  voided_by_actor_id uuid,
  voided_at timestamptz,
  void_change_id uuid,
  void_digest text CHECK (void_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (company_id, id),
  CONSTRAINT drying_readings_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT drying_readings_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT drying_readings_voided_by_fkey FOREIGN KEY (company_id, voided_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT drying_readings_payload_check CHECK (drying_reading_payload_ok(kind, payload)),
  -- A room reading has its id and its label; a whole-job reading has neither.
  CONSTRAINT drying_readings_room_check CHECK ((room_id IS NULL) = (room_label IS NULL)),
  -- Outside air belongs to no room.
  CONSTRAINT drying_readings_outside_check CHECK (kind <> 'air' OR payload->>'zone' <> 'outside' OR room_id IS NULL),
  -- An air reading has all five air values; a material or thermal reading has none.
  CONSTRAINT drying_readings_air_values_check CHECK (
    CASE WHEN kind = 'air'
      THEN num_nulls(gpp, dew_point_f, dew_point_depression_f, vapor_pressure_inhg, enthalpy_btu_lb) = 0
      ELSE num_nulls(gpp, dew_point_f, dew_point_depression_f, vapor_pressure_inhg, enthalpy_btu_lb) = 5
    END
  ),
  -- Voided with all of its metadata, or not at all.
  CONSTRAINT drying_readings_void_check CHECK (num_nulls(voided_by_actor_id, voided_at, void_change_id, void_digest) IN (0, 4))
);

-- A job's active readings in the order the log shows them.
CREATE INDEX drying_readings_job_active ON drying_readings (company_id, job_id, taken_at, id) WHERE voided_at IS NULL;
-- A job's whole log, voided readings included: slice 10B's watch facts hash includes the relevant
-- reading and void changes (the S5b-10/11 plan, 10B "Watch calculation"), so that read scans a job's
-- voided readings too.
CREATE INDEX drying_readings_job ON drying_readings (company_id, job_id, taken_at, id);
-- A void request's uuid voids one reading: the same uuid on another reading is refused.
CREATE UNIQUE INDEX drying_readings_void_change ON drying_readings (company_id, void_change_id) WHERE void_change_id IS NOT NULL;

-- What a reading may do. It is made active, its receive time from the clock here. Its raw fields never
-- change; it may be voided once (who, the void's uuid and digest, together), the void time from the
-- clock here; a voided reading never changes again. Runs as the caller, under the caller's row-level
-- security. A column added later is frozen until this function names it.
CREATE FUNCTION drying_readings_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF num_nulls(NEW.voided_by_actor_id, NEW.voided_at, NEW.void_change_id, NEW.void_digest) <> 4 THEN
      RAISE EXCEPTION 'a drying reading starts active' USING ERRCODE = '23514';
    END IF;
    NEW.received_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) - ARRAY['voided_by_actor_id', 'voided_at', 'void_change_id', 'void_digest']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['voided_by_actor_id', 'voided_at', 'void_change_id', 'void_digest'] THEN
    RAISE EXCEPTION 'a drying reading never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.void_change_id IS NOT NULL THEN
    RAISE EXCEPTION 'a drying reading is voided once' USING ERRCODE = '23514';
  END IF;
  IF num_nulls(NEW.voided_by_actor_id, NEW.void_change_id, NEW.void_digest) <> 0 THEN
    RAISE EXCEPTION 'a drying reading changes only by its void, by someone, with the void''s id and digest' USING ERRCODE = '23514';
  END IF;
  NEW.voided_at := clock_timestamp();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION drying_readings_guard() FROM PUBLIC;

CREATE TRIGGER drying_readings_guard
  BEFORE INSERT OR UPDATE ON drying_readings
  FOR EACH ROW EXECUTE FUNCTION drying_readings_guard();

-- 3. Estimate history, made before the closes, which name its samples as their baselines.
CREATE TABLE estimate_history (
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  signed_at timestamptz NOT NULL,
  price_mode text NOT NULL CHECK (price_mode IN ('range', 'single')),
  -- The signed priced result after any approved named adjustment, multipliers and additions, in cents.
  -- Every cents column is at most 2^53 - 1, so a JavaScript number holds it exactly (as ai-schema.ts does).
  low_cents bigint NOT NULL CHECK (low_cents BETWEEN 0 AND 9007199254740991),
  high_cents bigint,
  -- The low end's labor and materials total, in cents, when it can be read.
  labor_material_low_cents bigint CHECK (labor_material_low_cents BETWEEN 0 AND 9007199254740991),
  -- The signed rooms' categories, each once, in this order ('1', '2', '3', 'mold'), when they can be read.
  room_categories text[] CHECK (room_categories IS NULL OR drying_categories_ok(room_categories)),
  -- The signed drying plan's days and the job's area on its price table's basis, when the record has them.
  planned_days integer CHECK (planned_days BETWEEN 1 AND 365),
  area_sf numeric CHECK (area_sf >= 0),
  PRIMARY KEY (company_id, job_id, agreement_id),
  CONSTRAINT estimate_history_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT estimate_history_agreement_fkey FOREIGN KEY (company_id, job_id, agreement_id)
    REFERENCES agreements (company_id, job_id, id),
  CONSTRAINT estimate_history_high_cents_check CHECK (high_cents BETWEEN low_cents AND 9007199254740991),
  CONSTRAINT estimate_history_mode_check CHECK ((price_mode = 'single') = (high_cents IS NULL))
);

-- A company's samples by signing time, as the accuracy numbers read them.
CREATE INDEX estimate_history_company_signed ON estimate_history (company_id, signed_at);

-- 2. Job closes.
CREATE TABLE job_closes (
  -- The close request's uuid, made on the phone: a replay finds its receipt, even after a correction.
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  -- The agreement the close was confirmed against (the agreement in force when it was made).
  agreement_id uuid NOT NULL,
  -- 1 for the first close of the job, one more for each correction (guard below).
  revision integer NOT NULL CHECK (revision >= 1),
  -- SHA-256 of the canonical close request: the same id and body is the same close.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  -- The final invoice, $0.01 to $2,000,000.00, in cents.
  final_cents bigint NOT NULL CHECK (final_cents BETWEEN 1 AND 200000000),
  -- The actual drying days, 0 to 365, or none (a blank).
  actual_days integer CHECK (actual_days BETWEEN 0 AND 365),
  note text NOT NULL DEFAULT '' CHECK (drying_note_ok(note, 300)),
  -- What it was compared with, saved as classified: the baseline agreement (its own reference, apart
  -- from the confirmed agreement; the job's original), its price mode and its low and high ends in
  -- cents (no high end for one price; the baseline sample's own), and where the final invoice landed.
  baseline_agreement_id uuid NOT NULL,
  price_mode text NOT NULL CHECK (price_mode IN ('range', 'single')),
  baseline_low_cents bigint NOT NULL CHECK (baseline_low_cents BETWEEN 0 AND 9007199254740991),
  baseline_high_cents bigint,
  landed text NOT NULL CHECK (landed IN ('inside', 'above', 'below')),
  closed_by_actor_id uuid NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT job_closes_revision_key UNIQUE (company_id, job_id, revision),
  CONSTRAINT job_closes_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT job_closes_agreement_fkey FOREIGN KEY (company_id, job_id, agreement_id)
    REFERENCES agreements (company_id, job_id, id),
  -- The baseline is a sample of the job's history: of its original agreement (guard below).
  CONSTRAINT job_closes_baseline_agreement_fkey FOREIGN KEY (company_id, job_id, baseline_agreement_id)
    REFERENCES estimate_history (company_id, job_id, agreement_id),
  CONSTRAINT job_closes_closed_by_fkey FOREIGN KEY (company_id, closed_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT job_closes_baseline_high_cents_check CHECK (baseline_high_cents BETWEEN baseline_low_cents AND 9007199254740991),
  -- A range has both ends; one price has only its price (the low end).
  CONSTRAINT job_closes_mode_check CHECK ((price_mode = 'single') = (baseline_high_cents IS NULL)),
  -- Where it landed, as docs/estimate-assist.md classifies it: a range is inside from low to high,
  -- both included, below under the low and above over the high; one price is inside at or under the
  -- price and above over it.
  CONSTRAINT job_closes_classification_check CHECK (
    landed = CASE
      WHEN price_mode = 'single' THEN CASE WHEN final_cents <= baseline_low_cents THEN 'inside' ELSE 'above' END
      WHEN final_cents < baseline_low_cents THEN 'below'
      WHEN final_cents > baseline_high_cents THEN 'above'
      ELSE 'inside'
    END
  )
);

-- What a close may be. It is made with the next revision of its job (1, then one more for each
-- correction), read under the job row lock, and stamped with the database's clock after that lock; it
-- never changes (the runtime has no UPDATE). Its baseline is the job's original agreement, and its price
-- mode and baseline cents are that agreement's history sample's, whatever agreement the close was
-- confirmed against (the owner's Q1, option A). A row the keys or the policy will refuse anyway (a job
-- the caller cannot see, a request id already used, a baseline with no sample of this job) is left to
-- them. Runs as the caller, under the caller's row-level security.
CREATE FUNCTION job_closes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  latest integer;
  baseline public.estimate_history;
BEGIN
  PERFORM 1 FROM public.jobs j WHERE j.company_id = NEW.company_id AND j.id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  -- A request id already used is refused by the key, as the same close.
  PERFORM 1 FROM public.job_closes c WHERE c.company_id = NEW.company_id AND c.id = NEW.id;
  IF FOUND THEN
    RETURN NEW;
  END IF;
  SELECT max(c.revision) INTO latest FROM public.job_closes c WHERE c.company_id = NEW.company_id AND c.job_id = NEW.job_id;
  IF NEW.revision <> coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'a job close takes the next close revision of its job' USING ERRCODE = '23514';
  END IF;
  SELECT h.* INTO baseline FROM public.estimate_history h
  WHERE h.company_id = NEW.company_id AND h.job_id = NEW.job_id AND h.agreement_id = NEW.baseline_agreement_id;
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.agreements a
      WHERE a.company_id = NEW.company_id AND a.job_id = NEW.job_id AND a.id = NEW.baseline_agreement_id AND a.kind = 'original'
    ) THEN
      RAISE EXCEPTION 'a job close is compared with the job''s original agreement' USING ERRCODE = '23514';
    END IF;
    IF NEW.price_mode IS DISTINCT FROM baseline.price_mode OR NEW.baseline_low_cents IS DISTINCT FROM baseline.low_cents
       OR NEW.baseline_high_cents IS DISTINCT FROM baseline.high_cents THEN
      RAISE EXCEPTION 'a job close keeps the price mode and baseline cents of its baseline sample' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.closed_at := clock_timestamp();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION job_closes_guard() FROM PUBLIC;

CREATE TRIGGER job_closes_guard
  BEFORE INSERT ON job_closes
  FOR EACH ROW EXECUTE FUNCTION job_closes_guard();

-- 4. The drying watch's decisions.
ALTER TABLE job_coordination
  ADD COLUMN drying_watch jsonb CONSTRAINT job_coordination_drying_watch_check CHECK (drying_watch IS NULL OR drying_watch_ok(drying_watch));

-- A row the first watch action makes has coordination revision 0: no office change yet. The check of 0015
-- allows it, and the insert trigger of 0018 (same name, same function) raises the job's field revision
-- only for a row made at revision 1 or more (an office save), so a watch-made row leaves it; the update
-- trigger still raises it when the office moves the revision from 0 to 1.
ALTER TABLE job_coordination
  DROP CONSTRAINT job_coordination_revision_check,
  ADD CONSTRAINT job_coordination_revision_check CHECK (revision >= 0);

DROP TRIGGER job_coordination_field_revision_insert ON job_coordination;
CREATE TRIGGER job_coordination_field_revision_insert
  AFTER INSERT ON job_coordination
  FOR EACH ROW
  WHEN (NEW.revision >= 1)
  EXECUTE FUNCTION job_field_revision_bump();

-- What the watch may do: start with its first receipt (revision 1), then gain exactly one receipt per
-- change, every earlier receipt kept as it was, and none after a closing action; it is never removed.
-- A new receipt names an agreement of this job and an actor of this company, and the guard stamps its
-- time (UTC) from the database's clock, over any time the writer sent. A change that leaves the watch as it was
-- (an office change) is not the watch's concern. A row of a job the caller cannot see is left to the
-- keys and the policy. The job row is locked first, before the insert can claim the coordination key,
-- the order an office save takes, so the two first writes of one job wait for each other and never deadlock. Runs as the caller, under the caller's row-level security.
CREATE FUNCTION job_coordination_drying_watch_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  earlier jsonb := '[]';
  receipts jsonb;
  receipt jsonb;
  kept integer;
  uuid_form constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.drying_watch IS NOT DISTINCT FROM OLD.drying_watch THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.drying_watch IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.jobs j WHERE j.company_id = NEW.company_id AND j.id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  -- An insert's row goes through this before its conflict is known. When the job already has its
  -- coordination row, the insert either conflicts, and the update it makes instead is checked and
  -- stamped below as an update, or fails on the key; either way this row is not the watch's first.
  -- Its newest receipt is stamped all the same, as the row's checks run on it before the conflict.
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM public.job_coordination c WHERE c.company_id = NEW.company_id AND c.job_id = NEW.job_id;
    IF FOUND THEN
      IF jsonb_typeof(NEW.drying_watch->'receipts') = 'array' AND jsonb_array_length(NEW.drying_watch->'receipts') > 0
         AND jsonb_typeof(NEW.drying_watch->'receipts'->-1) = 'object' THEN
        NEW.drying_watch := jsonb_set(
          NEW.drying_watch, ARRAY['receipts', (jsonb_array_length(NEW.drying_watch->'receipts') - 1)::text, 'at'],
          to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), true
        );
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.drying_watch IS NULL THEN
    RAISE EXCEPTION 'a drying watch is never removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.drying_watch IS NOT NULL THEN
    earlier := OLD.drying_watch->'receipts';
  END IF;
  receipts := NEW.drying_watch->'receipts';
  IF jsonb_typeof(receipts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'a drying watch holds its receipts' USING ERRCODE = '23514';
  END IF;
  kept := jsonb_array_length(earlier);
  IF jsonb_array_length(receipts) <> kept + 1
     OR coalesce((SELECT jsonb_agg(e.value ORDER BY e.n) FROM jsonb_array_elements(receipts) WITH ORDINALITY AS e(value, n) WHERE e.n <= kept), '[]') <> earlier THEN
    RAISE EXCEPTION 'a drying watch change adds one receipt and keeps every earlier one' USING ERRCODE = '23514';
  END IF;
  IF kept > 0 AND earlier->(kept - 1)->>'action' IN ('mark_dry', 'close') THEN
    RAISE EXCEPTION 'the drying watch is closed' USING ERRCODE = '23514';
  END IF;
  receipt := receipts->kept;
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'a drying watch receipt is an object' USING ERRCODE = '23514';
  END IF;
  -- The ids' form is checked before they are read as uuids (the document check runs after this).
  IF jsonb_typeof(receipt->'agreement_id') IS DISTINCT FROM 'string' OR receipt->>'agreement_id' !~ uuid_form THEN
    RAISE EXCEPTION 'a drying watch receipt names an agreement of its job' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agreements a
    WHERE a.company_id = NEW.company_id AND a.job_id = NEW.job_id AND a.id = (receipt->>'agreement_id')::uuid
  ) THEN
    RAISE EXCEPTION 'a drying watch receipt names an agreement of its job' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(receipt->'actor_id') IS DISTINCT FROM 'string' OR receipt->>'actor_id' !~ uuid_form THEN
    RAISE EXCEPTION 'a drying watch receipt names an actor of its company' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.actors p WHERE p.company_id = NEW.company_id AND p.id = (receipt->>'actor_id')::uuid) THEN
    RAISE EXCEPTION 'a drying watch receipt names an actor of its company' USING ERRCODE = '23514';
  END IF;
  NEW.drying_watch := jsonb_set(
    NEW.drying_watch, ARRAY['receipts', kept::text, 'at'],
    to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), true
  );
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION job_coordination_drying_watch_guard() FROM PUBLIC;

CREATE TRIGGER job_coordination_drying_watch_guard
  BEFORE INSERT OR UPDATE ON job_coordination
  FOR EACH ROW EXECUTE FUNCTION job_coordination_drying_watch_guard();

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE drying_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE drying_readings FORCE ROW LEVEL SECURITY;
ALTER TABLE job_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_closes FORCE ROW LEVEL SECURITY;
ALTER TABLE estimate_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_history FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company (so the platform operator reads them
-- through withOperator); writing also refuses an active platform operator. No policy allows DELETE, and
-- none allows UPDATE on the closes or the history. job_coordination keeps its policies of 0015.
CREATE POLICY drying_readings_select ON drying_readings
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY drying_readings_insert ON drying_readings
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY drying_readings_update ON drying_readings
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_closes_select ON job_closes
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_closes_insert ON job_closes
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY estimate_history_select ON estimate_history
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY estimate_history_insert ON estimate_history
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE. Reading is table-wide; inserting names the columns a writer
-- supplies, leaving out the ones the guards stamp (a reading's receive time and void, a close's time). A
-- reading's void only is updated (the guard sets its time); the closes and the history are insert-only;
-- on job_coordination the watch column alone, apart from the office columns of 0015 (its INSERT right
-- of 0015 already covers the new column).
GRANT SELECT ON drying_readings, job_closes, estimate_history TO dryscope_runtime;
GRANT INSERT (id, company_id, job_id, kind, room_id, room_label, taken_at, payload, gpp, dew_point_f, dew_point_depression_f,
              vapor_pressure_inhg, enthalpy_btu_lb, request_digest, created_by_actor_id)
  ON drying_readings TO dryscope_runtime;
GRANT INSERT (id, company_id, job_id, agreement_id, revision, request_digest, final_cents, actual_days, note, baseline_agreement_id,
              price_mode, baseline_low_cents, baseline_high_cents, landed, closed_by_actor_id)
  ON job_closes TO dryscope_runtime;
GRANT INSERT (company_id, job_id, agreement_id, signed_at, price_mode, low_cents, high_cents, labor_material_low_cents, room_categories,
              planned_days, area_sf)
  ON estimate_history TO dryscope_runtime;
GRANT UPDATE (voided_by_actor_id, void_change_id, void_digest) ON drying_readings TO dryscope_runtime;
GRANT UPDATE (drying_watch) ON job_coordination TO dryscope_runtime;
