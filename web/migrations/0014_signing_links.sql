-- Signing links and document links (S5a-11b, docs/plans/S5.md; the step's detail is S5b-3): the
-- one database job of the step. This file only adds; nothing in 0001 to 0013 changes except that
-- `agreements` gains two nullable columns with their checks.
--
-- 1. signing_links: a homeowner signing link for one estimate of one job. The token is made by the
--    server, shown once to the technician and never stored: only its SHA-256 is. A link is made
--    `pending` and ends once: `used` (it signed: the agreement it made is named), `revoked` (the
--    technician revoked it, or made a newer link for the job) or `voided` (the job has a newer
--    submission or estimate than the one the link signs). It works for 7 days from when it was made;
--    a used link shows the signed record for 30 days after signing. At most one pending link per job.
--    A retried create with the same link id replaces the token hash (the token nobody saw stops
--    working). The counters hold the per-link limits: signing attempts, and reads in the current
--    minute.
-- 2. document_links: a read-only link to one signed agreement's homeowner or adjuster set, the token
--    kept as a SHA-256 only, for 30 days from when it was made, revocable. At most one active link
--    per agreement and set. Both sets' links are made in the signing transaction; the owner or office
--    may revoke one and make it again.
-- 3. agreements.signing_link_id: the link an agreement was signed through, set exactly when the
--    signer kind is `link`, and pointing at a link for that same estimate, so the locked record says
--    which link was used. A link signs at most one agreement. agreements.signer_role: who signed,
--    as the signer said (`homeowner`, `adjuster` or `other`, docs/spec.md 2.5); a signing link asks
--    it, so it is set for every link signature; signing on the phone does not ask it.
-- 4. signing_link_company(sha256) and document_link_company(sha256): the one lookup before a
--    company is known, on the 0004 pattern: a token's hash to its company id, nothing else. Every
--    other read runs inside withCompany under the company policies below.
-- 5. Every row belongs to a company and is held only inside withCompany (0003). A platform operator
--    reads a company's rows through withOperator; every write policy refuses an active operator. No
--    DELETE and no TRUNCATE for the runtime; triggers hold which columns may change and how.

-- 1. Signing links.
CREATE TABLE signing_links (
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  -- The estimate the link signs: its proposal and prices are what the homeowner sees and signs.
  estimate_id uuid NOT NULL,
  -- SHA-256 of the token, never the token. Unique across companies: the lookup finds one link.
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'revoked', 'voided')),
  -- SHA-256 of the create request: the same id and body is the same link (its token replaced).
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  token_issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by_actor_id uuid,
  agreement_id uuid,
  used_at timestamptz,
  sign_attempts integer NOT NULL DEFAULT 0 CHECK (sign_attempts BETWEEN 0 AND 1000000),
  read_window_start timestamptz NOT NULL DEFAULT now(),
  read_count integer NOT NULL DEFAULT 0 CHECK (read_count BETWEEN 0 AND 1000000),
  PRIMARY KEY (company_id, id),
  CONSTRAINT signing_links_token_key UNIQUE (token_sha256),
  CONSTRAINT signing_links_company_job_id_key UNIQUE (company_id, job_id, id),
  -- An agreement names its link with the estimate it signed (agreements_signing_link_fkey).
  CONSTRAINT signing_links_company_id_estimate_key UNIQUE (company_id, id, estimate_id),
  CONSTRAINT signing_links_company_agreement_key UNIQUE (company_id, agreement_id),
  CONSTRAINT signing_links_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT signing_links_estimate_fkey FOREIGN KEY (company_id, job_id, estimate_id)
    REFERENCES job_estimates (company_id, job_id, id),
  CONSTRAINT signing_links_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT signing_links_ended_by_fkey FOREIGN KEY (company_id, ended_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT signing_links_agreement_fkey FOREIGN KEY (company_id, job_id, agreement_id)
    REFERENCES agreements (company_id, job_id, id),
  -- Seven days to sign, from when the link was made.
  CONSTRAINT signing_links_expiry_check CHECK (expires_at = created_at + interval '7 days'),
  CONSTRAINT signing_links_used_check
    CHECK ((status = 'used') = (agreement_id IS NOT NULL) AND (agreement_id IS NULL) = (used_at IS NULL)),
  CONSTRAINT signing_links_ended_check CHECK ((status IN ('revoked', 'voided')) = (ended_at IS NOT NULL)),
  CONSTRAINT signing_links_ended_by_check CHECK (ended_by_actor_id IS NULL OR status = 'revoked')
);

