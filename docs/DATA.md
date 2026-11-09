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
that schema is applied to Cloud SQL. An agent does not create the instance, run Terraform or change
IAM. The owner applies infrastructure. There is no earlier Postgres schema to backfill, and the
Firestore records in this file are unchanged.

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
operator), `company_feature_flags` (a missing row means off; only an operator changes one, per D12)
and `access_projection_outbox` (actors whose Firestore access record must follow a committed
membership change). Rows that refer to another company row carry `company_id` in a composite key,
so a membership, invitation, audit event or outbox row can never point at an actor or invitation of
another company. `actors.email`, `actors.display_name` and `invitations.email` are personal data.
Emails are stored lowercase and tenant ids, uids, emails and display names without surrounding
spaces, so one person is one stored key. Nothing writes these tables yet, and they have no
row-level security yet; the runtime role and row-level security come in `0003`. Prices and signed
documents are later work.

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
[RUNBOOK.md](RUNBOOK.md#postgres-migrations-for-the-rebuilt-app). Connection failures from the
migrator name the migration and omit the database URL.
