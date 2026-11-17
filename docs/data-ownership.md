# Destination data ownership and submission

This is the accepted rebuild target, not a description of the current deployment. The current Python app uses private Firestore records and a private evidence bucket; see [the legacy inventory](legacy-data-inventory.md). The rebuild is a clean start with no data migration from `alert-disaster-field-2026` (D-006, Nov 9, 2026); `dryscope` is its `test` project and `live` gets its own project before S8 (D-018). Each fact has one authoritative owner; a projection, cache or acknowledgement cannot acquire write authority.

| Data | Authoritative owner | Permitted copies and constraints |
| --- | --- | --- |
| Companies, memberships, capabilities, office customer details and assignments, invitations, billing (the tables planned in [BILLING.md](plans/BILLING.md) steps SB-1, SB-14 and SB-21) and feature flags | Postgres | Server-written Firestore access/header projections only. Client claims or a company header do not grant access. Office coordination remains SQL-owned. |
| Unsubmitted observations, rooms, measurements, findings, technician transcript and field evidence review | Firestore field database | Persistent phone cache and local recovery journal. Field owner writes prescribed field fields; other staff view only when authorized. Office fields do not share field-write ownership. |
| Published price books, working copies, job pins and adjustment/addition approvals | Postgres | Dated read-only phone copies. Client or Firestore totals and approvals are never authoritative. |
| Submitted inspection snapshots, four document payloads, calculation versions, proposal hashes, signatures, link-use state and reports | Postgres | Immutable canonical bytes alongside typed query columns. Firestore holds only server-owned submission ID/status; offline document copies are read-only. |
| Photo and signature bytes, including late originals | Private Cloud Storage | SQL registry owns official object identifiers, checksums, generations and usage; Firestore owns draft references before submission. Never rewrite a signed source path. |
| Live leases/resumption checkpoints, presence and transient field AI results | Private server-owned Firestore records | Bind to tenant, company, actor, job, capture and scope fingerprint; TTL, no browser resume secrets; clear after Finish or revocation. |
| AI usage reservations and settlement, send ledger, audit log and outbox | Postgres | Regenerable reporting views only; no competing counter decides spending or signatures. |

## One-way submission and signing

Firestore and Postgres have no shared transaction. Submission is online only and uses a durable operation and a draft fence, not just a post-commit flag.

1. Resolve the verified tenant, company and actor. Require field changes and required photos acknowledged; read the server draft; validate schema and evidence readiness. Generate a submission epoch server-side. The request names draft, revision and idempotency key; ignore cached totals.
2. In a Firestore transaction check the authoritative revision and manifest and move the server-owned control record from `editing` to `submitting(operationId, epoch)`. Rules and every server and OCR writer must reject field mutations under the fence. For multi-document drafts, close the gate first, then enumerate and read a stable manifest, never a mixture of listener snapshots.
3. In one Postgres transaction lock job, customer and pricing rows; recheck rights and input versions; insert the immutable snapshot, record ID, operation receipt and outbox entry. A unique `(company_id, draft_id, submission_epoch)` prevents duplicates. The same idempotency key and digest returns the same record; the same key with different data conflicts. Valid schema alone does not establish authorization or pricing.
4. Mark the Firestore draft `submitted` with the Postgres record ID and keep it locked. An outbox/reconciler repairs lost responses or failed markers. SQL is authoritative after commit. An unknown commit outcome stays pending: a timeout cannot unlock it. Only a definitely aborted operation may release its own fence after reconciliation.
5. Generate narrative against the immutable snapshot, price deterministically, store the exact proposal and require human review. The SQL signing transaction checks proposal hash, price and identity versions, current access, required OCR and voice-note review and approved additions; it consumes the single-use link and creates the signature and delivery outbox once. Retries cannot sign or send twice.
6. Changes require an explicit new draft/version with provenance; a signed job uses the accepted incremental, separately signed change-order workflow. Firestore markers and SQL projections acknowledge state, never synchronize edits backward into a submitted source.

Race coverage must include delayed offline writes, concurrent submit/sign/reprice, membership removal, suspension, OCR callbacks, office edits and crashes on both sides of each cross-store boundary. Preserve rejected optimistic edits locally. Archive is soft and audited; signed jobs cannot be archived. An archived draft returns 410 and offers the phone Save as new draft or Discard.

## Isolation, identity and offline

Use a non-owner SQL runtime role without `BYPASSRLS`, forced row-level security, validated transaction-local tenant context, composite company foreign keys and narrow immutable-document grants. The migrator has a separate role. Test pooled connection reuse across companies; privileged roles do not automatically receive RLS protection.

The new named Firestore field database denies by default and permits only prescribed paths and fields with matching `firebase.tenant`, active company access, field owner and editing state. Old official collections remain denied to clients. Membership grants project only after SQL commit; revocation blocks server access first and is incomplete until the Firestore deny is confirmed. Use short-lived renewable grants and test the stale-access bound. Platform support is separately audited; superadmin status alone does not grant job editing.

Identity Platform tenants: bind actors to `(auth_tenant_id, uid)` and never link people solely by email. Test Google/password sign-in, invitations, MFA enrollment and recovery, revoked tokens, single-use links and support access.

Firestore persistent cache holds field documents; a separate IndexedDB queue holds photo and voice-note bytes and local operation IDs. Cached bytes cannot be remotely erased: explain trusted-device consent and recovery. Last-write-wins and optimistic display are not server acknowledgement. Photo retries use stable company/job/photo IDs and byte hashes, create-only object preconditions, idempotent metadata registration and a verified receipt before local deletion. Preserve late originals and foreground/reopen retries on iPhone; do not depend on upload after Safari closes.

Cache the field shell and required routes, not personalized SSR/API responses. Authenticated routes are dynamic and no-store; shared caches cannot use URL alone. Do not take over mid-capture or erase an old queue. A versioned, restartable same-origin bridge drains/imports legacy IndexedDB; test old and new tabs and controlled worker activation.
