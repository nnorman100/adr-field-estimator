-- The field revision of a job: one version number for everything that decides its Firestore drafts'
-- life cycle (the draft life-cycle redesign, Design 2, slice 1). This file only adds: three columns
-- and their triggers, one more column for the repair pass, one lookup function, and the job revision
-- guard of 0015 widened to let the new columns change alone. No table, row or policy of 0001 to 0017
-- is removed. Nothing reads or writes these columns yet: the sync that does comes in later slices.
--
-- 1. jobs.field_revision: rises by exactly one, inside the database, every time an input of the
--    drafts' life cycle changes: the job's status, current draft or field owner (a trigger on jobs),
--    its coordination row (inserted, or its revision moving), a submission (inserted, or its status
--    moving), a draft id claimed for it (job_drafts), and the sign-in uid of its field owner
--    (actors). Nothing else moves it: not the address, the job revision alone, office notes saved
--    without a coordination revision, a submission's marker, or another person's uid. A change can
--    therefore never miss its bump, because no writer has to remember it.
-- 2. jobs.field_synced_revision: the highest field_revision whose state the sync has written to
--    Firestore. The sync raises it after its Firestore commit; the database leaves it to the sync.
-- 3. jobs.field_changed_at: when field_revision last rose, set by the same trigger from the clock at
--    the bump (not the transaction's start, which a wait for the job lock can make look older), so the
--    repair pass leaves a job alone for a short grace while the request that changed it is still
--    syncing it.
-- 4. jobs.copied_from_job_id: the job a copy was made from (in the same company), so a copy's first
--    draft can be built from its source's signed record. Copy sets it when it inserts the copy, or on a
--    retry while it is empty; a trigger on the job_copied audit row sets it too, so a copy the previous
--    version makes (while a release rolls out, or after a rollback the runbook allows) gets it in its
--    own transaction; existing copies are filled from those audit rows (below). Set once, never changed.
-- 5. job_field_sync_due_companies(max, grace): the repair worker's one lookup across companies, on the
--    0005 pattern: company ids only.
--
-- The runtime may raise field_revision only by one at a time (the bump below), and may set
-- field_synced_revision; field_changed_at is the trigger's alone. Every bump from another table runs
-- as the caller, under the caller's row-level security, and is refused when it cannot reach the job
-- (an active platform operator, or a role with no policy on jobs), so a change is never committed
-- without its bump.
--
-- Lock order: a bump from another table locks the job row after that table's row, so every writer
-- locks the job row first. Every route does, and the submission worker does since #482 (test release
-- 2026.11.19-7), which must be serving before this file runs: an older worker deadlocks against
-- Submit once these triggers exist, so no rollback goes behind that release once this is applied.

-- 1 to 4. The columns. jobs is changed first, so its strongest lock is taken before the triggers on the
-- other tables take theirs. Existing jobs start at 0 and synced at 0: nothing to repair until a change.
ALTER TABLE jobs
  ADD COLUMN field_revision bigint NOT NULL DEFAULT 0 CHECK (field_revision >= 0),
  ADD COLUMN field_synced_revision bigint NOT NULL DEFAULT 0 CHECK (field_synced_revision >= 0),
  ADD COLUMN field_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN copied_from_job_id uuid,
  ADD CONSTRAINT jobs_copied_from_fkey FOREIGN KEY (company_id, copied_from_job_id) REFERENCES jobs (company_id, id);

-- The repair pass's jobs: behind their sync, oldest change first.
CREATE INDEX jobs_field_sync_due ON jobs (field_changed_at, company_id) WHERE field_synced_revision < field_revision;

-- 1. A new job starts at field revision 0, synced at 0 (its draft claim bumps it). On an update, the
-- field revision rises by one when the status, current draft or field owner changes, or when the
-- statement asks for a bump (field_revision + 1, the triggers below); any other value is refused.
-- Runs as the caller. Named to fire before jobs_guard_revision (triggers fire in name order), though
-- the guard below does not depend on that order.
CREATE FUNCTION jobs_field_revision() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.field_revision <> 0 OR NEW.field_synced_revision <> 0 THEN
      RAISE EXCEPTION 'a new job starts at field revision 0' USING ERRCODE = '23514';
    END IF;
    NEW.field_changed_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.field_revision <> OLD.field_revision AND NEW.field_revision <> OLD.field_revision + 1 THEN
    RAISE EXCEPTION 'a job field revision rises by exactly one' USING ERRCODE = '23514';
  END IF;
  NEW.field_revision := OLD.field_revision + 1;
  NEW.field_changed_at := clock_timestamp();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION jobs_field_revision() FROM PUBLIC;

CREATE TRIGGER jobs_field_revision_insert
  BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_field_revision();

CREATE TRIGGER jobs_field_revision_update
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  WHEN (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.current_draft_id IS DISTINCT FROM OLD.current_draft_id
    OR NEW.field_owner_actor_id IS DISTINCT FROM OLD.field_owner_actor_id
    OR NEW.field_revision IS DISTINCT FROM OLD.field_revision
  )
  EXECUTE FUNCTION jobs_field_revision();

