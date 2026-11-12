-- Submission, price pin, estimate and agreement tables (S5a-7, docs/plans/S5.md): where Submit's
-- one immutable record, the price version a job is priced from, the priced estimate and the signed
-- agreement live. This file only adds; nothing in 0001 to 0010 changes. No route reads or writes any
-- of it yet (S5a-8 to S5a-11).
--
-- 1. job_submissions: the intent row Submit writes before it fences the Firestore draft, then the one
--    row whose status decides the handoff (docs/plans/S5.md section 4). It is made `pending`, and
--    moves once to `committed` (with the canonical snapshot bytes and their SHA-256) or `aborted`.
--    A trigger refuses every change to a committed or aborted row except the marker moving from
--    pending to done. Unique per draft and epoch; at most one committed row per draft.
-- 2. job_price_pins: which published price version a job is priced from (docs/plans/pricing.md
--    S5a-1). A pin names a version of its own company, and the sequence of a job's pins is 1, 2, 3.
-- 3. job_estimates: one priced estimate per submission and pin: the table hash and engine version
--    it was priced with, the priced result and the proposal bytes with their SHA-256.
-- 4. agreements: the signed record. It restates its estimate (a trigger checks it), names its
--    signature in the evidence registry, and holds the documents as signed. One original agreement
--    per job; a change order names its parent.
-- 5. job_submission_due_companies(max, grace): the one lookup across companies the worker needs, on
--    the 0005 pattern.
-- 6. Every row belongs to a company and is held only inside withCompany (0003). A platform operator
--    reads a company's rows through withOperator with that company set; every write policy refuses
--    an active operator. Every key between rows carries company_id, so a row can never point at
--    another company's job, version, estimate or person.
-- 7. Nothing here is removed by the runtime: no DELETE and no TRUNCATE on any table. Pins,
--    estimates and agreements are insert-only; a submission may change only as 1 says.

-- 1. Submissions. The id is made on the phone, so a retried Submit finds its row; the epoch is made
-- by the server, so a stale release for an old fence can never unlock a newer one.
CREATE TABLE job_submissions (
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  -- The Firestore field draft being submitted. A draft id is not a table here (the draft lives in
  -- Firestore); that it is the job's current draft is the route's check.
  draft_id uuid NOT NULL,
  epoch uuid NOT NULL,
  -- An original submission, or a change order built on a signed agreement.
  kind text NOT NULL CHECK (kind IN ('original', 'change_order')),
  parent_agreement_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'aborted')),
  -- SHA-256 of the submit request, as 64 lowercase hex characters: the same id and body continues
  -- the row, the same id with another body is refused.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  -- When the worker may abort the row if nothing has decided it. Never changed.
  expires_at timestamptz NOT NULL,
  -- The canonical snapshot (draft, rooms, photo references, job header, customer and claim) and its
  -- SHA-256, written when the row commits and never before or after. The hash is checked against
  -- the bytes here, so a stored snapshot always matches the hash the documents quote.
  snapshot_bytes bytea CHECK (octet_length(snapshot_bytes) BETWEEN 2 AND 8388608),
  snapshot_sha256 text CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  -- Whether the draft's Firestore marker is written: `submitted` after a commit, back to `editing`
  -- after an abort. It is `pending` until the server or the worker writes it, then `done`.
  marker_state text NOT NULL DEFAULT 'pending' CHECK (marker_state IN ('pending', 'done')),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the trigger below when the row leaves `pending`; empty while it is pending.
  decided_at timestamptz,
  PRIMARY KEY (company_id, id),
  -- One row per draft and epoch.
  CONSTRAINT job_submissions_company_draft_epoch_key UNIQUE (company_id, draft_id, epoch),
  -- Estimates and agreements name a submission by company, job and id.
  CONSTRAINT job_submissions_company_job_id_key UNIQUE (company_id, job_id, id),
  CONSTRAINT job_submissions_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT job_submissions_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT job_submissions_expires_check CHECK (expires_at > created_at),
  -- A change order names the agreement it builds on, and an original does not.
  CONSTRAINT job_submissions_parent_check CHECK ((kind = 'change_order') = (parent_agreement_id IS NOT NULL)),
  -- The snapshot and its hash come together, and only with a commit.
  CONSTRAINT job_submissions_snapshot_check CHECK (
    (snapshot_bytes IS NULL) = (snapshot_sha256 IS NULL)
    AND (status = 'committed') = (snapshot_bytes IS NOT NULL)
    AND (snapshot_bytes IS NULL OR snapshot_sha256 = encode(sha256(snapshot_bytes), 'hex'))
  ),
  CONSTRAINT job_submissions_decided_check CHECK ((status = 'pending') = (decided_at IS NULL)),
  -- A row still deciding has no marker to write.
  CONSTRAINT job_submissions_marker_check CHECK (status <> 'pending' OR marker_state = 'pending')
);

