# Data: Rebuilt app Postgres: runtime role, row-level security, lookups and the platform operator

Part of [Data](../DATA.md).

`0003_runtime_role` adds the second lock. It creates `dryscope_runtime`, a role with no login, no
`BYPASSRLS` and no ownership, and grants it to the environment's API database user
(`dryscope-api-<env>@dryscope.iam`) by inheritance only, so that user cannot `SET ROLE`; where no
such user exists (CI) it grants nothing, and it refuses an API user that is a superuser or bypasses
row-level security. Every table has row-level security enabled and forced, with a policy. The
runtime sees and changes a company's rows only inside `withCompany` (`web/src/db/tenant.ts`), which
sets `app.company_id` for one transaction; outside it, including the `''` a pooled connection keeps
after such a transaction, every policy matches nothing. Inside it the runtime reads its company,
the company's sign-in tenant and its feature flags; reads, inserts and updates its actors,
memberships, invitations and outbox rows; and reads and appends audit events, never updating or
deleting them. The runtime has no `DELETE` or `TRUNCATE` anywhere, no right on `migration_ledger`,
and sees no platform operator. Platform operator access across companies is in `0006` (below). The outbox worker's one lookup across companies is in `0005` (below). Forced row-level security binds the
migrator too: only `migration_ledger` has a policy for its owner (`companies` adds one that only
`sign_in_company` can use, see below), so a migration that must change
rows turns `FORCE` off and back on inside its own transaction (the guard test in
`web/tests/db/row-level-security.test.ts` fails a table left without forced row-level security or a
policy).

