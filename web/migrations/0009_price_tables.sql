-- Company price tables (S4-5): where each company's published prices and its one working copy live
-- (docs/plans/pricing.md). This file only adds two tables, their triggers and their rights; nothing
-- in 0001 to 0008 changes. No route reads or writes them yet (S4-6).
--
-- 1. price_table_versions: every published table, whole, numbered 1, 2, 3 for its company. A version
--    is never changed or removed: the runtime has SELECT and INSERT only, and no policy allows more.
--    "Current prices" is the company's highest sequence. The hash and engine version sit beside the
--    content (the engine version is not inside the hash, plan correction S4-3 b).
-- 2. price_table_working_copies: the one table the owner is editing, one row per company, named so it
--    is not confused with job drafts. It remembers the version it started from (none for a company
--    still on its starter list) and a revision that rises by one on every change, so a save made from
--    an older copy can be refused as stale.
-- 3. Both tables hold a company's rows only inside withCompany (0003). A platform operator reads a
--    company's prices through withOperator with that company set; the write policies below refuse an
--    active operator, so an operator can never change a company's prices.
-- 4. content is jsonb and SQL cannot check prices: the one Zod schema (PriceTableV3) checks them at
--    write and read, and the app re-checks the hash on read. The database holds the shape checks
--    below and the keys that stop one company's rows naming another's.

CREATE TABLE price_table_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  -- 1 for a company's first publication, then each next number: no gaps, no repeats (trigger below).
  sequence integer NOT NULL CHECK (sequence >= 1),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  -- SHA-256 of the canonical JSON of the parsed table, as 64 lowercase hex characters.
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- The engine that prices this version, such as dryscope-v3. Which names are known stays in code, so
  -- a new engine version needs no migration; an unknown one is refused when a job is priced.
  engine_version text NOT NULL CHECK (engine_version ~ '^dryscope-v[0-9]{1,3}$'),
  -- The owner's change reason: 3 to 500 characters, no padding.
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 3 AND 500),
  -- What the published working copy started from: a blank company's starter list, an imported file,
  -- or an earlier version restored into it.
  source text NOT NULL CHECK (source IN ('blank', 'import', 'restore')),
  published_by_actor_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  -- Sent with each publish, so a retried request finds its version instead of making another.
  publish_key text NOT NULL CHECK (publish_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  -- Composite keys: a later row (a job's price pin, S5a) names a version by company and id, or by
  -- company and sequence, and can never name another company's.
  CONSTRAINT price_table_versions_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT price_table_versions_company_sequence_key UNIQUE (company_id, sequence),
  CONSTRAINT price_table_versions_company_publish_key_key UNIQUE (company_id, publish_key),
  CONSTRAINT price_table_versions_published_by_fkey FOREIGN KEY (company_id, published_by_actor_id)
    REFERENCES actors (company_id, id)
);

CREATE TABLE price_table_working_copies (
  company_id uuid PRIMARY KEY REFERENCES companies (id),
  -- The sequence of the version this copy started from or was last published as; empty until a
  -- company's first publication or restore.
  base_sequence integer CHECK (base_sequence >= 1),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  -- 1 when the row is created, then one more with every change.
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- An empty base_sequence matches no version, so the key only checks a copy that names one.
  CONSTRAINT price_table_working_copies_base_fkey FOREIGN KEY (company_id, base_sequence)
    REFERENCES price_table_versions (company_id, sequence)
);

-- A version takes the company's next number. Two publishes at once cannot both take n: the second
-- waits on the unique key and is refused when the first commits. A publish that skipped ahead or
-- reused an old number is refused here. Runs as the caller, so under the caller's row-level security.
CREATE FUNCTION price_table_version_next_sequence() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.sequence IS DISTINCT FROM (
    SELECT coalesce(max(v.sequence), 0) + 1 FROM public.price_table_versions v WHERE v.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'a price table version must take the company''s next sequence number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION price_table_version_next_sequence() FROM PUBLIC;

CREATE TRIGGER price_table_versions_next_sequence
  BEFORE INSERT ON price_table_versions
  FOR EACH ROW EXECUTE FUNCTION price_table_version_next_sequence();

-- A working copy starts at revision 1 and rises by exactly one with each change, so a save that
-- carries a stale revision, or one that would skip or rewind it, is refused.
CREATE FUNCTION price_table_working_copy_revision() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'a new working copy starts at revision 1' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'a working copy revision rises by exactly one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION price_table_working_copy_revision() FROM PUBLIC;

CREATE TRIGGER price_table_working_copies_revision
  BEFORE INSERT OR UPDATE ON price_table_working_copies
  FOR EACH ROW EXECUTE FUNCTION price_table_working_copy_revision();

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE price_table_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_table_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE price_table_working_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_table_working_copies FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company; writing also refuses an active
-- platform operator, who reads a company's prices but never changes them. No policy allows UPDATE or
-- DELETE on versions, so a later grant by mistake would still change nothing.
CREATE POLICY price_table_versions_select ON price_table_versions
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY price_table_versions_insert ON price_table_versions
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY price_table_working_copies_select ON price_table_working_copies
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY price_table_working_copies_insert ON price_table_working_copies
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY price_table_working_copies_update ON price_table_working_copies
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE (removing a business row is not a runtime action, and
-- TRUNCATE would ignore the policies). A version is read and inserted, never updated. A working copy
-- changes its content, base version, revision and time only; its company never changes.
GRANT SELECT, INSERT ON price_table_versions TO dryscope_runtime;
GRANT SELECT, INSERT ON price_table_working_copies TO dryscope_runtime;
GRANT UPDATE (base_sequence, content, revision, updated_at) ON price_table_working_copies TO dryscope_runtime;
