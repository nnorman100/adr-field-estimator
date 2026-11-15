-- Office jobs, assignment and field owner (S5b-1, docs/plans/S5.md): the one database job of the
-- step. This file only adds three tables; nothing in 0001 to 0014 changes.
--
-- 1. job_assignments: an estimator assigned to a job by the owner or office (`assignment`). An
--    assignment is made from a client-made uuid, so a retried assign finds its row instead of making
--    a second one, and the server keeps the SHA-256 of the request beside it. Unassigning ends the
--    row (ended_at, ended_by), never deletes it: at most one active row per job and estimator, and an
--    ended row never changes again. An estimator sees the jobs they are actively assigned.
-- 2. job_coordination: the office notes of a job, one row per job, made when first saved. Owner and
--    office (`coordination`) read and write them; an estimator never sees them (the customer view).
-- 3. agreement_corrections: a correction of an address, name or contact field on a signed job (for
--    S5b-4, which adds the routes). Insert-only: the runtime has SELECT and INSERT, so a correction
--    is never changed or removed, and the signed agreement it sits beside never changes either.
-- 4. Every row belongs to a company and is held only inside withCompany (0003). A platform operator
--    reads a company's rows through withOperator; every write policy refuses an active operator. No
--    DELETE and no TRUNCATE for the runtime; a trigger holds which columns of an assignment may change.

-- 1. Assignments.
CREATE TABLE job_assignments (
  -- Made on the phone (a uuid), never by the server.
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  -- The estimator assigned. That it is an active estimator of the company is the route's check.
  estimator_actor_id uuid NOT NULL,
  -- SHA-256 of the assign request: the same id and body is the same assignment.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  assigned_by_actor_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by_actor_id uuid,
  PRIMARY KEY (company_id, id),
  CONSTRAINT job_assignments_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT job_assignments_estimator_fkey FOREIGN KEY (company_id, estimator_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT job_assignments_assigned_by_fkey FOREIGN KEY (company_id, assigned_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT job_assignments_ended_by_fkey FOREIGN KEY (company_id, ended_by_actor_id)
    REFERENCES actors (company_id, id),
  -- Ended exactly when it says when and by whom.
  CONSTRAINT job_assignments_ended_check CHECK ((ended_at IS NULL) = (ended_by_actor_id IS NULL))
);

-- One active assignment per job and estimator; the jobs an estimator is assigned now.
CREATE UNIQUE INDEX job_assignments_one_active ON job_assignments (company_id, job_id, estimator_actor_id) WHERE ended_at IS NULL;
CREATE INDEX job_assignments_company_estimator ON job_assignments (company_id, estimator_actor_id) WHERE ended_at IS NULL;

-- 2. Office notes: at most one row per job. Several lines are allowed (a tab, a line feed, a
-- carriage return); no other control character.
CREATE TABLE job_coordination (
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  office_notes text NOT NULL DEFAULT ''
    CHECK (char_length(office_notes) <= 4000 AND office_notes !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, job_id),
  CONSTRAINT job_coordination_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id)
);

-- 3. Corrections after signing (S5b-4). One row per corrected field, with who and when; the newest
-- row of a field is what the documents show beside the unchanged signed bytes.
CREATE TABLE agreement_corrections (
  -- Made on the phone (a uuid), never by the server.
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  field text NOT NULL CHECK (field IN ('property_address', 'customer_name', 'customer_phone', 'customer_email')),
  -- One line, with the limits of the column it corrects (0010): the address 500, a name 150, a phone
  -- 80, an email 254 and lower case in an email's form (or empty).
  value text NOT NULL CHECK (value = btrim(value) AND char_length(value) <= 500 AND value !~ '[[:cntrl:]]'),
  -- SHA-256 of the correction request: the same id and body is the same correction.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  CONSTRAINT agreement_corrections_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT agreement_corrections_agreement_fkey FOREIGN KEY (company_id, job_id, agreement_id)
    REFERENCES agreements (company_id, job_id, id),
  CONSTRAINT agreement_corrections_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT agreement_corrections_name_check CHECK (field <> 'customer_name' OR char_length(value) <= 150),
  CONSTRAINT agreement_corrections_phone_check CHECK (field <> 'customer_phone' OR char_length(value) <= 80),
  CONSTRAINT agreement_corrections_email_check CHECK (
    field <> 'customer_email'
    OR (value = lower(value) AND char_length(value) <= 254
      AND (value = '' OR value ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'))
  )
);

CREATE INDEX agreement_corrections_company_agreement ON agreement_corrections (company_id, agreement_id, created_at);

-- What an assignment may do. Its identity (company, id, job, estimator, request digest, who assigned
-- it and when) never changes. An active assignment may end once, the end time from the clock here;
-- an ended one never changes again. Runs as the caller, under the caller's row-level security. A
-- column added later is frozen until this function names it.
CREATE FUNCTION job_assignments_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.estimator_actor_id IS DISTINCT FROM OLD.estimator_actor_id
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.assigned_by_actor_id IS DISTINCT FROM OLD.assigned_by_actor_id
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
    RAISE EXCEPTION 'an assignment''s identity never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended assignment never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.ended_by_actor_id IS NULL THEN
    RAISE EXCEPTION 'an assignment changes only by ending' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION job_assignments_guard() FROM PUBLIC;

CREATE TRIGGER job_assignments_guard
  BEFORE UPDATE ON job_assignments
  FOR EACH ROW EXECUTE FUNCTION job_assignments_guard();

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE job_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE job_coordination ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_coordination FORCE ROW LEVEL SECURITY;
ALTER TABLE agreement_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_corrections FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company (so the platform operator reads them
-- through withOperator, S3-9); writing also refuses an active platform operator. No policy allows
-- DELETE, and none allows UPDATE on the corrections.
CREATE POLICY job_assignments_select ON job_assignments
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_assignments_insert ON job_assignments
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_assignments_update ON job_assignments
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_coordination_select ON job_coordination
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_coordination_insert ON job_coordination
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_coordination_update ON job_coordination
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY agreement_corrections_select ON agreement_corrections
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY agreement_corrections_insert ON agreement_corrections
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE. Only the columns an assignment's end and the notes
-- change may be updated; the corrections are insert-only.
GRANT SELECT, INSERT ON job_assignments, job_coordination, agreement_corrections TO dryscope_runtime;
GRANT UPDATE (ended_at, ended_by_actor_id) ON job_assignments TO dryscope_runtime;
GRANT UPDATE (office_notes, updated_at) ON job_coordination TO dryscope_runtime;