-- One committed row per draft: one record per draft. Whichever of two commits lands first wins and
-- the other is refused by this index.
CREATE UNIQUE INDEX job_submissions_one_committed_per_draft
  ON job_submissions (company_id, draft_id) WHERE status = 'committed';

-- A job's submissions, newest first.
CREATE INDEX job_submissions_job ON job_submissions (company_id, job_id, created_at DESC);

-- What the worker looks for across companies: rows still pending past their expiry, and decided rows
-- whose marker is not yet written.
CREATE INDEX job_submissions_expired ON job_submissions (expires_at, company_id) WHERE status = 'pending';
CREATE INDEX job_submissions_marker_due ON job_submissions (decided_at, company_id)
  WHERE status <> 'pending' AND marker_state = 'pending';

-- 2. Job price pins. A job's first estimate pins it to the company's current version; the owner's
-- reprice (S5b-6) adds the next pin. Rows are never changed: the current pin is the highest
-- sequence.
CREATE TABLE job_price_pins (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  -- 1 for a job's first pin, then each next number: no gaps, no repeats (trigger below).
  sequence integer NOT NULL CHECK (sequence >= 1),
  -- The published version, by company and its own id: another company's version cannot be named.
  version_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('first_price', 'owner_reprice')),
  pinned_by_actor_id uuid NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT job_price_pins_company_job_sequence_key UNIQUE (company_id, job_id, sequence),
  -- Estimates name a pin by company, job and id.
  CONSTRAINT job_price_pins_company_job_id_key UNIQUE (company_id, job_id, id),
  CONSTRAINT job_price_pins_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT job_price_pins_version_fkey FOREIGN KEY (company_id, version_id)
    REFERENCES price_table_versions (company_id, id),
  CONSTRAINT job_price_pins_pinned_by_fkey FOREIGN KEY (company_id, pinned_by_actor_id)
    REFERENCES actors (company_id, id),
  -- The first pin is the first price; every later one is the owner's reprice.
  CONSTRAINT job_price_pins_first_pin_check CHECK ((sequence = 1) = (reason = 'first_price'))
);

-- 3. Job estimates: one priced estimate for a committed submission and a pin. The priced result is
-- the engine's output as jsonb (the one Zod schema checks it at write and read); the proposal bytes
-- are the document the customer is shown, and their SHA-256 is what the agreement quotes.
CREATE TABLE job_estimates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  pin_id uuid NOT NULL,
  -- The content hash and engine version of the pinned version this was priced with (a trigger
  -- checks both against the version).
  table_hash text NOT NULL CHECK (table_hash ~ '^[0-9a-f]{64}$'),
  engine_version text NOT NULL CHECK (engine_version ~ '^dryscope-v[0-9]{1,3}$'),
  priced_result jsonb NOT NULL CHECK (jsonb_typeof(priced_result) = 'object'),
  proposal_bytes bytea NOT NULL CHECK (octet_length(proposal_bytes) BETWEEN 2 AND 8388608),
  proposal_sha256 text NOT NULL CHECK (proposal_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  -- Agreements name an estimate by company, job and id.
  CONSTRAINT job_estimates_company_job_id_key UNIQUE (company_id, job_id, id),
  -- One estimate per submission and pin: a retried estimate finds its row.
  CONSTRAINT job_estimates_company_submission_pin_key UNIQUE (company_id, submission_id, pin_id),
  CONSTRAINT job_estimates_submission_fkey FOREIGN KEY (company_id, job_id, submission_id)
    REFERENCES job_submissions (company_id, job_id, id),
  CONSTRAINT job_estimates_pin_fkey FOREIGN KEY (company_id, job_id, pin_id)
    REFERENCES job_price_pins (company_id, job_id, id),
  CONSTRAINT job_estimates_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  -- The proposal's hash is the hash of the proposal's bytes.
  CONSTRAINT job_estimates_proposal_check CHECK (proposal_sha256 = encode(sha256(proposal_bytes), 'hex'))
);

