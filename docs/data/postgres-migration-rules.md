# Data: Rebuilt app Postgres: how migrations are changed

Part of [Data](../DATA.md).

Migrations are additive. Change the schema by add, then switch, then remove:

1. Add the new table or column in a migration, and ship the app still able to read the old shape.
2. Switch readers and writers to the new shape only after that migration has been applied.
3. Remove the old shape in a later migration only after a fresh backup of that database and an
   explicit owner approval.

The migrator does not parse SQL for removals. The additive rule is enforced by the owner approving
every migration that removes a table, column or rows, after the backup, and later by a
least-privilege migration role. Each file runs with its ledger row in one transaction; a file that
ends that transaction with its own `COMMIT` or `ROLLBACK` fails and is not recorded. Do not roll
the database backward to make an older image start. Fix forward on the same data. The operator
steps are in
[the migrations runbook](../runbook/migrations.md). Connection failures from the
migrator name the migration and omit the database URL.
