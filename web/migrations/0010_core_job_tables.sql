-- Core job tables (S5a-2, docs/plans/S5.md): where a job's official header, customer, claim and
-- evidence registry live, and the company profile the documents are built from. This file only
-- adds; nothing in 0001 to 0009 changes except that `companies` gains five columns. No route
-- reads or writes any of it yet (S5a-3 to S5a-5).
--
-- 1. jobs: one row per job, made from a client-made uuid so a retried create finds its row instead
--    of making another. The key is (company_id, id), not id alone, so company B posting company
--    A's job id collides with nothing and learns nothing. A job names its first draft (the
--    Firestore field draft, docs/data-ownership.md) and the one it is on now.
-- 2. job_customers and job_claims: one row per job each, written by the routes of S5a-3 (J3).
-- 3. evidence_objects: the registry of stored bytes (photo, full-size original, signature). A row is
--    inserted once and never changed: the runtime has SELECT and INSERT only. A row can name only
--    an object under its own company's and job's path in the evidence bucket.
-- 4. companies gets the profile the four documents print (address, phone, email, licence, sign-off).
--    The runtime may change those columns of its own company and nothing else; that only the owner
--    may is the route's rule (profile_manage), as the plan says.
-- 5. Every row belongs to a company and is held only inside withCompany (0003). A platform operator
--    reads a company's rows through withOperator with that company set; every write policy below
--    refuses an active operator, so an operator can never change a job, its customer or claim, the
--    evidence registry, or a company's profile. Every key between rows carries company_id, so a row
--    can never point at another company's job or person.
-- 6. Nothing here is removed by the runtime: no DELETE and no TRUNCATE on any table.

