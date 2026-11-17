-- Each field draft id belongs to one job (security audit F1): the one database job of the fix. This
-- file adds one table and fills it from the rows already there; no table or row of 0001 to 0015
-- changes.
--
-- 1. job_drafts: every draft id a job has been on, recorded once per company with its job. The
--    phone makes every draft id; the server claims it in the same transaction that puts a job on it
--    (a new job, a copy, Back to editing), and a draft id already claimed, by another job or by an
--    earlier draft of the same job, is refused. So no job ever takes another job's draft, even one
--    that job has submitted and moved on from, and the server names a job's field owner only on the
--    drafts this table gives to the job.
-- 2. Insert-only for the runtime: no UPDATE, DELETE or TRUNCATE, so a claim never moves to another
--    job. Every row belongs to a company and is held only inside withCompany (0003); a platform
--    operator reads them through withOperator, and the insert policy refuses an active operator.
-- 3. The fill: each job's current draft and the draft of each of its submissions. A draft id that two
--    jobs already name stops this file with an error and changes nothing: which job keeps it is the
--    owner's decision, made before this file runs again.

-- 1. The claims.
CREATE TABLE job_drafts (
  company_id uuid NOT NULL,
  -- Made on the phone (a uuid), never by the server.
  draft_id uuid NOT NULL,
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, draft_id),
  CONSTRAINT job_drafts_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id)
);

-- A job's drafts, oldest first.
CREATE INDEX job_drafts_company_job ON job_drafts (company_id, job_id, created_at);

-- 3. The fill. Row-level security is forced on the jobs and their submissions, which binds their
-- owner (the migrator) too, and no policy is the migrator's: the owner reads them here with it
-- unforced, inside this file's one transaction, and forces it again before the file ends.
ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE job_submissions NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT company_id, current_draft_id AS draft_id, id AS job_id FROM jobs
      UNION
      SELECT company_id, draft_id, job_id FROM job_submissions
    ) AS named
    GROUP BY company_id, draft_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'a field draft id is named by more than one job; the owner decides which job keeps it before 0016_job_drafts runs'
      USING ERRCODE = '23505';
  END IF;
END
$$;

INSERT INTO job_drafts (company_id, draft_id, job_id, created_at)
SELECT company_id, draft_id, job_id, min(named_at)
FROM (
  SELECT company_id, current_draft_id AS draft_id, id AS job_id, created_at AS named_at FROM jobs
  UNION ALL
  SELECT company_id, draft_id, job_id, created_at FROM job_submissions
) AS named
GROUP BY company_id, draft_id, job_id;

ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE job_submissions FORCE ROW LEVEL SECURITY;

-- 2. Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE job_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_drafts FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company (so the platform operator reads them
-- through withOperator, S3-9); writing also refuses an active platform operator. No policy allows
-- UPDATE or DELETE.
CREATE POLICY job_drafts_select ON job_drafts
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_drafts_insert ON job_drafts
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights: insert-only.
GRANT SELECT, INSERT ON job_drafts TO dryscope_runtime;