-- The job revision guard of 0015, the same but for the field columns: an update that changes nothing
-- but the field owner, the field revision, the synced revision or the copy source (with the change time
-- the trigger above sets) keeps the job revision. A copy's source is set once: from empty to a job, never
-- changed or cleared after. An update that changes nothing at all is still refused, as in 0010: the sync's
-- acknowledgement writes only a newer watermark (WHERE field_synced_revision < v). Every other rule of
-- 0010 and 0015 is unchanged.
CREATE OR REPLACE FUNCTION jobs_guard_revision() RETURNS trigger
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
  ELSIF OLD.copied_from_job_id IS NOT NULL AND NEW.copied_from_job_id IS DISTINCT FROM OLD.copied_from_job_id THEN
    RAISE EXCEPTION 'a copy''s source is set once' USING ERRCODE = '23514';
  ELSIF NEW.revision = OLD.revision
     AND (NEW.field_owner_actor_id IS DISTINCT FROM OLD.field_owner_actor_id
          OR NEW.field_revision IS DISTINCT FROM OLD.field_revision
          OR NEW.field_synced_revision IS DISTINCT FROM OLD.field_synced_revision
          OR NEW.copied_from_job_id IS DISTINCT FROM OLD.copied_from_job_id)
     AND to_jsonb(NEW) - 'field_owner_actor_id' - 'field_revision' - 'field_synced_revision' - 'field_changed_at' - 'copied_from_job_id'
       = to_jsonb(OLD) - 'field_owner_actor_id' - 'field_revision' - 'field_synced_revision' - 'field_changed_at' - 'copied_from_job_id' THEN
    RETURN NEW;
  ELSIF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'a job revision rises by exactly one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- 4. The fill: each existing copy's source, from its job_copied audit row (details.copiedFrom, the
-- target being the copy's id), when that names a job of the same company. Row-level security is forced
-- on jobs and the audit log, which binds their owner (the migrator) too, and no policy is the
-- migrator's: the owner reads and fills them with it unforced, inside this file's one transaction, and
-- forces it again right after (as 0016 does). The fill changes no status, draft or owner, so it moves
-- no field revision, and the guard above lets it keep the job revision.
ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;

UPDATE jobs j
SET copied_from_job_id = s.id
FROM audit_events a
JOIN jobs s ON s.company_id = a.company_id
  AND (a.details ->> 'copiedFrom') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND s.id = (a.details ->> 'copiedFrom')::uuid
WHERE a.action = 'job_copied'
  AND a.company_id = j.company_id
  AND a.target = j.id::text
  AND s.id <> j.id
  AND j.copied_from_job_id IS NULL;

ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- The bump from another table: raises the field revision of the row's job, as the caller. Refused
-- when the caller cannot update that job (the foreign keys guarantee it exists).
CREATE FUNCTION job_field_revision_bump() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.jobs SET field_revision = field_revision + 1
  WHERE company_id = NEW.company_id AND id = NEW.job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the job''s field revision cannot be raised here' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION job_field_revision_bump() FROM PUBLIC;

-- The coordination row: made, or its revision moved (the field owner's or the notes' change; the
-- drafts carry it while the rollout writes the legacy fieldOwnerRevision key).
CREATE TRIGGER job_coordination_field_revision_insert
  AFTER INSERT ON job_coordination
  FOR EACH ROW EXECUTE FUNCTION job_field_revision_bump();

CREATE TRIGGER job_coordination_field_revision_update
  AFTER UPDATE ON job_coordination
  FOR EACH ROW
  WHEN (NEW.revision IS DISTINCT FROM OLD.revision)
  EXECUTE FUNCTION job_field_revision_bump();

-- A submission: made (Submit's intent, which fences the draft), or its status moved (committed or
-- aborted). Its marker moving is not a change of the drafts' state.
CREATE TRIGGER job_submissions_field_revision_insert
  AFTER INSERT ON job_submissions
  FOR EACH ROW EXECUTE FUNCTION job_field_revision_bump();

CREATE TRIGGER job_submissions_field_revision_update
  AFTER UPDATE ON job_submissions
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION job_field_revision_bump();

-- A draft id claimed for the job (a new job, a copy, Back to editing, the missing-draft remake).
CREATE TRIGGER job_drafts_field_revision
  AFTER INSERT ON job_drafts
  FOR EACH ROW EXECUTE FUNCTION job_field_revision_bump();

-- A person's sign-in uid changing: the drafts name the field owner by uid, so every job whose field
-- work that person owns moves. No route changes a uid today, but the runtime's grant on actors allows
-- it. Refused when the caller cannot raise every one of those jobs (an active platform operator).
CREATE FUNCTION actors_field_revision() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  owned bigint;
  raised bigint;
BEGIN
  SELECT count(*) INTO owned FROM public.jobs
  WHERE company_id = NEW.company_id AND field_owner_actor_id = NEW.id;
  UPDATE public.jobs SET field_revision = field_revision + 1
  WHERE company_id = NEW.company_id AND field_owner_actor_id = NEW.id;
  GET DIAGNOSTICS raised = ROW_COUNT;
  IF raised <> owned THEN
    RAISE EXCEPTION 'the field revision of this person''s jobs cannot be raised here' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION actors_field_revision() FROM PUBLIC;

CREATE TRIGGER actors_field_revision
  AFTER UPDATE ON actors
  FOR EACH ROW
  WHEN (NEW.uid IS DISTINCT FROM OLD.uid AND NEW.company_id IS NOT NULL)
  EXECUTE FUNCTION actors_field_revision();

-- The copy source from the job_copied audit row that Copy writes in the copy's own transaction
-- (details.copiedFrom, the target being the copy's id), so the previous version's copies get it too.
-- Only while the copy has none, and only a job of the same company; an id that is not one, or a job the
-- caller cannot change, sets nothing and never fails the audit write. Runs as the caller.
CREATE FUNCTION audit_events_copy_source() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.company_id IS NULL
     OR NEW.details ->> 'copiedFrom' IS NULL
     OR (NEW.details ->> 'copiedFrom') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NEW.target IS NULL
     OR NEW.target !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  UPDATE public.jobs j SET copied_from_job_id = s.id
  FROM public.jobs s
  WHERE j.company_id = NEW.company_id
    AND j.id = NEW.target::uuid
    AND j.copied_from_job_id IS NULL
    AND s.company_id = NEW.company_id
    AND s.id = (NEW.details ->> 'copiedFrom')::uuid
    AND s.id <> j.id;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION audit_events_copy_source() FROM PUBLIC;

CREATE TRIGGER audit_events_copy_source
  AFTER INSERT ON audit_events
  FOR EACH ROW
  WHEN (NEW.action = 'job_copied')
  EXECUTE FUNCTION audit_events_copy_source();

-- Table rights: the bump (field_revision, only ever by one, as the trigger above holds), the sync's
-- watermark, and the copy source (set once, as the guard holds; inserting it is covered by the
-- runtime's INSERT on jobs, 0010). No UPDATE of field_changed_at or of anything else is granted.
GRANT UPDATE (field_revision, field_synced_revision, copied_from_job_id) ON jobs TO dryscope_runtime;

-- 5. The repair worker's one lookup across companies (the 0005 pattern). It finds companies with a
-- job whose drafts are behind its field revision, changed more than grace_seconds ago so the request
-- that changed it is not raced. It returns company ids only, never jobs, and runs as the table owner
-- (SECURITY DEFINER). Row-level security is forced, so the owner reads jobs only through the SELECT
-- policy below, and only while the function runs: the function sets app.field_sync_scan around its
-- one read, and the policy needs that setting, the owner's rights and a session that signed in as
-- someone else (the runtime calling the function). The runtime is never a member of the owner role,
-- so setting the value itself shows it nothing; the owner signed in as itself fails the last test.
-- Outside the function the owner still reads no job, and it can never add, change or remove one
-- through this policy: it is for SELECT only.
CREATE POLICY jobs_owner_field_sync_scan ON jobs
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.field_sync_scan', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.jobs'::regclass), 'USAGE')
  );