-- 4. Agreements: the signed record. The id is made on the phone, so a retried signature finds its
-- row. The price columns restate the estimate that was signed (a trigger checks them), so a signed
-- job is shown from this row alone and never runs the engine again.
CREATE TABLE agreements (
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('original', 'change_order')),
  parent_agreement_id uuid,
  -- Signed on the technician's device, or through a signing link (S5b-3). Either way the row names
  -- the technician (created_by_actor_id) who held the sign capability.
  signer_kind text NOT NULL CHECK (signer_kind IN ('device', 'link')),
  signer_name text NOT NULL
    CHECK (signer_name = btrim(signer_name) AND char_length(signer_name) BETWEEN 1 AND 150 AND signer_name !~ '[[:cntrl:]]'),
  -- The signature image in the evidence registry (kind signature, this job: a trigger checks both).
  signature_evidence_id uuid NOT NULL,
  proposal_sha256 text NOT NULL CHECK (proposal_sha256 ~ '^[0-9a-f]{64}$'),
  priced_result jsonb NOT NULL CHECK (jsonb_typeof(priced_result) = 'object'),
  -- The price version the estimate was priced from, with its content hash and engine version.
  version_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  engine_version text NOT NULL CHECK (engine_version ~ '^dryscope-v[0-9]{1,3}$'),
  -- The documents as signed (Proposal, Itemized claim, Scope defense letter, Photo audit log).
  documents_bytes bytea NOT NULL CHECK (octet_length(documents_bytes) BETWEEN 2 AND 16777216),
  -- SHA-256 of the sign request: the same id and body is the same agreement, the same id with
  -- another body is refused.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_by_actor_id uuid NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  -- A change order names its parent by company, job and id.
  CONSTRAINT agreements_company_job_id_key UNIQUE (company_id, job_id, id),
  -- A submission, an estimate and a signature object are each signed once.
  CONSTRAINT agreements_company_submission_key UNIQUE (company_id, submission_id),
  CONSTRAINT agreements_company_estimate_key UNIQUE (company_id, estimate_id),
  CONSTRAINT agreements_company_signature_key UNIQUE (company_id, signature_evidence_id),
  CONSTRAINT agreements_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT agreements_submission_fkey FOREIGN KEY (company_id, job_id, submission_id)
    REFERENCES job_submissions (company_id, job_id, id),
  CONSTRAINT agreements_estimate_fkey FOREIGN KEY (company_id, job_id, estimate_id)
    REFERENCES job_estimates (company_id, job_id, id),
  CONSTRAINT agreements_parent_fkey FOREIGN KEY (company_id, job_id, parent_agreement_id)
    REFERENCES agreements (company_id, job_id, id),
  CONSTRAINT agreements_signature_fkey FOREIGN KEY (company_id, signature_evidence_id)
    REFERENCES evidence_objects (company_id, id),
  CONSTRAINT agreements_version_fkey FOREIGN KEY (company_id, version_id)
    REFERENCES price_table_versions (company_id, id),
  CONSTRAINT agreements_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT agreements_parent_check CHECK ((kind = 'change_order') = (parent_agreement_id IS NOT NULL))
);