-- 4. The company profile. Empty means not set: the engine's setup check lists a missing licence or
-- sign-off before documents are built (S5a-4). One line each, no padding.
ALTER TABLE companies
  ADD COLUMN profile_address text NOT NULL DEFAULT '',
  ADD COLUMN profile_phone text NOT NULL DEFAULT '',
  ADD COLUMN profile_email text NOT NULL DEFAULT '',
  ADD COLUMN profile_license text NOT NULL DEFAULT '',
  ADD COLUMN profile_signoff text NOT NULL DEFAULT '',
  ADD CONSTRAINT companies_profile_address_check
    CHECK (profile_address = btrim(profile_address) AND char_length(profile_address) <= 500 AND profile_address !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_phone_check
    CHECK (profile_phone = btrim(profile_phone) AND char_length(profile_phone) <= 80 AND profile_phone !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_email_check
    CHECK (
      profile_email = lower(btrim(profile_email)) AND char_length(profile_email) <= 254
      AND (profile_email = '' OR profile_email ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$')
    ),
  ADD CONSTRAINT companies_profile_license_check
    CHECK (profile_license = btrim(profile_license) AND char_length(profile_license) <= 80 AND profile_license !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_signoff_check
    CHECK (profile_signoff = btrim(profile_signoff) AND char_length(profile_signoff) <= 150 AND profile_signoff !~ '[[:cntrl:]]');

-- 1. Jobs.
CREATE TABLE jobs (
  -- Made on the phone (a uuid), never by the server.
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  created_by_actor_id uuid NOT NULL,
  -- The estimator who owns the field work. Empty until someone does: an office-made job has none
  -- until the first capture (S5b-1).
  field_owner_actor_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'signed', 'archived')),
  -- The Firestore field draft this job is on now (also made on the phone). Back to editing moves it
  -- to a new draft; the earlier draft ids stay with their submissions (S5a-7).
  current_draft_id uuid NOT NULL,
  -- The property the work is at: one line, empty until the technician enters it.
  property_address text NOT NULL DEFAULT ''
    CHECK (property_address = btrim(property_address) AND char_length(property_address) <= 500 AND property_address !~ '[[:cntrl:]]'),
  archived_at timestamptz,
  archived_by_actor_id uuid,
  -- 1 when the job is created, then one more with every change (trigger below), so an update made
  -- from an older copy can be refused as stale. last_change_id is the client's id for the latest
  -- change: a retry that carries it again is the same change, not a conflict.
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_change_id uuid,
  -- SHA-256 of the create request, as 64 lowercase hex characters: the same id and body is the same
  -- job, the same id with another body is refused.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  -- One job per draft: two jobs cannot claim the same field draft.
  CONSTRAINT jobs_company_current_draft_key UNIQUE (company_id, current_draft_id),
  CONSTRAINT jobs_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT jobs_field_owner_fkey FOREIGN KEY (company_id, field_owner_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT jobs_archived_by_fkey FOREIGN KEY (company_id, archived_by_actor_id)
    REFERENCES actors (company_id, id),
  -- Archived exactly when it says when and by whom.
  CONSTRAINT jobs_archived_check CHECK (
    (status = 'archived') = (archived_at IS NOT NULL) AND (archived_at IS NULL) = (archived_by_actor_id IS NULL)
  )
);

-- Company jobs newest first, and one person's jobs (an estimator lists their own and assigned).
CREATE INDEX jobs_company_created ON jobs (company_id, created_at DESC, id);
CREATE INDEX jobs_company_created_by ON jobs (company_id, created_by_actor_id);
CREATE INDEX jobs_company_field_owner ON jobs (company_id, field_owner_actor_id) WHERE field_owner_actor_id IS NOT NULL;

-- 2. The customer and the claim: at most one row each per job, made when first saved.
CREATE TABLE job_customers (
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  name text NOT NULL DEFAULT ''
    CHECK (name = btrim(name) AND char_length(name) <= 150 AND name !~ '[[:cntrl:]]'),
  phone text NOT NULL DEFAULT ''
    CHECK (phone = btrim(phone) AND char_length(phone) <= 80 AND phone !~ '[[:cntrl:]]'),
  email text NOT NULL DEFAULT ''
    CHECK (
      email = lower(btrim(email)) AND char_length(email) <= 254
      AND (email = '' OR email ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$')
    ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, job_id),
  CONSTRAINT job_customers_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id)
);

-- The claim fields the documents print (web/src/engine/documents.ts): the same limits, one line each.
CREATE TABLE job_claims (
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  carrier text NOT NULL DEFAULT ''
    CHECK (carrier = btrim(carrier) AND char_length(carrier) <= 150 AND carrier !~ '[[:cntrl:]]'),
  claim_number text NOT NULL DEFAULT ''
    CHECK (claim_number = btrim(claim_number) AND char_length(claim_number) <= 80 AND claim_number !~ '[[:cntrl:]]'),
  policy_number text NOT NULL DEFAULT ''
    CHECK (policy_number = btrim(policy_number) AND char_length(policy_number) <= 80 AND policy_number !~ '[[:cntrl:]]'),
  -- Empty when not known. That it is a real past date is the Zod schema's check, not SQL's.
  date_of_loss date,
  loss_cause text NOT NULL DEFAULT ''
    CHECK (loss_cause = btrim(loss_cause) AND char_length(loss_cause) <= 500 AND loss_cause !~ '[[:cntrl:]]'),
  adjuster_name text NOT NULL DEFAULT ''
    CHECK (adjuster_name = btrim(adjuster_name) AND char_length(adjuster_name) <= 150 AND adjuster_name !~ '[[:cntrl:]]'),
  adjuster_email text NOT NULL DEFAULT ''
    CHECK (
      adjuster_email = lower(btrim(adjuster_email)) AND char_length(adjuster_email) <= 254
      AND (adjuster_email = '' OR adjuster_email ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$')
    ),
  adjuster_phone text NOT NULL DEFAULT ''
    CHECK (adjuster_phone = btrim(adjuster_phone) AND char_length(adjuster_phone) <= 80 AND adjuster_phone !~ '[[:cntrl:]]'),
  -- Text as the policy states it, such as $1,000: the documents print it as written.
  deductible text NOT NULL DEFAULT ''
    CHECK (deductible = btrim(deductible) AND char_length(deductible) <= 40 AND deductible !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, job_id),
  CONSTRAINT job_claims_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id)
);

-- 3. The evidence registry: one row per stored object. A photo and its full-size original share an
-- object_id and differ in kind. The surrogate id and its composite key let a later row (an
-- agreement's signature, S5a-7) name an object by company and id.
CREATE TABLE evidence_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  job_id uuid NOT NULL,
  -- The client-made id of the photo or signature.
  object_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('photo', 'original', 'signature')),
  -- The object's name in the evidence bucket. It must sit under this row's own company and job, and
  -- hold only letters, digits and . _ - / (no uid, no person's name, no dot segments), so a row
  -- can never register another company's or job's bytes.
  object_name text NOT NULL CHECK (
    char_length(object_name) <= 1024
    AND object_name ~ '^[A-Za-z0-9._/-]+$'
    AND object_name !~ '(^|/)\.{1,2}(/|$)'
    AND object_name !~ '/$'
    AND starts_with(object_name, 'companies/' || company_id::text || '/jobs/' || job_id::text || '/')
  ),
  -- The bucket's generation number of the stored object (an int64).
  generation bigint NOT NULL CHECK (generation >= 1),
  -- SHA-256 of the stored bytes, as 64 lowercase hex characters.
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 1073741824),
  -- The media type, such as image/jpeg: lowercase, type and subtype, no parameters.
  content_type text NOT NULL CHECK (content_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_objects_company_id_id_key UNIQUE (company_id, id),
  -- One row per object and kind for a job, and one row per bucket name: a retried receipt finds its
  -- row instead of making another.
  CONSTRAINT evidence_objects_job_object_kind_key UNIQUE (company_id, job_id, object_id, kind),
  CONSTRAINT evidence_objects_company_object_name_key UNIQUE (company_id, object_name),
  CONSTRAINT evidence_objects_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT evidence_objects_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id)
);

-- A job starts as a draft at revision 1, and each change raises the revision by exactly one, so a
-- save that carries a stale revision, or one that would skip or rewind it, is refused. Runs as the
-- caller, so under the caller's row-level security.
CREATE FUNCTION jobs_guard_revision() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'a new job starts at revision 1' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a new job starts as a draft' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'a job revision rises by exactly one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION jobs_guard_revision() FROM PUBLIC;

CREATE TRIGGER jobs_guard_revision
  BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_guard_revision();

-- 4. What the runtime may change on a company, by context. In a company's own transaction only the
-- profile columns (the grant below leaves status and sign-in tenant open for operators, and a
-- policy cannot see which column changed); in an operator's context everything but the profile.
-- 0006's guard keeps the rest. The table owner keeps its repair path, as there.
CREATE FUNCTION companies_guard_context_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.companies'::regclass), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF (SELECT public.app_operator_active()) THEN
    IF NEW.profile_address IS DISTINCT FROM OLD.profile_address
      OR NEW.profile_phone IS DISTINCT FROM OLD.profile_phone
      OR NEW.profile_email IS DISTINCT FROM OLD.profile_email
      OR NEW.profile_license IS DISTINCT FROM OLD.profile_license
      OR NEW.profile_signoff IS DISTINCT FROM OLD.profile_signoff THEN
      RAISE EXCEPTION 'a platform operator cannot change a company''s profile' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.auth_tenant_id IS DISTINCT FROM OLD.auth_tenant_id THEN
    RAISE EXCEPTION 'a company cannot change its own status or sign-in tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION companies_guard_context_change() FROM PUBLIC;

CREATE TRIGGER companies_guard_context_change
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_guard_context_change();

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE job_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_customers FORCE ROW LEVEL SECURITY;
ALTER TABLE job_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_objects FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company; writing also refuses an active
-- platform operator, who reads a company's jobs but never changes them. No policy allows DELETE, and
-- none allows UPDATE on the evidence registry, so a later grant by mistake would still change nothing.
CREATE POLICY jobs_select ON jobs
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY jobs_insert ON jobs
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY jobs_update ON jobs
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_customers_select ON job_customers
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_customers_insert ON job_customers
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_customers_update ON job_customers
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_claims_select ON job_claims
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_claims_insert ON job_claims
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_claims_update ON job_claims
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY evidence_objects_select ON evidence_objects
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY evidence_objects_insert ON evidence_objects
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- A company changes its own profile columns and nothing about another company. This sits beside
-- 0006's operator policy; the trigger above holds the column rules for each context.
CREATE POLICY companies_profile_update ON companies
  FOR UPDATE TO dryscope_runtime
  USING (id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE (removing a business row is not a runtime action, and
-- TRUNCATE would ignore the policies). A job, customer or claim changes only the columns named
-- here: never its company, its id, its creator, the create digest or its creation time. A registry
-- row is read and inserted, never updated.
GRANT SELECT, INSERT ON jobs, job_customers, job_claims, evidence_objects TO dryscope_runtime;
GRANT UPDATE (
  field_owner_actor_id, status, current_draft_id, property_address, archived_at, archived_by_actor_id,
  revision, last_change_id, updated_at
) ON jobs TO dryscope_runtime;
GRANT UPDATE (name, phone, email, updated_at) ON job_customers TO dryscope_runtime;
GRANT UPDATE (
  carrier, claim_number, policy_number, date_of_loss, loss_cause, adjuster_name, adjuster_email,
  adjuster_phone, deductible, updated_at
) ON job_claims TO dryscope_runtime;
-- The profile columns of the company's own row (updated_at is already granted by 0006).
GRANT UPDATE (profile_address, profile_phone, profile_email, profile_license, profile_signoff) ON companies TO dryscope_runtime;
