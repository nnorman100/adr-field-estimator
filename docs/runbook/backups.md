# Backups

What to do when something goes wrong with the rebuilt app's data, in one table. Every procedure is owner-run; agents never run it against Google Cloud. The commands are in `infra/dryscope/scripts/restore-drill.sh` (S8-5): run it with `--dry-run` first to see every command it would run, with no call made. The drill rehearses all of it on test (S8-21). Last restore drill: [not recorded — run the drill on test].

| What happened | What to do | Where | Never |
| --- | --- | --- | --- |
| A bad release | Roll back: move traffic to the recorded earlier revision (the release record's command; S8-19's rollback workflow once it exists). The database stays as it is: it only moves forward. | [Releases](test-release.md) | Restore the database for a bad release |
| Damaged rows | A point-in-time copy into a new instance, to the minute before the damage; compare; copy back only the damaged rows, by id; then the records check for each company. | [Damaged rows](#damaged-rows) | Repoint the app at the copy: rows written since that minute would be lost |
| A zone outage (the instance is lost) | A point-in-time copy into another zone of `us-central1`, checked, then the recovery repoint (S8-6). | [Zone outage](#zone-outage) | Delete the original instance |
| A `us-central1` region outage | Backup salvage only: the latest automated daily backup (location `us`) restored into another region as a data copy. The app waits for Google's recovery; there is no repoint. | [Restore into another region](#restore-into-another-region) | Point the app at the salvage copy |
| Field database damage | Restore its latest backup into a new database and compare; copy back only the damaged documents. | [Field database](#field-database) | Restore over the live database |
| A deleted or overwritten file | Restore the object from soft delete, or copy an earlier version back over it. | [A deleted file](#a-deleted-file) | Change the bucket's lifecycle or soft-delete settings by hand |

Where the copies live: the Cloud SQL instances (`dryscope-<env>-pg`) keep automated backups in the US multi-region (`us`, set in `infra/dryscope/data/sql.tf`) and seven days (test: three) of point-in-time recovery, which needs the instance's own region. The field database (`dryscope-field-<env>`) has point-in-time recovery and a daily backup kept 14 days. The evidence bucket (`dryscope-evidence-<env>`) keeps earlier versions for 28 days, then 7 days of soft delete.

Owner decision, 2026-11-17: "for the pilot, a us-central1 regional outage is accepted as waiting for Google's recovery, with up to about 24 hours of data at risk from the last daily backup. The 15-minute recovery target covers a bad change, damaged data and a zone outage only. Cross-region protection is decided together with high availability before the first paying customer."

## The drill (test only)

`infra/dryscope/scripts/restore-drill.sh --env test --domain <domain> --zone <a us-central1 zone other than the database's>` runs nine timed phases against test: two marker jobs made through the app around a chosen minute; a point-in-time copy to that minute, in that other zone (the script refuses the original's zone and checks where the copy landed); checks on the copy (migration ledger complete, first marker there, second not, row counts per table), then the data root applied with `sql_instance_override` naming the copy and the web app's own database account logging in to it; backup salvage into another region from the latest automated daily backup, with the backup's age; the field database's latest backup restored and one draft compared with its rooms and photo references, by id; one evidence object restored from soft delete and one from an earlier version; the S8-6 app-root repoint and its put-back; removal of the drill's own instances, database and objects; and a result block to paste into `docs/drills/<date>-restore.md`. It deletes only names ending in `-drill`, refuses live, and waits for you at each Terraform apply. Each printed Terraform block is one command, to paste as it is, that applies only when the plan check accepts the plan. Phase 7 checks that each revision it moves names the right instance (`SQL_CONNECTION_NAME`) and that the candidate tag and all traffic reach it. If the drill stops after the admission or the repoint, it prints the put-back steps: run them before anything else, and delete the drill's copies only afterwards.

Before you start: `gcloud auth login` and `gcloud auth application-default login`, as the same account; `cloud-sql-proxy` (v2), `psql`, `curl` and `jq` installed; every Terraform variable you pass to the data and app roots besides the env file exported as `TF_VAR_<name>` (at least `TF_VAR_api_image`, `TF_VAR_live_image` and `TF_VAR_alert_email`, plus `TF_VAR_workload_identity_principal_set` and any other you set), because the printed blocks pass only the env file and the override; Service Account Token Creator on `dryscope-api-<env>` for the app's login check. No test release may run during the drill: pause test releases ([Releases](test-release.md), "To pause test releases") and set the variable back afterwards. The checks add your account to each copy only, with `gcloud sql users create <you> --type=cloud_iam_user --database-roles=<the migrator>` (no IAM change, so nothing admits the app early), then, through an Auth Proxy listening on a socket in the script's own private directory (never a proxy left from another runbook), read every table as the migrator inside one transaction that is rolled back, so the copy's data stays exactly as restored. The migration ledger must be the first migrations of `web/migrations`, with no gap and nothing unknown: a copy can predate a release, and your checkout can hold migrations not yet released (pull it if the check names an unknown one). Before any repoint the serving revision must be no newer than the copy's point in time, so the copy holds the migrations it needs. The chosen point in time must be recoverable (`gcloud sql instances get-latest-recovery-time`): the drill waits for it, and an incident run stops and prints the latest recoverable time.

## Damaged rows

`restore-drill.sh --env <env> --recovery --point-in-time <UTC minute before the damage>` makes the copy `dryscope-<env>-pg-<stamp>`, checks it, stops there and prints these steps. It never repoints and never deletes.

Row-level security is forced on every table and no policy names the migrator (apart from the migration ledger), so a plain read or `UPDATE` by the migrator sees no rows: an `UPDATE` would report `UPDATE 0` and change nothing.

1. Read the damaged rows by company id and id from the copy, through the Auth Proxy as your own account with `SET ROLE` to the migrator and `FORCE` lifted inside a transaction that is rolled back (as the script's checks do), and the same rows on the original as the migrator (signed in the way `npm run db:migrate` is run). Compare them.
2. Never write a signed record or another guarded table's rows: the guard triggers refuse it, and a trigger is never disabled. A damaged signed record is an owner decision, recorded in a sidecar; the record itself stays as it is.
3. On the original, as the migrator, one transaction per table, scoped to the company and the damaged ids:
   ```sql
   BEGIN;
   ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;
   UPDATE <table> SET ... WHERE company_id = '<company id>' AND id IN (<damaged ids>);
   -- psql prints UPDATE <n>: unless n is exactly the number of ids, run ROLLBACK; and stop.
   ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
   COMMIT;
   ```
   No other session sees the table without `FORCE`: the lock holds until the commit, which puts it back. Rows written since that minute stay.
4. Run the records check for each company (operator screen, "Check records"; S8-3 and S8-4).
5. Delete the copy only when you decide to.

## Zone outage

`restore-drill.sh --env <env> --recovery --lost-instance --point-in-time <UTC time> --zone <another us-central1 zone> --domain <domain>` (both required, with the `TF_VAR_` exports above) makes the copy in that zone (refusing the original's zone when the original still answers, and checking where the copy landed), checks it, waits while you apply the data root with `-var sql_instance_override=<the copy>` (the admission only; the services stay on the original), checks that the web app's account logs in to the copy, checks that the serving revision is no newer than the point in time, then prints the app root's repoint and the tag, check and traffic commands, with the serving revision recorded. Run those once the checks pass: apply the app root with the same override; take the fresh revision and check that its `SQL_CONNECTION_NAME` names the copy (a revision made by anything else is not the repoint); tag it `candidate` and check that the tag reaches it; check `https://candidate.<host>/api/health` reports database `ok`; move all traffic to it and check that all traffic reaches it; then read health at the serving address. Keep the recovered database serving; a return to the original is a separate owner decision (S8-6).

## Restore into another region

Use this when `us-central1` is down. `restore-drill.sh --env <env> --recovery --salvage` runs these steps (phase 4) and records the backup's age. The instance and its backups are never deleted. The restored instance is the data copy only: the services run in `us-central1`, so the app stays down until that region returns.

1. List backups at project level, without `--instance` (that flag lists backup runs, which have no name, and fails while the instance's region is down): `gcloud sql backups list --project=<project> --filter=instance=dryscope-<env>-pg --format=json`. Take the newest whose type is `AUTOMATED` (the daily backup, never a later on-demand or final one), whose state is `SUCCESSFUL` and whose location is `us`. Never use one whose location is `us-central1`: backups taken before the location moved stay there and are lost with the region.
2. Restore it into a new instance in another region: `gcloud sql backups restore <backup name> --restore-instance=dryscope-<env>-pg-salvage-<stamp> --region=us-east1 --project=<project>`. Pass the backup name, not the numeric id (an id restores only onto an existing instance).
3. Check it through the Auth Proxy on the restored copy, never the source, as your own account added to the copy with the migrator's role: `migration_ledger` holds the first migrations of `web/migrations` with no gap and nothing unknown (the backup can predate a release), and the row counts per table.
4. Record the copy's name, region, the backup used and its age in the incident record. Leave Terraform alone until the region is back: the data root still names the original. Importing the copy or rebuilding is a separate owner decision.

## Field database

The drill (phase 5) restores the latest backup with `gcloud firestore databases restore --source-backup=<backup> --destination-database=dryscope-field-<env>-<stamp>` and compares one draft that has not changed since the backup (`companies/<company id>/drafts/<draft id>`): the draft document, its rooms and its photo references, each by id with its fields, as the app loads them. A restored database is a new database in the same location: it starts with deny-all rules and without its expiry (TTL) policies, and the app never points at it. For real damage, read the damaged documents from the restored copy (or from point-in-time recovery, within 7 days) and write back only those documents, then run the records check for each company.

## A deleted file

The evidence bucket keeps versioning and soft delete. An overwritten object: copy its earlier generation back over it (`gcloud storage cp gs://<bucket>/<object>#<generation> gs://<bucket>/<object> --project=<project>`). A deleted earlier version: it is in soft delete for 7 days; restore it with `gcloud storage restore gs://<bucket>/<object>#<generation> --project=<project>`. The drill (phase 6) does both with its own objects under `drill/`, then removes them. Then run the records check for the company.

## Old app

The retired app (`alert-disaster-field-2026`) copied logins and evidence photos daily to a separate vault bucket (7-day soft delete, 90-day lifecycle); see `docs/VAULT-BACKUP.md`. Nothing above uses it.