-- Companies with at least one job due now, the one waiting longest first, at most max_companies of
-- them (1 to 100). grace_seconds is 0 to 86,400. The setting is turned on for the one read and
-- cleared after it; if the read fails, the transaction or savepoint rolls back and the setting with
-- it. Written as 0017 asks of a new definer function: pg_temp searched last, types named by schema.
CREATE FUNCTION job_field_sync_due_companies(max_companies pg_catalog.int4, grace_seconds pg_catalog.int4) RETURNS SETOF pg_catalog.uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF max_companies < 1 OR max_companies > 100 THEN
    RAISE EXCEPTION 'max_companies must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF grace_seconds < 0 OR grace_seconds > 86400 THEN
    RAISE EXCEPTION 'grace_seconds must be between 0 and 86400' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('app.field_sync_scan', 'on', true);
  RETURN QUERY
    SELECT j.company_id
    FROM public.jobs j
    WHERE j.field_synced_revision < j.field_revision
      AND j.field_changed_at <= pg_catalog.now() - pg_catalog.make_interval(secs => grace_seconds)
    GROUP BY j.company_id
    ORDER BY pg_catalog.min(j.field_changed_at), j.company_id
    LIMIT max_companies;
  PERFORM pg_catalog.set_config('app.field_sync_scan', '', true);
  RETURN;
END
$$;

-- Functions are executable by everyone by default. Only the runtime may call this one.
REVOKE ALL ON FUNCTION job_field_sync_due_companies(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_field_sync_due_companies(integer, integer) TO dryscope_runtime;
