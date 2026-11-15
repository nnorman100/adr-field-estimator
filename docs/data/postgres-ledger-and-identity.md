# Data: Rebuilt app Postgres: backups, ledger and identity tables

Part of [Data](../DATA.md).

## Rebuilt app Postgres (not deployed)

The TypeScript app in `web/` keeps a Postgres schema beside the Firestore data above. Nothing in
that schema is applied to Cloud SQL yet. Once the owner finishes the setup in
[the test release runbook](../runbook/test-release.md), the test release workflow applies it to
the test instance only, as `dryscope-migrate-test` from the Cloud Run job of that name, before each new revision takes traffic; nothing
applies it to live. An agent does not create the instance, run Terraform or change
IAM. The owner applies infrastructure. There is no earlier Postgres schema to backfill, and the
Firestore records in this file are unchanged.

Cloud SQL backups: automated daily backups and point-in-time recovery are on, and the backups are
kept in the US multi-region (`us`), not in the instance's region, so a regional outage cannot take
them too. Only backups taken after that setting is applied are kept in `us`; earlier ones stay in
`us-central1`, so the owner takes one on-demand backup after the apply to check its location, and
another after the first migrations. There is no second-region export or replica. If `us-central1`
is lost, the latest backup is restored into a new instance in another region
([the backups runbook](../runbook/backups.md#restore-into-another-region)), losing at most one day; point-in-time
recovery is not available then. The restored instance is the data copy only: the app runs in
`us-central1` and stays down until that region returns, and a second-region app is a decision to
revisit at launch. A quarterly drill restores into a different region once. Firestore stays in its
own region with its own point-in-time recovery.

The schema is a numbered ledger. Files in `web/migrations` are named `0001_name.sql`,
`0002_name.sql`, and so on. `npm run db:migrate` applies each missing file in order, inside its own
transaction, and records the file id and a SHA-256 of its bytes in `migration_ledger`. A second run
applies nothing. A changed file that was already applied stops the run. A gap in the numbers stops
the run before anything new is written. Migrations run before a new version of the rebuilt app
takes traffic. The first migration creates `migration_ledger` and an empty `companies` table (`id`
uuid, `created_at` timestamptz). Those two tables hold no personal data.

`0002_identity` adds the sign-in and company-separation tables. `companies` gains `name`,
`sign_in_slug` (the company's sign-in address), `status` (active, suspended, archived) and
`auth_tenant_id` (unique: one sign-in tenant names one company; the owner decided D3 on 2026-11-09,
option A, one sign-in tenant per company, which is why the column is unique). A company row made
before `0002` is kept and named "Unnamed company". New tables: `actors` (a signed-in person, unique
by `(auth_tenant_id, uid)`, never matched by email alone; an actor of a company carries that
company's `auth_tenant_id`), `memberships` (owner, estimator or office; one active owner per company
and one active membership per actor), `invitations` (pending, accepted or cancelled; expiry is
`expires_at`), `auth_tenants` (every sign-in tenant, each either a company's tenant or an
operator-only tenant, never both), `platform_admins` (operators are actors with no company, signed
in through an operator tenant, per owner decision D6), `audit_events` (ids and counts only in
`details`; `actor_id` is a member of the event's company and `operator_actor_id` a platform
operator), `company_feature_flags` (a missing row means off, and so does a name not in `web/src/lib/flags/`;
only an operator changes one, per D12, through `0008` below)
and `access_projection_outbox` (actors whose Firestore access record must follow a committed
membership change). Rows that refer to another company row carry `company_id` in a composite key,
so a membership, invitation, audit event or outbox row can never point at an actor or invitation of
another company. `actors.email`, `actors.display_name` and `invitations.email` are personal data.
Emails are stored lowercase and tenant ids, uids, emails and display names without surrounding
spaces, so one person is one stored key. The team and invitation routes (S3-10,
`web/src/lib/team/`) write actors, memberships, invitations, audit events and outbox rows, always
inside `withCompany`; an invitation's record, with its email, stays after it is accepted,
cancelled or cleared ("clear" only hides it from the team list); nothing in `web/` deletes it yet.
The access projection (below) marks outbox rows done, and the platform operator routes (S3-9, `web/src/lib/platform/`, `0006` below) create companies, change their status and sign-in tenant, register company tenants and write owner invitations, memberships, outbox rows and audit rows, and change a company's feature flags (S3-11b); nothing else writes these tables yet. Prices and signed documents are later work.
