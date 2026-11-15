# Data

What personal and customer data DryScope holds, where it lives, who can see it, and how long it is
kept. Written from the code at the time of writing; where only a document (not code) states a fact,
it is marked **doc-only**. Who may do what is in [ACCESS.md](ACCESS.md); logging and secrets rules
are in [SECURITY.md](SECURITY.md).

## Summary

- Everything is in project `alert-disaster-field-2026`: Firestore `(default)` in `us-west2`, the
  private bucket `alert-disaster-field-2026-evidence`, and Vertex AI calls (see below).
- Browsers never read Firestore: `firestore.rules` denies all reads and writes (a test enforces it).
  Every read goes through the Cloud Run backend, which checks identity, company membership and job
  access, or a single-use link token.
- **Retention today: almost nothing is deleted.** Short-lived records expire. Per-company record
  retention is built (the owner sets 90 to 3,650 days for invitations, the activity log,
  drying-watch history and archived-draft photos), but its deletion sweep is off
  (`RETENTION_ENABLED=false`), so those are kept too. Signed agreements and their photos, open
  drafts, transcripts and customer details are kept indefinitely, and there is no customer or
  company deletion or export in code. See "Retention".

## Where personal data lives

### Firestore (private, server access only)

| Collection | Personal data held | Who can read it |
|---|---|---|
| `inspections/{id}` (draft job) | property address, coordinates, technician notes, technician and assistant transcripts, photo metadata with the phone's location stamp, owner uid | company members with job access (an estimator only on jobs they created or are assigned); superadmin read-only and audited |
| `authorizations/{id}` (signed agreement, immutable) | the draft's content, the documents with customer name and claim details (carrier, claim, policy, adjuster name, email and phone, deductible), signature reference, and for a homeowner-link signing the signer's name, role, **IP address and user agent** | same as above; the homeowner holding the signing link or a document link sees the signed documents |
| `drying_logs/{id}` | readings, and `recorded_by` (the technician's email) | members with job access; superadmin read-only |
| `_workspace_jobs/{id}` (coordination sidecar) | customer name, phone, email, office notes, address, claim details, assignment | owner and office; an estimator with job access gets a limited coordination view (customer name, phone, email and address, without office notes, assignment or access lists) and reads and edits claim details through the separate claim endpoint; superadmin read-only and audited |
| `_job_deliveries`, `_job_monitoring` | delivery status per recipient role (no address); drying-watch address copy, reminder records with a hash of the recipient | members with the matching capability |
| `_job_insights` | AI job summary prose from verified facts | members with job access |
| `_estimate_history/{company}` | per signed job: dates, range, final invoiced amount, drying days, closing uid | owner and office |
| `_companies` | company name, address, phone, email, license, signoff, logo, crew-lead email | company members; superadmin |
| `_memberships`, `_invitations` | member and invitee email addresses, role, status | owner; superadmin read-only |
| `_admin_events` | superadmin audit log and company activity log (actor uid, action, company, record IDs, retention days and run counts) | superadmin |
| `_company_retention`, `_retention_state` | the company's retention days per class with a version; the daily sweep's lease and last run (no personal data) | settings: owner (`retention_manage`); state: server code only |
| `_signing_links`, `_document_links` | link records keyed by the SHA-256 of the token (the token is never stored), with job, revision and expiry | nobody directly; the link holder acts through the link routes |
| `_limits`, `_live_sessions`, `_live_resume`, `_server_keys`, `_company_limits`, `_email_counts`, `_migrations`, `_signing_link_jobs`, `_document_link_agreements`, `_workspace_authorizations`, `_platform_admins`, `_invite_keys`, `_owner_login_reservations` | counters, leases, keys, pointers and markers; per-address counters are keyed by an HMAC of the IP so the address is not recoverable; the Live resume record holds a provider session handle | server code only |
| price book collections (`_company_price_books`, `_price_book_versions`, `_price_book_drafts`, `_price_book_previews`, `_job_pricing`) | company prices; no customer data | members with `prices_read`; owner edits |

### Cloud Storage (`alert-disaster-field-2026-evidence`)

Photos, the 1,600 px model copy, full-size originals sent later on Wi-Fi, and signature images,
under paths that contain the uploader's Firebase uid (`users/{uid}/inspections/...`,
`users/{uid}/authorizations/...`). Photos can show faces, interiors and documents, and carry the
phone's location stamp in the record. Read by members with job access through authenticated
routes (`Cache-Control: private, no-store`), by a link holder through the link routes, by superadmin
support (read-only, audited), and by the vault backup job. Whether the original's embedded EXIF
data is stripped was not verified; the model copy is re-encoded.

### Firebase Authentication

Emails, password hashes and uids (managed by Firebase; not in Firestore). Public sign-up is
disabled.

### The phone

- IndexedDB `adr-private-drafts-v2`: the full draft (address, notes, transcripts), photo bytes and
  offline voice-note audio slices, keyed by user and company.