`0004_sign_in_lookup` adds the one lookup allowed before a company is known. A request knows only
the tenant in its verified sign-in token, so the runtime calls `sign_in_company(tenant)`, which
returns that company's id or `NULL` (an unknown, empty or operator tenant). It is a `SECURITY
DEFINER` function owned by the migrator, executable only by `dryscope_runtime`, with a fixed
`search_path`. It reads `companies` through a `SELECT`-only policy that needs the table owner's
rights, a session signed in as another role (the runtime calling the function) and the setting
`app.sign_in_lookup`, which the function turns on for its one read and clears; outside the
function the migrator still reads no company row, even with that setting on, and the runtime still sees none
without `withCompany`. The actor, membership and company status are then read inside
`withCompany` for that company (`web/src/lib/auth/directory.ts`), in read-only transactions.

`0005_access_projection` adds the outbox worker's lookup, built the same way. A change to a
membership writes an `access_projection_outbox` row in its own transaction; the worker
(`web/src/lib/projection/`) then needs to know which companies have rows waiting before it can open
`withCompany` for them. `access_projection_due_companies(max)` (1 to 100) returns only the ids of
companies with a row not yet done and due now, oldest first, never a row or anything else of a
company. It is a migrator-owned `SECURITY DEFINER` function, executable only by
`dryscope_runtime`, reading the outbox through a `SELECT`-only policy gated like `0004`'s (the
owner's rights, a session signed in as another role, and the setting `app.projection_scan`, which
the function sets for its one read and clears). Everything else the worker does (read the actor,
membership and company, mark rows done) runs inside `withCompany` under the `0003` policies. It also
adds an index on `(company_id, actor_id, processed_at)` for one actor's rows. Outbox rows are kept
after they are done; about one per active member per day is added by renewal (below), and nothing
prunes them yet.

`0006_platform_operator` adds the platform operator (S3-9). `platform_operator(tenant, uid)`
returns the id of the active operator signing in (an actor with no company, in an operator tenant,
with an active `platform_admins` row) or `NULL`, built like `0004`. Operator work runs in
`withOperator` (`web/src/db/tenant.ts`), which sets `app.operator_id` for one transaction (and the
company for actions on one company) and refuses unless `app_operator_active()`, a migrator-owned
`SECURITY DEFINER` check that reads only the `platform_admins` row the setting names, confirms an
active operator. Only in that context may the runtime read every company, insert one (column rights
`name` and `sign_in_slug` only), update its `status`, `auth_tenant_id` and `updated_at` (column
rights), read and insert company tenants (`kind = 'company'` only), and insert audit rows naming
that operator; a restrictive policy refuses any runtime audit row naming an operator outside that
operator's own context. A trigger refuses the runtime archiving a company that is not suspended or
changing a sign-in tenant once set; the table owner can still repair one. Nothing gives the runtime a
right on `platform_admins` beyond its empty read, so no route can add an operator.
`add_platform_operator(tenant, uid, email)` is the owner-run command (`npm run
platform:add-operator`): executable only by the table owner, and its policies match only the owner
signed in as itself while the function runs. It registers an operator tenant, adds the operator and
writes one `operator_added` audit row (no company, member or operator named). Operator audit rows
hold ids, roles and counts only.

`0007_sign_in_address` adds the company sign-in page's lookup (S3-13b). The page `/sign-in/{address}`
needs the company's name and Identity Platform tenant before anyone has signed in, so the runtime
calls `sign_in_company_page(address)` (`web/src/lib/sign-in/database-directory.ts`, behind
`GET /api/sign-in/{address}`). It is built like `0004`: a migrator-owned `SECURITY DEFINER` function
with a fixed `search_path`, executable only by `dryscope_runtime`, reading `companies` through
`0004`'s `SELECT`-only policy while it holds the `app.sign_in_lookup` setting. It returns the name
and tenant of an active company that has a sign-in tenant, and no row for an unknown or empty
address, a company with no tenant yet, or a suspended or archived company (all look the same). It
adds no table, column or policy and returns no company id.

`0008_feature_flag_writes` adds the operator's write path on `company_feature_flags` (S3-11b). In an
active operator's context (`withOperator`, `0006`) the runtime may insert or update a flag row, only
for the company that context names and only stamped with that operator's own id; a company
transaction never matches, so an owner cannot change a flag (D12). Column rights only: a row is
created with its company, name, value, operator and time, and afterwards only its value, operator and
time change. There is still no `DELETE`: a switched-off flag is a row with `enabled = false`. The
known names stay in code (`web/src/lib/flags/`), so a new flag needs no migration.
`POST /api/platform/companies/{companyId}/flags` (`{ flag, enabled }`) locks the company row, writes
the flag and one `feature_flag_changed` audit row naming the operator (`details` holds the new and
previous value only) in one transaction, and refuses an unknown name before writing.

`0017_definer_search_path` (security audit F4) changes the fixed `search_path` of every `SECURITY
DEFINER` function, the lookups above and the workers' lookups across companies, from `pg_catalog`
to `pg_catalog, pg_temp`. PostgreSQL searches the calling session's temporary schema first for
relation and type names unless `pg_temp` is written in the path. The API user may create temporary
objects, so before this file it could create a temporary domain called `uuid` or `text` whose check
runs its own function, and a lookup that declares a variable of that type would run that function
as the table owner. With `pg_temp` last, `pg_catalog`'s types are found first, as the PostgreSQL
manual advises for `SECURITY DEFINER` functions; the temporary schema is never searched for
function or operator names. The API user may also call `plpgsql_validator`, which compiles a body
under the caller's own `search_path` and keeps the compiled copy for the session; a later call whose
arguments have indeterminate collation reuses it. So 0017 also recreates the five lookups with every
type, function and operator named by schema (`pg_catalog.uuid`, `pg_catalog.set_config`,
`OPERATOR(pg_catalog.=)`); the bodies are otherwise unchanged, and `CREATE OR REPLACE` keeps the owner
and grants. `web/tests/db/definer-search-path.test.ts` covers both the direct call and the validator
path. No table or policy changes. A definer function added later writes
`SET search_path = pg_catalog, pg_temp` and names its types with their schema
(`pg_catalog.uuid`, `pg_catalog.text`).