-- One original agreement per job: a second original is refused, change orders are not counted.
CREATE UNIQUE INDEX agreements_one_original_per_job ON agreements (company_id, job_id) WHERE kind = 'original';

-- A change order's submission builds on an agreement of the same job.
ALTER TABLE job_submissions
  ADD CONSTRAINT job_submissions_parent_fkey FOREIGN KEY (company_id, job_id, parent_agreement_id)
    REFERENCES agreements (company_id, job_id, id);

-- 1. What a submission may do. Made as `pending`, it moves once to `committed` or `aborted` (and
-- takes its decision time from the clock here, not from the caller); from then on every column is
-- frozen except the marker, which may only go from pending to done. The identity of a pending row
-- never changes either. Runs as the caller, so under the caller's row-level security. A column added
-- later is frozen until this list names it (tests/db/submission-tables.test.ts checks the list).
CREATE FUNCTION job_submissions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.marker_state <> 'pending' THEN
      RAISE EXCEPTION 'a submission starts pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.company_id, NEW.job_id, NEW.draft_id, NEW.epoch, NEW.kind, NEW.parent_agreement_id,
      NEW.request_digest, NEW.expires_at, NEW.created_by_actor_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.job_id, OLD.draft_id, OLD.epoch, OLD.kind, OLD.parent_agreement_id,
      OLD.request_digest, OLD.expires_at, OLD.created_by_actor_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a submission''s identity cannot change' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'pending' THEN
    IF NEW.status <> 'pending' THEN
      NEW.decided_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.status, NEW.snapshot_bytes, NEW.snapshot_sha256, NEW.decided_at)
     IS DISTINCT FROM
     (OLD.status, OLD.snapshot_bytes, OLD.snapshot_sha256, OLD.decided_at) THEN
    RAISE EXCEPTION 'a committed or aborted submission cannot change' USING ERRCODE = '23514';
  END IF;
  IF NEW.marker_state IS DISTINCT FROM OLD.marker_state AND NOT (OLD.marker_state = 'pending' AND NEW.marker_state = 'done') THEN
    RAISE EXCEPTION 'a submission''s marker can only go from pending to done' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION job_submissions_guard() FROM PUBLIC;

CREATE TRIGGER job_submissions_guard
  BEFORE INSERT OR UPDATE ON job_submissions
  FOR EACH ROW EXECUTE FUNCTION job_submissions_guard();

-- 2. A pin takes the job's next number. Two pins at once cannot both take n: the second waits on the
-- unique key and is refused when the first commits. Runs as the caller.
CREATE FUNCTION job_price_pins_next_sequence() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.sequence IS DISTINCT FROM (
    SELECT coalesce(max(p.sequence), 0) + 1 FROM public.job_price_pins p
    WHERE p.company_id = NEW.company_id AND p.job_id = NEW.job_id
  ) THEN
    RAISE EXCEPTION 'a price pin must take the job''s next sequence number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION job_price_pins_next_sequence() FROM PUBLIC;

CREATE TRIGGER job_price_pins_next_sequence
  BEFORE INSERT ON job_price_pins
  FOR EACH ROW EXECUTE FUNCTION job_price_pins_next_sequence();

-- 3. An estimate is made from a committed submission, with the job's current pin, and states the hash
-- and engine version of that pin's version. A row the keys will refuse anyway (a missing submission
-- or pin) is left to them. Runs as the caller.
CREATE FUNCTION job_estimates_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  submission_status text;
  pin_sequence integer;
  version_hash text;
  version_engine text;
