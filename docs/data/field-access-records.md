# Data: Rebuilt app field database: how the access records follow Postgres

Part of [Data](../DATA.md).

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