- IndexedDB `adr-private-originals`: full-size photos waiting for Wi-Fi.
- Firebase sign-in session (IndexedDB, falling back to localStorage).
- The service worker caches static files only; it skips `/api/*`, `sign.html` and `/documents`.
- New app (`web/`, S6-2): IndexedDB `ds-me` holds one row per company and person signed in on the phone (browser sign-in settings, tenant, person id, company name, sign-in address; from S6-3 also company id, role, capabilities and sign-in time; no email, no token), removed at sign-out. S6-3 adds, per company and person, a Firestore cache and write queue in IndexedDB (only after the person answers "Keep jobs on this phone?"; otherwise a memory cache), and localStorage keys `ds-keep/<tenant>` (that answer) and a per-person unsent-work and refusal mark (counts and times, no field values); see `docs/plans/S6.md`. Its worker (`/sw.js`) keeps only a fixed list of build files in `ds-field-<build id>` caches, never `/api/*` or photos (`docs/plans/S6.md`).
- Sign-out clears the drafts, photos, notes and originals, or asks to discard unsynced work.
- A draft's local copy, photos and resolved voice notes are also removed when the job is signed
  and the signed agreement opens on the phone, when sync finds the job signed, and when the owner
  archives it with no unsynced work. Voice notes still waiting to be resolved stay until resolved,
  and originals the server has promised stay queued for Wi-Fi; other queued originals are dropped.
- A queued original is removed once the server confirms its upload, or when the server will
  always refuse it.
- The homeowner signing page stores nothing on the device.

### Email and other processors

| Processor | Data sent |
|---|---|
| Resend (`INVITATION_TRANSPORT=resend`, the code default) or Gmail SMTP (production uses `smtp`, `docs/DECISIONS.md` D-007) | staff invitations; the homeowner copy (customer email; a private link, nothing attached); the adjuster email (property address, claim number, private link); the crew-lead email; drying reminders a person approved |
| Vertex AI (Gemini) | photos (1,600 px copy), transcripts, notes and job facts for the AI features in [AI.md](AI.md); REST calls use location `global`, Live uses `us-central1`. The code sets no residency or retention option; Google's terms apply |
| Google Places and Static Maps (server-side) | typed address and chosen coordinates |
| Firebase Auth | emails, password hashes, uids |

Sent addresses, names and links are never written to `_job_deliveries` or the logs.

### Logs

`backend/cloud_log.py` keeps allowlisted fields only (operation, model, durations, counts, status,
`inspection_id`, delivery id and recipient role). It drops uid, email, address, token and IP. The
free-text message is a fixed string. Cloud Run's own request logs (the URL contains the job id,
and the client IP) are written by Google outside that allowlist, and no Cloud Logging retention is
set in the repository, so Google's default applies.

### Vault backup

A daily job copies evidence objects and a Firebase Auth export (emails and password hashes) into
`alert-disaster-vault-backups`, a bucket in a different project, outside the app. It does not read
Firestore. Objects there are deleted 90 days after creation (`ops/vault-backup/lifecycle.json`).
Soft delete, access and restore details: [VAULT-BACKUP.md](VAULT-BACKUP.md) (doc-only for the
soft-delete and read-access statements).

## Who sees what, at a glance

| Who | Sees |
|---|---|
| Owner | everything in their company |
| Estimator | only jobs they created or are assigned; not other estimators' jobs or the team list |
| Office | job coordination, customer name, phone and email, signed documents, delivery resend; no photos upload, scope edit, audit or signing |
| Superadmin | any company, read-only, each view written to `_admin_events`; edits only the listed support actions |
| Homeowner with a signing link | the four documents and photos for that revision; signs once; after signing, views them for 30 days |
| Holder of a document link | one signed document set, read-only, for 30 days, until revoked |
| Nobody (server only) | counters, keys, leases, pointers |

## Retention