-- One pending link per job: a newer link revokes the older one in the same transaction.
CREATE UNIQUE INDEX signing_links_one_pending_per_job ON signing_links (company_id, job_id) WHERE status = 'pending';

-- 2. Document links.
CREATE TABLE document_links (
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  -- The homeowner's set (the signed proposal and the photo log) or the adjuster's (the itemized
  -- claim, the scope defense letter and the claim).
  document_set text NOT NULL CHECK (document_set IN ('homeowner', 'adjuster')),
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  token_issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by_actor_id uuid,
  read_window_start timestamptz NOT NULL DEFAULT now(),
  read_count integer NOT NULL DEFAULT 0 CHECK (read_count BETWEEN 0 AND 1000000),
  PRIMARY KEY (company_id, id),
  CONSTRAINT document_links_token_key UNIQUE (token_sha256),
  CONSTRAINT document_links_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT document_links_agreement_fkey FOREIGN KEY (company_id, job_id, agreement_id)
    REFERENCES agreements (company_id, job_id, id),
  CONSTRAINT document_links_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT document_links_ended_by_fkey FOREIGN KEY (company_id, ended_by_actor_id)
    REFERENCES actors (company_id, id),
  -- Thirty days to view, from when the link was made.
  CONSTRAINT document_links_expiry_check CHECK (expires_at = created_at + interval '30 days'),
  CONSTRAINT document_links_ended_check CHECK ((status = 'revoked') = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX document_links_one_active_per_set ON document_links (company_id, agreement_id, document_set) WHERE status = 'active';

-- 3. Which link an agreement was signed through, and the signer's role. Every agreement so far was
-- signed on a device, with no role asked, so every existing row passes the checks.
ALTER TABLE agreements
  ADD COLUMN signing_link_id uuid,
  ADD COLUMN signer_role text,
  ADD CONSTRAINT agreements_signer_role_check CHECK (signer_role IN ('homeowner', 'adjuster', 'other')),
  ADD CONSTRAINT agreements_link_signer_role_check CHECK (signer_kind <> 'link' OR signer_role IS NOT NULL),
  ADD CONSTRAINT agreements_signing_link_check CHECK ((signer_kind = 'link') = (signing_link_id IS NOT NULL)),
  ADD CONSTRAINT agreements_company_signing_link_key UNIQUE (company_id, signing_link_id),
  ADD CONSTRAINT agreements_signing_link_fkey FOREIGN KEY (company_id, signing_link_id, estimate_id)
    REFERENCES signing_links (company_id, id, estimate_id);

-- What a signing link may do. Its identity (company, id, job, estimate, creator, creation time,
-- expiry, request digest) never changes. A pending link may stay pending (its token replaced by a
-- retried create, its counters moved) or end once: used, revoked or voided, the end time from the
-- clock here. An ended link changes only its read counters. Runs as the caller, under the caller's
-- row-level security. A column added later is frozen until this function names it.
CREATE FUNCTION signing_links_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.estimate_id IS DISTINCT FROM OLD.estimate_id
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a signing link''s identity never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
       OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at
       OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by_actor_id IS DISTINCT FROM OLD.ended_by_actor_id
       OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id OR NEW.used_at IS DISTINCT FROM OLD.used_at
       OR NEW.sign_attempts IS DISTINCT FROM OLD.sign_attempts THEN
      RAISE EXCEPTION 'an ended signing link changes only its read counters' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'pending' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.ended_by_actor_id IS NOT NULL OR NEW.agreement_id IS NOT NULL OR NEW.used_at IS NOT NULL THEN
      RAISE EXCEPTION 'a pending signing link has not ended' USING ERRCODE = '23514';
    END IF;
    IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 THEN
      NEW.token_issued_at := now();
    ELSIF NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at THEN
      RAISE EXCEPTION 'a signing link''s token time moves only with a new token' USING ERRCODE = '23514';
    END IF;
    IF NEW.sign_attempts < OLD.sign_attempts THEN
      RAISE EXCEPTION 'signing attempts are never taken back' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at
     OR NEW.sign_attempts < OLD.sign_attempts THEN
    RAISE EXCEPTION 'a signing link ends with the token it had' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'used' THEN
    NEW.used_at := now();
  ELSE
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION signing_links_guard() FROM PUBLIC;

CREATE TRIGGER signing_links_guard
  BEFORE UPDATE ON signing_links
  FOR EACH ROW EXECUTE FUNCTION signing_links_guard();

-- What a document link may do: the same rules, with `active` in place of `pending` and `revoked`
-- the only end.
CREATE FUNCTION document_links_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
     OR NEW.document_set IS DISTINCT FROM OLD.document_set OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a document link''s identity never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
       OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at
       OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by_actor_id IS DISTINCT FROM OLD.ended_by_actor_id THEN
      RAISE EXCEPTION 'a revoked document link changes only its read counters' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'active' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.ended_by_actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'an active document link has not ended' USING ERRCODE = '23514';
    END IF;
    IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 THEN
      NEW.token_issued_at := now();
    ELSIF NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at THEN
      RAISE EXCEPTION 'a document link''s token time moves only with a new token' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at THEN
    RAISE EXCEPTION 'a document link ends with the token it had' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION document_links_guard() FROM PUBLIC;

CREATE TRIGGER document_links_guard
  BEFORE UPDATE ON document_links
  FOR EACH ROW EXECUTE FUNCTION document_links_guard();

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE signing_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_links FORCE ROW LEVEL SECURITY;
ALTER TABLE document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_links FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company; writing also refuses an active
-- platform operator. No policy allows DELETE.
CREATE POLICY signing_links_select ON signing_links
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY signing_links_insert ON signing_links
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY signing_links_update ON signing_links
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY document_links_select ON document_links
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY document_links_insert ON document_links
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY document_links_update ON document_links
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE. Only the columns a link's life changes may be updated.
GRANT SELECT, INSERT ON signing_links, document_links TO dryscope_runtime;
GRANT UPDATE (token_sha256, status, ended_at, ended_by_actor_id, agreement_id, used_at, sign_attempts, read_window_start, read_count)
  ON signing_links TO dryscope_runtime;
GRANT UPDATE (token_sha256, status, ended_at, ended_by_actor_id, read_window_start, read_count)
  ON document_links TO dryscope_runtime;

-- 4. The lookups before a company is known (the 0004 pattern). Each runs as the table owner
-- (SECURITY DEFINER). Row-level security is forced, so the owner reads link rows only through the
-- SELECT policies below, and only while the function runs: the function sets app.link_lookup around
-- its one read, and the policy needs that setting, the owner's rights and a session that signed in
-- as someone else (the runtime calling the function). The runtime is never a member of the owner
-- role, so setting the value itself shows it nothing; the owner signed in as itself fails the last
-- test. The policies are for SELECT only. Each function returns one company id or NULL, never a row.
CREATE POLICY signing_links_owner_lookup ON signing_links
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.link_lookup', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.signing_links'::regclass), 'USAGE')
  );

CREATE POLICY document_links_owner_lookup ON document_links
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.link_lookup', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.document_links'::regclass), 'USAGE')
  );

CREATE FUNCTION signing_link_company(token_sha256 text) RETURNS uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  found uuid;
BEGIN
  PERFORM set_config('app.link_lookup', 'on', true);
  SELECT l.company_id INTO found FROM public.signing_links l WHERE l.token_sha256 = signing_link_company.token_sha256;
  PERFORM set_config('app.link_lookup', '', true);
  RETURN found;
END
$$;

CREATE FUNCTION document_link_company(token_sha256 text) RETURNS uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  found uuid;
BEGIN
  PERFORM set_config('app.link_lookup', 'on', true);
  SELECT l.company_id INTO found FROM public.document_links l WHERE l.token_sha256 = document_link_company.token_sha256;
  PERFORM set_config('app.link_lookup', '', true);
  RETURN found;
END
$$;

-- Functions are executable by everyone by default. Only the runtime may call these.
REVOKE ALL ON FUNCTION signing_link_company(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signing_link_company(text) TO dryscope_runtime;
REVOKE ALL ON FUNCTION document_link_company(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_link_company(text) TO dryscope_runtime;