BEGIN
  SELECT s.status INTO submission_status
  FROM public.job_submissions s WHERE s.company_id = NEW.company_id AND s.id = NEW.submission_id;
  IF FOUND AND submission_status <> 'committed' THEN
    RAISE EXCEPTION 'an estimate is made from a committed submission' USING ERRCODE = '23514';
  END IF;

  SELECT p.sequence, v.content_hash, v.engine_version INTO pin_sequence, version_hash, version_engine
  FROM public.job_price_pins p
  JOIN public.price_table_versions v ON v.company_id = p.company_id AND v.id = p.version_id
  WHERE p.company_id = NEW.company_id AND p.id = NEW.pin_id;
  IF FOUND THEN
    IF NEW.table_hash <> version_hash OR NEW.engine_version <> version_engine THEN
      RAISE EXCEPTION 'an estimate states the hash and engine version of its pinned version' USING ERRCODE = '23514';
    END IF;
    IF pin_sequence <> (
      SELECT max(p.sequence) FROM public.job_price_pins p WHERE p.company_id = NEW.company_id AND p.job_id = NEW.job_id
    ) THEN
      RAISE EXCEPTION 'an estimate uses the job''s current pin' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION job_estimates_guard() FROM PUBLIC;

CREATE TRIGGER job_estimates_guard
  BEFORE INSERT ON job_estimates
  FOR EACH ROW EXECUTE FUNCTION job_estimates_guard();

-- 4. An agreement restates its estimate and submission exactly: the estimate is for this submission,
-- which is committed and of the same kind and parent; the proposal hash, priced result, version,
-- content hash and engine version are the estimate's; the estimate's pin is still the job's current
-- one (signing refuses if the pin moved since the estimate); and the signature is a signature object
-- of this job. A row the keys will refuse anyway is left to them. Runs as the caller.
CREATE FUNCTION agreements_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  estimate public.job_estimates%ROWTYPE;
  submission_status text;
  submission_kind text;
  submission_parent uuid;
  pin_version uuid;
  pin_sequence integer;
  evidence_kind text;
  evidence_job uuid;
BEGIN
  SELECT * INTO estimate FROM public.job_estimates e WHERE e.company_id = NEW.company_id AND e.id = NEW.estimate_id;
  IF FOUND THEN
    IF estimate.submission_id <> NEW.submission_id THEN
      RAISE EXCEPTION 'an agreement is signed for its estimate''s submission' USING ERRCODE = '23514';
    END IF;
    IF NEW.proposal_sha256 <> estimate.proposal_sha256 OR NEW.priced_result <> estimate.priced_result
       OR NEW.content_hash <> estimate.table_hash OR NEW.engine_version <> estimate.engine_version THEN
      RAISE EXCEPTION 'an agreement restates its estimate''s proposal hash, priced result, content hash and engine version' USING ERRCODE = '23514';
    END IF;
    SELECT p.version_id, p.sequence INTO pin_version, pin_sequence
    FROM public.job_price_pins p WHERE p.company_id = estimate.company_id AND p.id = estimate.pin_id;
    IF FOUND THEN
      IF NEW.version_id <> pin_version THEN
        RAISE EXCEPTION 'an agreement names its estimate''s price version' USING ERRCODE = '23514';
      END IF;
      IF pin_sequence <> (
        SELECT max(p.sequence) FROM public.job_price_pins p WHERE p.company_id = NEW.company_id AND p.job_id = NEW.job_id
      ) THEN
        RAISE EXCEPTION 'the job''s price pin has moved since the estimate' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  SELECT s.status, s.kind, s.parent_agreement_id INTO submission_status, submission_kind, submission_parent
  FROM public.job_submissions s WHERE s.company_id = NEW.company_id AND s.id = NEW.submission_id;
  IF FOUND THEN
    IF submission_status <> 'committed' THEN
      RAISE EXCEPTION 'an agreement is signed for a committed submission' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind <> submission_kind OR NEW.parent_agreement_id IS DISTINCT FROM submission_parent THEN
      RAISE EXCEPTION 'an agreement has its submission''s kind and parent' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT o.kind, o.job_id INTO evidence_kind, evidence_job
  FROM public.evidence_objects o WHERE o.company_id = NEW.company_id AND o.id = NEW.signature_evidence_id;
  IF FOUND AND (evidence_kind <> 'signature' OR evidence_job <> NEW.job_id) THEN
    RAISE EXCEPTION 'an agreement''s signature is a signature object of its own job' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION agreements_guard() FROM PUBLIC;

