# Data: Retention

Part of [Data](../DATA.md).

## Retention

| Data | Kept |
|---|---|
| Signing link | 7 days to sign; 30 days viewable after signing (Firestore TTL on `expire_at`) |
| Document link | 30 days (TTL) |
| Live resume checkpoint | 600 s (TTL) |
| Per-address anonymous counters | 1 hour (TTL) |
| Job summary cache | 30 days (TTL) |
| Staff invitation | expires logically after 7 days; the record, with the invitee's email, stays (owners can hide it with "clear") until the retention sweep deletes it, below |
| Company record retention (`backend/retention.py`, sweep flag `RETENTION_ENABLED`, off) | owner-set per class, 90 days by default and at least 90, at most 3,650: invitations from their expiry; activity-log entries from creation; a closed signed job's drying-watch history from the close (a marker stays); an archived unsigned draft's photo objects from the archiving. With the flag off nothing is deleted. Never deleted: a signed agreement and its photos, an open draft's photos, a pending unexpired invitation, an unclosed job's watch, and drying readings ([company-workspaces.md](../company-workspaces.md#record-retention)) |
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