| Data | Kept |
|---|---|
| Signing link | 7 days to sign; 30 days viewable after signing (Firestore TTL on `expire_at`) |
| Document link | 30 days (TTL) |
| Live resume checkpoint | 600 s (TTL) |
| Per-address anonymous counters | 1 hour (TTL) |
| Job summary cache | 30 days (TTL) |
| Staff invitation | expires logically after 7 days; the record, with the invitee's email, stays (owners can hide it with "clear") until the retention sweep deletes it, below |
| Company record retention (`backend/retention.py`, sweep flag `RETENTION_ENABLED`, off) | owner-set per class, 90 days by default and at least 90, at most 3,650: invitations from their expiry; activity-log entries from creation; a closed signed job's drying-watch history from the close (a marker stays); an archived unsigned draft's photo objects from the archiving. With the flag off nothing is deleted. Never deleted: a signed agreement and its photos, an open draft's photos, a pending unexpired invitation, an unclosed job's watch, and drying readings ([company-workspaces.md](company-workspaces.md#record-retention)) |
| Estimate history rows | the newest 300 per company |
| Vault copies | 90 days |
| Firestore recovery and evidence-bucket soft delete | 7 days point-in-time recovery, 98 days of daily backups and 7-day soft delete, **doc-only** (not configured in the repository) |

The five TTL policies are enabled by an owner-run script (`scripts/ensure_firestore_ttls.py`); the
app does not enable them (`docs/firebase-isolation.md`).

**Kept with no deletion rule in code:** signed agreements (with the signer's IP and user agent)
and their photo and signature objects; draft jobs including archived ones, their transcripts, and
the photos of open drafts; drying logs; customer and coordination sidecars and delivery records;
memberships; company profiles; Firebase Auth users; and
phone data until sign-out, signing, archiving or a confirmed original upload, as listed under "The phone". Archiving is a soft status change that
hides a job without deleting it. While `RETENTION_ENABLED` is off, invitations, the activity log,
drying-watch history and archived-draft photos are kept as well. The only deletes in the backend
are leases, price-book working copies, a drying reading, owner-login reservations, the orphan of a
failed upload, and, once that flag is on, the retention sweep.

There is no customer data export or deletion endpoint. Record retention (#229) is merged with its
sweep off; turning deletion on is owner-only (`HANDOFF.md`). The standard's company export and
deletion are not built yet; update this file when they are.

## Rebuilt app: backups, logs and AI data under Technology Standard 2.7 (planned)

The rules below are owner decisions (D-018 to D-028 in [DECISIONS.md](DECISIONS.md)). They are not
applied yet: the Terraform is stage TC ([plans/TC.md](plans/TC.md)), owner-applied, and the AI side is stage
S7 ([plans/S7.md](plans/S7.md)). The retention table above describes the old app.

- **Deleted data leaves backups within 35 days (D-023).** Evidence buckets get a noncurrent-version
  lifecycle rule of 28 days plus 7 days of soft delete; Cloud SQL keeps at most 30 backups; Firestore
  backups are kept 14 days (the most Firestore allows is 14 weeks,
  `documents/firebase.google.com/docs/firestore/backups`); no personal data goes to logs. Google's own
  suggestion is versioning and soft delete on one bucket with a lifecycle rule deleting noncurrent
  versions (`documents/docs.cloud.google.com/storage/docs/object-versioning`). Until the owner applies it,
  the test evidence bucket keeps old versions with no limit and no Firestore backup schedule exists, so
  the 35 days is not yet true.
- **Live voice caches the session (D-019).** To resume a dropped connection, Google stores the session's
  text, audio and video and the model's outputs for up to 24 hours, under project-level privacy
  (`documents/docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention`).
  Voice is not zero-retention; [AI.md](AI.md) lists the
  other AI features' settings.
- **Model Armor's own logging is off.** Sanitize-operation logs hold full prompts and replies
  (`documents/docs.cloud.google.com/model-armor/configure-logging`), so they would be personal data in logs.
- **Data Access audit logs** record who read or wrote user data, but are off by default for most
  services and are enabled per service (`documents/docs.cloud.google.com/logging/docs/audit/configure-data-access`).
  They hold metadata, not the data. Which services DryScope turns them on for is not decided yet; nothing enables them today.
- **Offline drafts on iPhone (D-025).** Drafts are kept on the phone only in the installed Home Screen app;
  in a Safari tab the field screens work online only. Stage S6.

## Rebuilt app Postgres (not deployed)

The TypeScript app in `web/` keeps a Postgres schema beside the Firestore data above. Nothing in
that schema is applied to Cloud SQL yet. Once the owner finishes the setup in
[the test release runbook](runbook/test-release.md), the test release workflow applies it to
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
([the backups runbook](runbook/backups.md#restore-into-another-region)), losing at most one day; point-in-time
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

`0009_price_tables` adds the company price tables (S4-5, `docs/plans/pricing.md`); the Prices API
(S4-6, `docs/ACCESS.md`) reads and writes them. Both hold a company's rows only inside `withCompany`, with forced row-level security.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `price_table_versions` | Every published table, whole: numbered `sequence` per company, `content` (`jsonb`), `content_hash` (64 lowercase hex), `engine_version` (`dryscope-v` and a number), `reason` (3 to 500 characters), `source` (`blank`, `import` or `restore`), `published_by_actor_id`, `published_at`, `publish_key` | `SELECT`, `INSERT`; never changed or removed |
| `price_table_working_copies` | The one table the owner is editing, one row per company (not a job draft): `base_sequence` (the version it started from, empty for a new company), `content`, `revision` | `SELECT`, `INSERT`, and `UPDATE` of `base_sequence`, `content`, `revision` and `updated_at` only |

- A company's current prices are its highest `sequence`. Keys per company: `sequence`, `publish_key`
  and `id` are each unique with `company_id`, so a later row (S5a's job price pins) names a version by
  company and id, or company and sequence, and can never name another company's. The publisher and the
  working copy's base version use the same composite keys.
- A trigger gives a version the company's next number (1, 2, 3, no gap, no repeat), so two publishes at
  once cannot both take number n: the second waits and is refused. A retried publish with the same
  `publish_key` is refused by the unique key, and the route answers it from the stored version.
- A trigger starts a working copy at revision 1 and lets each change raise it by exactly one, so a save
  from a stale copy is refused (the route's `WHERE revision = expected` finds no row; a blind save fails
  the check).
- The write policies refuse an active platform operator: an operator reads a company's prices through
  `withOperator` with that company set, and can never change them.
- `content` is `jsonb`, so SQL checks only that it is an object. The `PriceTableV3` schema checks the
  prices when a table is written and read, and the hash is checked again on read.

`0010_core_job_tables` adds the job header, customer, claim and evidence registry tables and the company
profile columns (S5a-2, `docs/plans/S5.md`); the jobs routes (S5a-3, `docs/ACCESS.md`) read and write `jobs`, `job_customers` and `job_claims`, and the photo routes (S5a-5, `docs/ACCESS.md` "Photo routes") insert and read `evidence_objects`. All four tables hold a
company's rows only inside `withCompany`, with forced row-level security. A key between rows always carries
`company_id`, so a row can never point at another company's job or person.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `jobs` | One row per job, keyed `(company_id, id)` with `id` made on the phone (no server default): `created_by_actor_id`, `field_owner_actor_id` (empty until someone owns the field work), `status` (`draft`, `submitted`, `signed`, `archived`), `current_draft_id` (the Firestore field draft; one job per draft in a company), `property_address`, `archived_at` and `archived_by_actor_id` (set exactly when `status` is `archived`), `revision`, `last_change_id`, `request_digest` (SHA-256 of the create request) | `SELECT`, `INSERT`, and `UPDATE` of `field_owner_actor_id`, `status`, `current_draft_id`, `property_address`, `archived_at`, `archived_by_actor_id`, `revision`, `last_change_id` and `updated_at` only |
| `job_customers` | At most one row per job: `name`, `phone`, `email` | `SELECT`, `INSERT`, and `UPDATE` of those three and `updated_at` |
| `job_claims` | At most one row per job: `carrier`, `claim_number`, `policy_number`, `date_of_loss`, `loss_cause`, `adjuster_name`, `adjuster_email`, `adjuster_phone`, `deductible` (the fields the documents print) | `SELECT`, `INSERT`, and `UPDATE` of those columns and `updated_at` |
| `evidence_objects` | The registry of stored bytes: `job_id`, `object_id` (the photo's or signature's client id), `kind` (`photo`, `original`, `signature`), `object_name` in the evidence bucket, `generation`, `sha256`, `size_bytes`, `content_type`, `created_by_actor_id` | `SELECT`, `INSERT`; never changed or removed |

- `companies` gains `profile_address`, `profile_phone`, `profile_email`, `profile_license` and
  `profile_signoff`, empty until set, one line each. The runtime may `UPDATE` those columns of its own company
  and nothing else on the row: a trigger refuses a change to `status` or `auth_tenant_id` from a company's
  own transaction, and refuses a platform operator any change to the profile (the operator keeps 0006's
  status and sign-in tenant rights). That only the owner changes the profile is the route's rule
  (`profile_manage`, S5a-4).
- `revision` starts at 1 and each change raises it by exactly one (a trigger), so a save made from an older
  copy is refused and a blind save fails the check (the jobs routes compare it under the job's row lock); a job
  starts as a `draft`.
  `last_change_id` is the client's id for the latest change, so a retry that carries it again is not a
  conflict; the routes decide that, and the same job id with another body is told by `request_digest`.
- An `evidence_objects.object_name` must sit under `companies/<company id>/jobs/<job id>/` and use only
  letters, digits and `. _ - /` (no uid, no person's name, no dot segments), so a row can never register
  another company's or job's bytes. Unique per job, object and kind, and per object name, so a retried
  receipt finds its row. `(company_id, id)` is a unique key so a later agreement can name its signature.
- The photo routes register a photo and its full-size original as two rows of one `object_id`, named
  `companies/<company id>/jobs/<job id>/photos/<photo id>` and `.../originals/<photo id>` (no hash, type or
  extension in the name: one photo id is one object, and a second upload of it is refused by the bucket's
  create-only precondition). `sha256` is the hash the server computed, `generation` the bucket's, and
  `content_type` one of `image/jpeg`, `image/png`, `image/webp`, told from the bytes. The object carries its
  own `sha256` in its metadata, so a first attempt that stored the bytes and lost its place is registered by
  the retry. The row is inserted once and never changed.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write
  policy refuses an active operator, so an operator never changes a job, its customer or claim, the registry
  or a company's profile.
- Personal data: `jobs.property_address`, `job_customers` (`name`, `phone`, `email`) and `job_claims`
  (`adjuster_name`, `adjuster_email`, `adjuster_phone`, the carrier, claim and policy numbers, `loss_cause`,
  `deductible`, `date_of_loss`). `evidence_objects` holds object names made of ids, hashes and sizes only.
  The company profile columns are the company's own business details, printed on its documents. Logs and
  audit details hold ids and counts only.

`0011_submissions_agreements` adds the submission, price pin, estimate and agreement tables and the worker's
lookup across companies (S5a-7, `docs/plans/S5.md`); the submission routes (S5a-8) and the estimate routes (S5a-9) use them, and the agreement routes (S5a-11) insert and read agreements. The four tables
hold a company's rows only inside `withCompany`, with forced row-level security, and every key between rows
carries `company_id`.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `job_submissions` | Submit's row, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `draft_id` (the Firestore field draft), `epoch` (server-made), `kind` (`original`, `change_order`), `parent_agreement_id` (set exactly for a change order), `status` (`pending`, `committed`, `aborted`), `request_digest`, `expires_at`, `snapshot_bytes` and `snapshot_sha256` (set exactly when committed; the hash is checked against the bytes), `marker_state` (`pending`, `done`), `created_by_actor_id`, `decided_at` | `SELECT`, `INSERT`, and `UPDATE` of `status`, `snapshot_bytes`, `snapshot_sha256` and `marker_state` only |
| `job_price_pins` | Which published version a job is priced from: `job_id`, `sequence` (1, 2, 3 per job), `version_id` (a version of the same company), `reason` (`first_price` for sequence 1, `owner_reprice` after), `pinned_by_actor_id`; the current pin is the highest sequence | `SELECT`, `INSERT`; never changed or removed |
| `job_estimates` | One priced estimate per committed submission and pin: `table_hash` and `engine_version` (those of the pinned version), `priced_result`, `proposal_bytes` and `proposal_sha256` (checked against the bytes), `created_by_actor_id` | `SELECT`, `INSERT`; never changed or removed |
| `agreements` | The signed record, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `submission_id`, `estimate_id`, `kind`, `parent_agreement_id`, `signer_kind` (`device`, `link`), `signer_name`, `signature_evidence_id` (a `signature` object of the job in `evidence_objects`), `proposal_sha256`, `priced_result`, `version_id`, `content_hash`, `engine_version`, `documents_bytes` (the documents as signed), `request_digest`, `created_by_actor_id`, `signed_at` | `SELECT`, `INSERT`; never changed or removed |

- A submission is made `pending` (a trigger refuses any other start) and moves once to `committed`, with its
  snapshot bytes and their SHA-256, or to `aborted`. The decision time is the database clock's, set by the
  trigger. From then on a trigger refuses every change to the row except `marker_state` going from `pending`
  to `done`, and it refuses a change to a pending row's job, draft, epoch, digest, expiry, kind, parent or
  creator. Unique per draft and epoch, and at most one `committed` row per draft, so of two commits for the
  same draft the first wins and the second is refused. The new column `marker_state` records that the draft's
  Firestore marker (`submitted` after a commit, back to `editing` after an abort) is written; the worker
  repairs a lost one.
- `job_submission_due_companies(max_companies, marker_grace_seconds)` is the worker's one lookup across
  companies, on the 0005 pattern: it returns company ids only, runs as the table owner with a setting that
  one SELECT policy needs, and only the runtime may call it. A company is due when it has a row still
  `pending` past `expires_at`, or a decided row whose marker is still `pending` after the grace period
  (0 to 86,400 seconds, so the request that just decided is not raced). Size 1 to 100.
- An estimate is made only from a `committed` submission and the job's current pin, and states that pin's
  version's content hash and engine version (a trigger checks both); one per submission and pin.
- An agreement restates its estimate (a trigger checks it): the estimate is for this submission, which is
  `committed` and has the same kind and parent; the proposal hash, priced result, content hash and engine
  version are the estimate's, the version is the estimate's pin's, and that pin is still the job's current one;
  the signature is a `signature` object of this job. A submission, an estimate and a signature object are
  signed once each, and a job has at most one `original` agreement; a change order is not counted and names
  its parent (an agreement of the same job).
- `job_price_pins` names a version of its own company (composite key), and a pin takes the job's next number.
- Sizes: a snapshot or proposal is 2 bytes to 8 MiB, the signed documents 2 bytes to 16 MiB.
- Personal data: `snapshot_bytes` (the job's field work, customer and claim as submitted), `proposal_bytes`
  and `documents_bytes` (the customer's name, address, claim details and prices as printed) and
  `signer_name`. The table columns holding ids, hashes, kinds and times are not personal data. Logs and audit
  details hold ids and counts only.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write
  policy refuses an active operator.

`0012_ai_live_tables` adds every AI and Live table of stage S7 and the sweeper's lookup across companies
(S7-3, `docs/plans/S7.md`); it is S7's one database job, and no route uses the tables until S7-4 to S7-15. The
eight tables hold a company's rows only inside `withCompany`, with forced row-level security; every key
between rows carries `company_id`, and the runtime has no `DELETE` or `TRUNCATE` on any of them. Money is
whole micro-USD of Google's bill (`bigint`, at most 2^53 - 1). Feature, model, end-reason and verdict-category
names are checked for shape only; their closed lists stay in code (`web/src/lib/ai/`). The Drizzle view is
`web/src/db/ai-schema.ts`.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `company_ai_settings` | One optional row per company: `daily_ceiling_micro_usd` and `monthly_ceiling_micro_usd` (empty means the code default, $10 a day and $200 a month, V5 B, `web/src/lib/ai/ceilings.ts`; daily at most monthly), `ceilings_set_by_operator_id`, `ceilings_set_at`, `default_voice` (one capitalised word; the allowlist is in code), `default_voice_set_by_actor_id`, `default_voice_set_at` | `SELECT`; `INSERT` and `UPDATE` of the ceiling and voice columns. Only an active platform operator, stamped with its own id, may set ceilings, and it may set nothing else; a company member may set the voice only (a trigger enforces both). The times come from the database clock |
| `ai_ledger` | Each AI reservation, keyed `(company_id, id)`, one per `call_id`: `actor_id`, `feature`, `model`, `reserved_micro_usd`, `settled_micro_usd` (set exactly when settled), `state` (`reserved`, `held`, `settled`), `utc_day`, `utc_month` (the first day of that day's month), `settled_at` | `SELECT`, `INSERT`, and `UPDATE` of `state` and `settled_micro_usd` only |
| `ai_results` | One AI proposal per call (`call_id` names a ledger row of the same company): `job_id`, `draft_id`, `actor_id`, `feature`, `input_digest`, `prompt_version` (SHA-256 of the prompt file), `model`, `output` (a JSON object, at most 256 KiB), `verdict_category`, `status` (`proposed`, `accepted`, `rejected`), `decided_by_actor_id`, `decided_at` | `SELECT`, `INSERT`, and `UPDATE` of `status` and `decided_by_actor_id` only |
| `live_sessions` | One walkthrough, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `draft_id`, `actor_id`, `voice`, `language`, `started_at`, `ended_at` and `end_reason` (set together), `epoch`, `lease_expires_at` (set exactly while open), `capability_sha256`, `resumption_handle` (server-only, never logged; empty once ended), `handle_counter`, `covered_seq`, `next_turn_seq`, `restarts` (0 to 3), `signed_in_at`, `scope_fingerprint`, `reservation_id` (a ledger row of the same company, one session each) | `SELECT`, `INSERT`, and `UPDATE` of the end, epoch, lease, capability, handle, counter, sequence, restart and sign-in-time columns only |
| `live_usage` | The highest cumulative cost posted per `(company_id, session_id, epoch, connection)`: `max_cumulative_micro_usd`, `last_posted_at` (the database clock at each post), `closed` | `SELECT`, `INSERT`, and `UPDATE` of `max_cumulative_micro_usd` and `closed` only |
| `live_turns` | The screened transcript, keyed `(company_id, session_id, seq)`: `epoch`, `connection`, `speaker` (`technician`, `assistant`, `system`), `text` (at most 20,000 characters), `verdict` (`passed`, `blocked`, `unscreened`), `verdict_category` | `SELECT`, `INSERT`; never changed or removed |
| `voice_notes` | A voice note's transcript, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `draft_id`, `actor_id`, `duration_ms` (at most ten minutes), `audio_sha256` (the audio itself is not kept, V8), `transcript` (at most 20,000 characters), `state` (`transcribed`, `reviewed`, `rejected`), `reviewed_by_actor_id`, `reviewed_at` | `SELECT`, `INSERT`, and `UPDATE` of `state`, `transcript` and `reviewed_by_actor_id` only |
| `member_voice_settings` | A person's own Live voice: `(company_id, actor_id)`, `voice_name`, `updated_at` (the database clock) | `SELECT`; `INSERT`, and `UPDATE` of `voice_name` only |

- One open session per person: a partial unique key on `(company_id, actor_id)` where `ended_at` is empty,
  the backstop to the admit transaction's lock on the person's membership row (S7-11). An ended session never
  changes again (a trigger), so it cannot be reopened or settled twice.
- A ledger row is made `reserved`; it moves to `held` (outcome unknown) or `settled` (with its real cost, which
  may be above or below the reservation), and a held row only to `settled`. A settled row never changes, and a
  row's reservation, call, person, feature, model and days never change (a trigger).
- An AI result is made `proposed` and a person moves it once to `accepted` or `rejected`; its output and the
  rest of the proposal never change (a trigger), and a decided result is frozen.
- A connection's `max_cumulative_micro_usd` only goes up, a connection is closed once, and a closed one never
  changes (a trigger). The session's cost is the sum over its connections and epochs.
- A turn never changes, not even by the table owner (a trigger). Only a `passed` turn keeps its words, with the
  category `passed`; a `blocked` or `unscreened` turn keeps its category and no text.
- A voice note is made `transcribed`; it is `reviewed` by a person (with the technician's edit of the
  transcript) or `rejected` (by a person, or by the server for a screened-out transcript) once, and then never
  changes. Its recording's id, job, length and hash never change.
- `live_session_due_companies(max_companies)` is the sweeper's one lookup across companies, on the 0005 pattern:
  it returns company ids only, runs as the table owner with a setting that one SELECT policy needs, and only
  the runtime may call it. A company is due when it has an open session whose lease has lapsed. Size 1 to 100.
- Personal data: `live_turns.text`, `voice_notes.transcript` and `ai_results.output` (the technician's words
  and the model's text about the job, which may name people or places). `resumption_handle` is a secret of the
  server. The other columns hold ids, hashes, amounts, names from fixed lists and times. Logs and audit details
  hold ids and counts only.
- A platform operator reads a company's rows through `withOperator` with that company set; every write policy
  refuses an active operator, except the operator's own ceiling write on `company_ai_settings`.

`0013_company_documents` adds the letterhead lines and the document settings to `companies` (S5a-4b,
`docs/plans/S5.md`; the profile routes read and save them, `docs/ACCESS.md` "Company profile API"). It only
adds: no table, and no row is changed or seeded.

- `profile_emergency_phone`, `profile_fax`, `profile_website`, `profile_tagline` and
  `profile_mailing_address`: empty until set, one line each (no padding, no control characters), at most
  80, 80, 200, 150 and 500 characters.
- `profile_documents`: `jsonb`, an object under 64 KiB of its text form, `'{}'` until set (every setting at
  its neutral default). SQL checks only that; the Zod schema in `web/src/lib/profile/settings.ts` checks its
  shape when it is written and read, as `PriceTableV3` checks a price table.
- The runtime's column-level `UPDATE` and 0010's trigger split cover the six columns: a company's own
  transaction changes them, a platform operator never does (the trigger refuses it), and only the owner's
  route writes them (`profile_manage`).
- Personal data: none beyond 0010's. They are the company's own business details and wording, printed on its
  documents; the audit row holds a count, never a value.

`0014_signing_links` adds the remote signing link and the document links (S5a-11b, `docs/plans/S5.md`; the link
routes are in `docs/ACCESS.md` "Signing links and document links"). Both tables hold a company's rows only inside
`withCompany`, with forced row-level security, and every key between rows carries `company_id`.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `signing_links` | One link that signs one estimate, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `estimate_id`, `token_sha256` (the hash only, unique across companies), `status` (`pending`, `used`, `revoked`, `voided`), `request_digest`, `created_by_actor_id`, `token_issued_at`, `expires_at` (7 days after creation), `ended_at`, `ended_by_actor_id`, `agreement_id` and `used_at` (set exactly when used), `sign_attempts`, `read_window_start`, `read_count` | `SELECT`, `INSERT`, and `UPDATE` of the token hash, status, end and use columns and the counters only |
| `document_links` | One link that reads one set of one signed agreement: `job_id`, `agreement_id`, `document_set` (`homeowner`, `adjuster`), `token_sha256`, `status` (`active`, `revoked`), `request_digest`, `created_by_actor_id`, `token_issued_at`, `expires_at` (30 days after creation), `ended_at`, `ended_by_actor_id`, `read_window_start`, `read_count` | `SELECT`, `INSERT`, and `UPDATE` of the token hash, status, end columns and the read counters only |

- `agreements` gains `signing_link_id` (set exactly when `signer_kind` is `link`, unique, naming the link with the
  estimate it signed) and `signer_role` (`homeowner`, `adjuster` or `other`; required for a link signature, empty for
  one signed on a device). Rows signed before 0014 keep both empty.
- At most one `pending` signing link per job and one `active` document link per agreement and set (partial unique
  indexes); a newer link revokes the older one in the same transaction. A link's identity never changes, an ended
  link changes only its read counters, and a trigger on each table holds which columns may change; a column added
  later is frozen until the trigger names it.
- `signing_link_company(token_sha256)` and `document_link_company(token_sha256)` are the lookups before a company is
  known, on 0004's pattern: a token's hash to its company id and nothing else. Every other read runs inside
  `withCompany`.
- Personal data: none held directly. Only the SHA-256 of a token is stored (the token is in no table, log or audit
  row); the other columns are ids, hashes, states, times and counters. The signer's name and role are on the
  agreement. Logs and audit details hold ids and counts only.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write policy
  refuses an active operator.

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
[the migrations runbook](runbook/migrations.md). Connection failures from the
migrator name the migration and omit the database URL.

## Rebuilt app field database (not deployed)

`web/firestore.rules` holds the rules for the rebuilt app's Firestore field database. They are
checked in the emulator (`web/tests/emu/rules/`); the test release workflow releases them to `dryscope-field-test`
(`docs/runbook/test-release.md`) and live is still released by the owner. The server writes the
company header and the access records (`web/src/lib/projection/`, S3-12); drafts are later work.
The rules deny every path they do not name. They read three server-written records:

| Path | Fields the rules read | Who may change it |
| --- | --- | --- |
| `companies/{companyId}` (company header) | `authTenantId`, the company's sign-in tenant | server only |
| `companies/{companyId}/access/{uid}` (access record) | `role` (owner, estimator or office) and `expiresAt` (a timestamp; the record stops working then) | server only |
| `companies/{companyId}/drafts/{draftId}`, its `rooms/{roomId}` and its `photos/{photoId}` | draft: `fieldOwnerUid` and `state` (editing, submitting or submitted); client data sits in one `field` map in each document | the draft's field owner changes only `field`, while the draft is `editing`; the server creates and removes drafts. `POST /api/jobs` (S5a-3) makes a job's first draft after its Postgres row, as `{ fieldOwnerUid, state: 'editing', field: {} }` (no `fieldOwnerUid` key while nobody owns the field work), and a retry makes it only if it is missing |

Every read or write needs a token whose `firebase.tenant` is the company's `authTenantId` and an
unexpired access record for that uid in that company. With both, owner and office read every draft
of the company and an estimator reads only drafts they own in the field. Only the field owner, as
owner or estimator, writes, and only the `field` map: of a draft, or of a room or photo reference
under it (created holding only `field`; no other collection and nothing deeper). The field owner
may also delete a room document of an editing draft (owner decision, 2026-11-13, S5a-6: the phone
removes the room from `roomOrder` in the same batch); a photo reference is never deleted by a
client. A draft that is `submitting` or `submitted` refuses every client write.

Each `field` map follows field map v2 (S5a-1, room inputs S5a-10, `web/src/lib/field/schema.ts`), and the rules refuse
a key it does not name, a value of the wrong type, and a text, number or list outside its size. Every
key is optional; clearing a value deletes its key.

| Document | `field` keys |
| --- | --- |
| Draft | `yearBuilt`; `roomOrder` (room ids, at most 30, no repeats); `notes` (up to 40,000 characters) and `summary` (the written summary of findings, up to 6,000); `scopeConfirmed`; equipment counts `airMovers`, `dehumidifiers`, `airScrubbers`, `woodFloorSystems` with `dryingDays` and `woodFloorDays`; job charges `emergencyCalls`, `monitoringHours`, `haulLoads`, `hepaFilters`, `matterportScans`, `dumpTruckLoads`, `equipmentDecon`, `powerDistribution`, `laborHours`, `isAfterHours` |
| Room | `name`; `roomTypeId` (a room type of the job's price version; absent is Other); `category` (1 to 3, or `mold`); `waterClass` (1 to 4) and `ceilingHeightFt` for a water room, `moldCondition` (1 to 3) and `affectedSf` for a mold room; `unfinishedSf`, `finishedSf`, `floorSf`, `wetFloorSf`, `wastePercent`; `items` (a map of price-list item id to typed quantity, at most 50); `prepTasks` (at most 10 texts of up to 300 characters: a company template's words, copied when picked, or the estimator's own); `findings` (the room's findings note, up to 2,000 characters) |
| Photo reference | `roomId`, `shotTag` (overview, source, surface, meter, contents or equipment) |

`notes`, `summary`, a room's `prepTasks` and `findings` are free text and may hold personal details,
so they are personal data. The rules cannot loop over a list: `roomOrder` is checked for type, size
and repeats only, and a room's `items` and `prepTasks`, which have a fixed largest size, entry by
entry. Whether a room type or item is in the job's price version is the server's check at Submit
(and the estimate's again). The server checks `roomOrder` when it reads the draft
(`toInspection` in `web/src/lib/field/inspection.ts` maps a draft and its rooms to the engine's
inspection JSON). Each write reads the company header, the access record and, for a room or photo,
the draft: three documents of the 10 a write may read. A batched write may read 20 in all; counted
write by write, that is the draft update (two reads) and six room or photo writes (three each).

How the access records follow Postgres (S3-12, `web/src/lib/projection/`):

- A membership change and its outbox row commit together, so no record is written before the change
  commits, and a change that rolls back writes nothing. The team routes (disable, re-enable, role
  change, accepting an invitation) queue the row in the change's transaction and, once it has
  committed, project that member before they answer. When that projection succeeds, a disabled
  member's record is gone (and a changed role replaced) by the time the owner sees the change
  succeed. When it fails, or finds the actor busy after the lock timeout, the change still succeeds
  and its outbox rows wait (see the cross-company pass below). Later operator code calls
  `enqueueAccessProjection` the same way, including when a company stops being active.
- A run writes what Postgres holds when it runs, not what the row asked for: an access record with
  the role for an active membership in an active company with a sign-in tenant (plus the header's
  `authTenantId`), and otherwise no record. All of one actor's waiting rows are handled by one write
  under a per-actor lock, and rows are marked done only after the write; a run with nothing waiting
  writes nothing.
- Removal: the sign-in check reads the membership in Postgres, so the server refuses a removed
  member from the moment the change commits, before the record is removed. The record's removal is
  done only once a read shows it gone.
- A run holds the actor's lock until its Firestore write has settled; it never stops waiting for a
  write it started, so a slow Firestore holds that request and its database connection until it
  answers. The app keeps four projection connections, so other members' renewals go on meanwhile,
  and a run that still finds an actor held after the 15-second lock timeout counts it busy and goes
  on with the rest; its rows stay due for the next run. A run whose write succeeded looks again
  before it returns and applies any row of that actor committed meanwhile (a member disabled while a
  renewal's write was on its way). A run whose write failed does not look again, so a change that
  found the actor busy behind it is left waiting. A failed write leaves the rows waiting with a
  back-off (30 seconds, doubling, at most an hour) and a fixed error code; a crash at any point
  leaves them waiting, due now. The next run repairs either.
- Each write carries a version, the id of the run's Postgres transaction, taken under the lock, so
  a later decision always has a higher one. The server keeps the last applied version in
  `companies/{companyId}/accessVersions/{uid}`, which no rule names (clients can neither read nor
  write it) and which stays after a removal deletes the access record. Each Firestore write is a
  transaction that refuses a decision older than that version (`stale_decision`; the rows wait and
  are tried again), so even a write that lands after its run lost the lock (its database session
  ended) can neither bring back a removed record nor remove a newer grant, and a refused write is
  never marked done.
- A record works for 7 days from when it was written (`ACCESS_TTL_MS`). `GET /api/me` renews it once
  it is more than a day old (`RENEW_AFTER_MS`), so a member who keeps using the app keeps working,
  even offline for several days, and one who stops loses access within 7 days of their last write.
  Removal is an active delete; the expiry bounds only a record the outbox could not remove. A
  write a phone queued offline is checked by the rules when it reaches Firestore, so it is refused
  once the record is gone or has run out.
- The cross-company pass (`runAccessProjection`) runs on `POST /api/internal/access-projection`,
  which only the environment's scheduler service account may call (`serviceRoute`: a Google-signed
  ID token for `dryscope-scheduler-<env>@<project>.iam.gserviceaccount.com` with the audience
  `dryscope-<env>-access-projection`, named from `APP_ENV` and `GOOGLE_CLOUD_PROJECT`).
  That pass is what retries every row a projection left waiting, because its write failed or it
  found the actor busy, removals included. Its scheduled trigger in test is the Cloud Scheduler
  job `dryscope-access-projection-test` (`infra/dryscope/app/scheduler.tf`, every five minutes, as
  `dryscope-scheduler-test` from the data root); live has no trigger yet (its wiring comes in a
  later step). Until the owner applies both roots, and in live for now, those rows wait, unless a
  later membership change of the same member projects them. Opening
  the app does not retry them: a removed member is refused before renewal runs, and renewal leaves a
  row alone while it waits out its back-off.