CREATE TRIGGER agreements_guard
  BEFORE INSERT ON agreements
  FOR EACH ROW EXECUTE FUNCTION agreements_guard();

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE job_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE job_price_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_price_pins FORCE ROW LEVEL SECURITY;
ALTER TABLE job_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_estimates FORCE ROW LEVEL SECURITY;
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreements FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company; writing also refuses an active
-- platform operator, who reads a company's records but never changes them. No policy allows DELETE,
-- and none allows UPDATE on pins, estimates or agreements, so a later grant by mistake would still
-- change nothing.
CREATE POLICY job_submissions_select ON job_submissions
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_submissions_insert ON job_submissions
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_submissions_update ON job_submissions
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_price_pins_select ON job_price_pins
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_price_pins_insert ON job_price_pins
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_estimates_select ON job_estimates
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_estimates_insert ON job_estimates
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY agreements_select ON agreements
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY agreements_insert ON agreements
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE (removing a business row is not a runtime action, and
-- TRUNCATE would ignore the policies). Pins, estimates and agreements are read and inserted, never
-- updated. A submission changes its status, snapshot and marker columns only (its decision time is
-- set by the trigger); never its company, id, job, draft, epoch, digest, expiry or creator.
GRANT SELECT, INSERT ON job_submissions, job_price_pins, job_estimates, agreements TO dryscope_runtime;
GRANT UPDATE (status, snapshot_bytes, snapshot_sha256, marker_state) ON job_submissions TO dryscope_runtime;

-- 5. The worker's one lookup across companies (the 0005 pattern). It finds companies with a
-- submission waiting for the worker: a row still pending past its expiry (to abort), or a decided row
-- whose draft marker is not written yet after marker_grace_seconds (a lost marker). It returns
-- company ids only, never submission rows, and runs as the table owner (SECURITY DEFINER). Row-level
-- security is forced, so the owner reads submission rows only through the SELECT policy below, and
-- only while the function runs: the function sets app.submission_scan around its one read, and the
-- policy needs that setting, the owner's rights and a session that signed in as someone else (the
-- runtime calling the function). The runtime is never a member of the owner role, so setting the
-- value itself shows it nothing; the owner signed in as itself fails the last test. Outside the
-- function the owner still reads no submission row, and it can never add, change or remove one
-- through this policy: it is for SELECT only.
CREATE POLICY job_submissions_owner_scan ON job_submissions
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.submission_scan', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.job_submissions'::regclass), 'USAGE')
  );

-- Companies with at least one submission due now, the one waiting longest first, at most
-- max_companies of them (1 to 100). marker_grace_seconds (0 to 86,400) is how long a decided row's
-- marker may stay pending before it counts as lost, so the request that just committed is not raced
-- by the worker. The setting is turned on for the one read and cleared after it; if the read fails,
-- the transaction or savepoint rolls back and the setting with it.
CREATE FUNCTION job_submission_due_companies(max_companies integer, marker_grace_seconds integer) RETURNS SETOF uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF max_companies < 1 OR max_companies > 100 THEN
    RAISE EXCEPTION 'max_companies must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF marker_grace_seconds < 0 OR marker_grace_seconds > 86400 THEN
    RAISE EXCEPTION 'marker_grace_seconds must be between 0 and 86400' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.submission_scan', 'on', true);
  RETURN QUERY
    SELECT s.company_id
    FROM public.job_submissions s
    WHERE (s.status = 'pending' AND s.expires_at <= now())
       OR (s.status <> 'pending' AND s.marker_state = 'pending'
           AND s.decided_at <= now() - make_interval(secs => marker_grace_seconds))
    GROUP BY s.company_id
    ORDER BY min(CASE WHEN s.status = 'pending' THEN s.expires_at ELSE s.decided_at END), s.company_id
    LIMIT max_companies;
  PERFORM set_config('app.submission_scan', '', true);
  RETURN;
END
$$;

-- Functions are executable by everyone by default. Only the runtime may call this one.
REVOKE ALL ON FUNCTION job_submission_due_companies(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_submission_due_companies(integer, integer) TO dryscope_runtime;
