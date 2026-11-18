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
--    jobs already name, or a job in status draft on a submitted draft (security audit F1, step 5),
--    stops this file with an error naming the jobs and changes nothing: which job keeps a draft, and
--    how a stuck job moves on, are the owner's decisions, made before this file runs again.

-- For the fill (3, below). Row-level security is forced on the jobs and their submissions, which binds
-- their owner (the migrator) too, and no policy is the migrator's: the owner reads them with it
-- unforced, inside this file's one transaction, and forces it again before the file ends. It comes
-- first, so the strongest lock on jobs is taken before the claims' foreign key takes a weaker one: a
-- request still running on the previous version, holding a job row, never waits behind this file while
-- this file waits for it.
ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE job_submissions NO FORCE ROW LEVEL SECURITY;

-- 1. The claims.
CREATE TABLE job_drafts (
  company_id uuid NOT NULL,
  -- Made on the phone (a uuid), never by the server.
  draft_id uuid NOT NULL,
  job_id uuid NOT NULL,
  PRIMARY KEY (company_id, draft_id),
  CONSTRAINT job_drafts_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id)
);

-- A job's drafts.
CREATE INDEX job_drafts_company_job ON job_drafts (company_id, job_id);

-- 3. The fill. Before it, two kinds of existing job the owner must settle by hand, each named by company and
-- job id: jobs that name one draft id between them (which job keeps it is the owner's decision), and
-- jobs in status draft whose current draft was already submitted (a committed submission of that
-- draft: the record that marks a draft submitted). Either stops this file and changes nothing.
DO $$
DECLARE
  shared text;
  stuck text;
BEGIN
  WITH named AS (
    SELECT company_id, current_draft_id AS draft_id, id AS job_id FROM jobs
    UNION
    SELECT company_id, draft_id, job_id FROM job_submissions
  ), twice AS (
    SELECT company_id, draft_id FROM named GROUP BY company_id, draft_id HAVING count(*) > 1
  )
  SELECT string_agg(DISTINCT format('%s/%s', n.company_id, n.job_id), ', ')
  INTO shared
  FROM named n JOIN twice t ON t.company_id = n.company_id AND t.draft_id = n.draft_id;

  SELECT string_agg(format('%s/%s', j.company_id, j.id), ', ' ORDER BY j.company_id, j.id)
  INTO stuck
  FROM jobs j
  WHERE j.status = 'draft'
    AND EXISTS (
      SELECT 1 FROM job_submissions s
      WHERE s.company_id = j.company_id AND s.draft_id = j.current_draft_id AND s.status = 'committed'
    );

  IF shared IS NOT NULL OR stuck IS NOT NULL THEN
    RAISE EXCEPTION '0016_job_drafts stops before its fill; the owner settles these jobs (company/job) first. A field draft id named by more than one job: %. A job in status draft on a submitted draft: %.',
      coalesce(shared, 'none'), coalesce(stuck, 'none')
      USING ERRCODE = '23514';
  END IF;
END
$$;

INSERT INTO job_drafts (company_id, draft_id, job_id)
SELECT company_id, current_draft_id, id FROM jobs
UNION
SELECT company_id, draft_id, job_id FROM job_submissions;

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
