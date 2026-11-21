# Data: Current app: summary, where personal data lives, who sees what

Part of [Data](../DATA.md).

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
- New app (`web/`, S6-2): IndexedDB `ds-me` holds one row per company and person signed in on the phone (browser sign-in settings, tenant, person id, company name, sign-in address; from S6-3 also company id, role, capabilities, the person's id in the company (S5b-1) and sign-in time; no email, no token), removed at sign-out. S6-3 adds, per company and person, a Firestore cache and write queue in IndexedDB (only after the person answers "Keep jobs on this phone?"; otherwise a memory cache), and localStorage keys `ds-keep/<tenant>` (that answer) and a per-person unsent-work and refusal mark (counts, times and pending in-memory photo IDs, no bytes or field values); see `docs/plans/S6.md`. S6-4 adds IndexedDB `ds-journal` (persistent cache only): per company and person, each field edit the server has not yet accepted (the job, the draft and document paths, the field values written and the values those keys and documents held on the screen the edit was made on, time, state and refusal reason), removed once the server accepts it, when the person discards it or saves it as a new draft from the "Can't save" sheet (S6-4b), and with the person's cache at Discard (`web/src/lib/field/journal.ts`). The new app's worker (`/sw.js`) keeps only a fixed list of build files in `ds-field-<build id>` caches, never `/api/*` or photos (`docs/plans/S6.md`).
- Sign-out clears the drafts, photos, notes and originals, or asks to discard unsynced work.
- The rebuilt app's IndexedDB `ds-prices` keeps the published reference list for Check Scope
  when the person keeps jobs on the phone. Its key is the tenant, person, company and published
  version ID. A row carries the publish date, enabled item IDs, names and units, and room types
  with their suggestion IDs. Amounts stay on the server. Refresh replaces the prior copy in one
  transaction. Sign-out clears this person's item list even when they keep unsent field work.
  Each refusal or sign-out writes a random token to the localStorage key
  `ds-prices-erase/<tenant, person[, company]>`, marked as owed until the erase commits; the token
  stays after it. A row keeps the tokens current when its answer was asked for, and a save writes
  only while they still are, so no clock decides the order. Only a save creates the database.
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
| Vertex AI (Gemini) | photos (1,600 px copy), transcripts, notes and job facts for the AI features in [AI.md](../AI.md); REST calls use location `global`, Live uses `us-central1`. The code sets no residency or retention option; Google's terms apply |
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
Soft delete, access and restore details: [VAULT-BACKUP.md](../VAULT-BACKUP.md) (doc-only for the
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
