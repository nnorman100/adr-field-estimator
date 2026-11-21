# Postgres migrations for the rebuilt app

`web/migrations` is a numbered ledger. Files are named `0001_name.sql`, `0002_name.sql`, and so on. From `web/`, `npm run db:migrate` applies each missing file in order, in its own transaction that takes the migration lock and rereads the ledger, before a new version of the rebuilt app takes traffic. It records the file id and a SHA-256 of the file bytes in `migration_ledger`. A second run applies nothing. A gap in the numbers, or a file whose bytes changed after it was applied, stops the run. The command reads `APP_ENV` and `DATABASE_URL` from the environment, then from `web/.env.local` for any that are unset. On Cloud Run it reads `SQL_CONNECTION_NAME`, `SQL_DATABASE_NAME` and `SQL_IAM_USER` instead of `DATABASE_URL` and logs in over the instance's `/cloudsql` socket with an access token as the password. The test release workflow runs it before a new revision is staged as the Cloud Run job `dryscope-migrate-test`, inside Google, as `dryscope-migrate-test`: the image carries it as `/app/migrate.mjs` (bundled from `web/src/db/job.ts` by `web/scripts/build-migrate.mjs`) with the ledger in `/app/migrations` ([Release the rebuilt app to test](test-release.md#release-the-rebuilt-app-to-test)). Nothing runs it against live.

Schema changes follow add, then switch, then remove:

1. Add the new table or column in a migration, and ship the app still able to read the old shape.
2. Switch readers and writers to the new shape only after that migration has been applied.
3. Remove the old shape in a later migration only after a fresh backup of that database and an explicit owner approval.

The migrator does not parse SQL for removals: a migration that removes a table, column or rows needs the fresh backup and the owner's explicit approval before it merges, and a later least-privilege migration role will back that up. Each file runs with its ledger row in one transaction; a file that ends that transaction with its own `COMMIT` or `ROLLBACK` fails and is not recorded. Do not roll the database backward to make an older image start. Fix forward on the same data. The same rule is the data contract in [DATA.md](../data/postgres-migration-rules.md).

## Before 0016_job_drafts (security audit F1)

`0016_job_drafts` claims each field draft id for one job. Before its fill it stops, changing nothing and naming each job, when two jobs name one draft id or a job in status `draft` is on a draft with a committed submission in Postgres. A draft can also be `submitted` in the field database alone (for example after Postgres is restored to just before Submit committed), and SQL cannot read Firestore. So before the release that carries 0016 reaches an environment that holds jobs, the owner runs this read-only check for that environment (agents never run it):

1. Export the jobs in status `draft` as the migrator, which owns the table, with row-level security unforced only inside a transaction that is rolled back, as 0016 does itself (from Cloud Shell or any machine that reaches the instance, as in [test release part B](test-release.md)):

   ```sql
   BEGIN;
   ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
   \copy (SELECT company_id, id, current_draft_id FROM jobs WHERE status = 'draft' ORDER BY 1, 2) TO 'draft-jobs.csv' CSV
   ROLLBACK;
   ```

2. From `web/`, with your own `gcloud auth application-default login`: `npm run platform:check-draft-states -- --project dryscope --database dryscope-field-test < draft-jobs.csv` (`--database dryscope-field-live` for live, in project `dryscope` while live shares it with test). It reads each job's current draft and prints `company/job` for every job whose draft is `submitted`, then the counts. It exits 1 when any job is listed.

A listed job, like one 0016 names itself, is the owner's to settle before 0016 runs; nothing moves it automatically. An environment with no jobs yet exports an empty file, and the check prints `checked 0 jobs`. Delete `draft-jobs.csv` afterwards: it holds ids only, but it is not kept.
