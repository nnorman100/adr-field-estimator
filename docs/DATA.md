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
only an operator changes one, per D12, and the runtime can only read it until S3-11b adds that path)
and `access_projection_outbox` (actors whose Firestore access record must follow a committed
membership change). Rows that refer to another company row carry `company_id` in a composite key,
so a membership, invitation, audit event or outbox row can never point at an actor or invitation of
another company. `actors.email`, `actors.display_name` and `invitations.email` are personal data.
Emails are stored lowercase and tenant ids, uids, emails and display names without surrounding
spaces, so one person is one stored key. The team and invitation routes (S3-10,
`web/src/lib/team/`) write actors, memberships, invitations, audit events and outbox rows, always
inside `withCompany`; an invitation's record, with its email, stays after it is accepted,
cancelled or cleared ("clear" only hides it from the team list); nothing in `web/` deletes it yet.
The access projection (below) marks outbox rows done, and the platform operator routes (S3-9, `web/src/lib/platform/`, `0006` below) create companies, change their status and sign-in tenant, register company tenants and write owner invitations, memberships, outbox rows and audit rows; nothing else writes these tables yet. Prices and signed documents are later work.

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
checked in the emulator (`web/tests/emu/rules/`) and are not deployed. The server writes the
company header and the access records (`web/src/lib/projection/`, S3-12); drafts are later work.
The rules deny every path they do not name. They read three server-written records:

| Path | Fields the rules read | Who may change it |
| --- | --- | --- |
| `companies/{companyId}` (company header) | `authTenantId`, the company's sign-in tenant | server only |
| `companies/{companyId}/access/{uid}` (access record) | `role` (owner, estimator or office) and `expiresAt` (a timestamp; the record stops working then) | server only |
| `companies/{companyId}/drafts/{draftId}`, its `rooms/{roomId}` and its `photos/{photoId}` | draft: `fieldOwnerUid` and `state` (editing, submitting or submitted); client data sits in one `field` map in each document | the draft's field owner changes only `field`, while the draft is `editing`; the server creates and removes drafts |

Every read or write needs a token whose `firebase.tenant` is the company's `authTenantId` and an
unexpired access record for that uid in that company. With both, owner and office read every draft
of the company and an estimator reads only drafts they own in the field. Only the field owner, as
owner or estimator, writes, and only the `field` map: of a draft, or of a room or photo reference
under it (created holding only `field`, never deleted by a client; no other collection and nothing
deeper). A draft that is `submitting` or `submitted` refuses every client write.

Each `field` map follows field map v1 (S5a-1, `web/src/lib/field/schema.ts`), and the rules refuse
a key it does not name, a value of the wrong type, and a text, number or list outside its size. Every
key is optional; clearing a value deletes its key.

| Document | `field` keys |
| --- | --- |
| Draft | `yearBuilt`; `roomOrder` (room ids, at most 30, no repeats); `notes` (up to 40,000 characters) and `summary` (the written summary of findings, up to 6,000); `scopeConfirmed`; equipment counts `airMovers`, `dehumidifiers`, `airScrubbers`, `woodFloorSystems` with `dryingDays` and `woodFloorDays`; job charges `emergencyCalls`, `monitoringHours`, `haulLoads`, `hepaFilters`, `matterportScans`, `dumpTruckLoads`, `equipmentDecon`, `powerDistribution`, `laborHours`, `isAfterHours` |
| Room | `name`, `category` (1 to 3), `unfinishedSf`, `finishedSf`, `floorSf`, `wetFloorSf`, `wastePercent` |
| Photo reference | `roomId`, `shotTag` (overview, source, surface, meter, contents or equipment) |

`notes` and `summary` are free text and may hold personal details, so they are personal data. The
rules cannot check a list's entries; the server checks `roomOrder` when it reads the draft
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
  `dryscope-<env>-access-projection`, named from `APP_ENVIRONMENT` and `GOOGLE_CLOUD_PROJECT`).
  That pass is what retries every row a projection left waiting, because its write failed or it
  found the actor busy, removals included. It needs a scheduled trigger: the scheduler account and
  its Cloud Scheduler job are not created yet (an owner follow-up in Terraform), and until they
  exist those rows wait, unless a later membership change of the same member projects them. Opening
  the app does not retry them: a removed member is refused before renewal runs, and renewal leaves a
  row alone while it waits out its back-off.
