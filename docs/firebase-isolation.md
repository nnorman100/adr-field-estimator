# Dedicated Firebase migration

The app was migrated on October 6, 2026. Hosting, Firebase Authentication, Firestore, Cloud Run, private evidence storage, service identities and Vertex AI requests use `alert-disaster-field-2026` (project number `545776254070`).

| Resource | Dedicated value |
| --- | --- |
| App | https://alert-disaster-field-2026.web.app |
| Web app ID | `1:545776254070:web:c380c2ee35398689143357` |
| Hosting target | `alert-disaster` |
| Firestore | `(default)`, native mode, `us-west2`, deletion protection enabled |
| Evidence bucket | `alert-disaster-field-2026-evidence`, private, `us-west2` |
| Cloud Run | `alert-disaster-field-estimator`, `us-west2` |
| Runtime account | `adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com` |
| Build account | `adr-builder@alert-disaster-field-2026.iam.gserviceaccount.com` |
| Vertex AI | OCR/audit `gemini-3.8-flash` in `global`; `gemini-3.8-live` in `us-central1` |

Billing uses the approved Citi Bank account ending F05CC3. Sharing a billing account does not share project data or service identities.

## Sign-in and saved jobs

Production has run with `WORKSPACES_ENABLED=true` since October 15, 2026 (see [RELEASES.md](../RELEASES.md)). The legacy owner-only mode, used when it is false, relies on verified Google sign-in and the `STAFF_EMAILS` allowlist. The company-workspace build replaces this with private memberships and company/job permissions when `WORKSPACES_ENABLED=true`; its migration binds `nathanaelcnorman@gmail.com` as initial superadmin and ADR owner. Read [company-workspaces.md](company-workspaces.md) before enabling it, configuring invitation email, migrating access or rolling it back. Rolling back to a workspaces-off revision restores the legacy owner-only mode.

Private drafts live in `inspections`, with schema version 3 for new records, owner UID, expected revision, structured scope, separate transcripts and photo references. Existing version-2 drafts remain readable and are updated in place; signed records remain immutable. Updates use Firestore transactions; conflicts return 409. Individual original photos live under `users/{uid}/inspections/{id}`. OCR status and result belong to the exact photo and room. Audits hash the saved revision, inputs, evidence and all four validated documents.

Signed agreements live in `authorizations` after signature validation. They reference the audited inspection revision and proposal hash and retain an immutable four-document snapshot plus evidence. Signature paths use a unique attempt ID and payload hash under `users/{uid}/authorizations/{id}`. Photo attempts also have unique paths. Rejected transactions delete only object generations confirmed unreferenced; if that confirmation or deletion fails, the private object is retained and cleanup failure is logged. Identical retries return the original receipt, including concurrent attempts. Signed inspections cannot be edited. Historical agreements remain readable; outdated clients cannot create new signatures.

Firestore rules deny direct browser access. The backend uses ADC and project-scoped IAM: datastore user, Vertex AI user, Firebase Authentication viewer and the custom role `adrInviteProvisioner` in this project, object user on this bucket only. Firebase Authentication viewer permits revoked/disabled-user checks. `adrInviteProvisioner` (granted October 14, 2026) adds only `firebaseauth.users.create` and `firebaseauth.users.sendEmail` beyond that, for invitation account provisioning and set-password links; it grants no user deletion, update or configuration access. Public Cloud Run transport supports Hosting; business endpoints verify each Firebase token's signature and expiry on every request and check ownership. The revoked/disabled-user lookup (`check_revoked=True`) runs live for signing (`POST /api/authorize`), creating and revoking homeowner signing links, signed-evidence downloads, Live session start, `/api/admin/**`, company profile, team and invitation management, invitation acceptance and job-coordination saves (which change job access). Other routes reuse a passed lookup for the same token, keyed by its SHA-256 digest in a bounded per-instance cache, for `REVOCATION_CACHE_SECONDS` (default 45, at most 60, 0 disables reuse) and never past the token's expiry, so a revoked or disabled user is refused on those routes within that time. Active Live sessions recheck the newest token (the initial one or a client refresh for the same user) every 20 seconds and repeat the revocation lookup at every recheck, so revocation ends a session at the next recheck, within 20 seconds; propagation and request latency can add delay. Evidence responses are private and not cached. No service account keys or raw API keys are committed; the browser loads Firebase's Hosting initialization endpoint.

The login page leads with email and password; Google sign-in is the secondary option below them. On the live site `alert-disaster-field-2026.web.app`, the browser overrides the configured `authDomain` with that host, so Google sign-in uses Hosting's same-origin `/__/auth/` helper. Safari's third-party storage blocking would otherwise cut the popup off from the page ([Firebase guidance, option 1](https://firebase.google.com/docs/auth/web/redirect-best-practices#update-authdomain)). This requires `https://alert-disaster-field-2026.web.app/__/auth/handler` as an authorized redirect URI on the Google OAuth web client that Firebase Authentication uses, and the domain in Authentication's authorized domains. Preview channels and localhost keep the configured `firebaseapp.com` helper. `scripts/verify_hosting.js` fails if Google rejects the popup's redirect URI.

Firebase App Check is in its monitor-only first step. The browser sends a token with each API request and Live connection; the backend records whether it is valid, missing or invalid and never rejects on it. Enforcement for the backend and for Authentication is a later, separate change. See [app-check.md](app-check.md) for key setup, debug tokens and reading the results.

Limits: 20 MB/request, 30 photos, 2 MB/signature (4 MP), 8 MB/photo (60 MP), 750 KB metadata and 100 records per page with owner-checked next_cursor pagination. Photos upload individually. Firestore transactions enforce per-user limits across instances: 20 OCR calls, 6 scope-extraction requests, 3 audits and 10 authorization attempts per minute, 60 draft mutations per minute and one active Live session. Daily caps (`DAILY_LIMITS` in `backend/inspection_store.py`) allow each user 400 OCR calls, 120 scope extractions, 60 audits and 40 new Live sessions per 24-hour window that starts at the first call; resumed Live captures do not count. 429 responses include Retry-After; queued drafts remain recoverable. Failed saves remain visibly unsuccessful. There is no automated dispatch integration. Company-workspace invitations use the server-only Resend or Gmail SMTP transport once a sender and its secret are configured (see [company-workspaces.md](company-workspaces.md#invitations-and-interfaces)).

The Live relay checks origin, first-message Firebase authentication and inspection ownership before opening Vertex AI. Audio is 16 kHz mono PCM little-endian, video is a 640 px JPEG every 2 s and playback is 24 kHz. Protocol-2 audio packets carry a sequence number and the relay acknowledges every tenth (`ready.audio_ack`); the client pauses video for 10 seconds, with a weak-signal status, while acknowledged audio is more than 600 ms behind, and sends no frame while microphone audio is queued. A renewable 60-second Firestore lease limits concurrent sessions; cleanup releases it. Reconnect retries are bounded. Cloud Run allows 3600-second connections; REST OCR/audits have a 55-second overall deadline because Firebase Hosting has a 60-second request timeout. Audit and scope calls use low thinking. An audit model call still running after 25 seconds is cancelled and retried once if at least 10 seconds remain before the 5-second save reserve (the last 5 seconds of the deadline stay reserved to save the documents). With less than 35 seconds left when the audit starts, for example after a long OCR wait, the single attempt gets the whole remaining budget and is not retried. Each retry is logged as `Vertex AI retry`.

## Homeowner signing links

A technician who holds the `sign` permission for a job (any approved staff user in owner-only mode; owner or estimator in workspaces mode) can create a link for the current signable audit with `POST /api/inspections/{id}/signing-links`. The server makes a 256-bit random token, returns it once inside the link (`/sign#<token>`) with a server-generated QR code (the `qrcode` package, hash-locked in `backend/requirements.txt`), and stores only the token's SHA-256 digest in `_signing_links/{digest}` with the inspection, revision, proposal hash, creating user, company and expiry. `_signing_link_jobs/{inspection id}` names the one active link; creating another link revokes it, and `POST /api/inspections/{id}/signing-links/revoke` revokes it directly. `GET /api/inspections/{id}/signing-links` reports that link's state to a technician with the same `sign` access (`pending` with its expiry only while it can still sign, otherwise `used`, `revoked`, `voided`, `expired` or `none`) and never returns the token, so the Review tab restores the waiting status, polling and Revoke after a reload or job switch; the QR code and link are shown only when created. The token stays in the URL fragment, so it never reaches Hosting or Cloud Run request logs or a Referer header; the homeowner page sends it only in the `X-ADR-Signing-Link` header.

`GET /api/sign`, `GET /api/sign/photos/{photo_id}`, `GET /api/sign/signature` and `POST /api/sign` are the only anonymous business routes; the bearer precheck exempts only `POST /api/sign` (3.5 MB body limit). Each request reads and signs as the technician who created the link, through the same store hooks as staff requests, so owner-only and company job access apply in both modes and a technician who loses access also disables their outstanding links. A link reads only its own inspection's four documents and photos. Every read and the signature re-run the revision and proposal-hash check: any edit, photo, recognition change or on-device signature turns an unused link into `voided` (409, "This estimate was updated"). Unknown, expired (7 days), revoked and inaccessible links all return the same 404. The signature uses the existing authorization transaction with a reference derived from the link digest (`ADR-AUTH-link-…`), so an identical retry returns the same receipt; the same transaction marks the link `used`. A used link stays read-only (documents, photos, receipt and signature) for 30 days after signing and then returns 404.

Limits: 60 document reads per minute per link, 10 signing attempts per link in total, 120 anonymous requests per minute per client address (counted in `_limits/ip-<HMAC-SHA-256 of the address>` under a random server key created once in `_server_keys/signing_link_addresses`, so the counter cannot be reversed to an address; each counter carries an `expire_at` TTL field one hour after its last request), and link creation or revocation counts 10 per minute against the technician's quota. The homeowner page loads photos one at a time.

The signed record adds `signing_channel: link`, the typed name and role (`owner` or `authorized_representative`), the consent statements the page displayed with their version (`homeowner-link-v1`), the link digest, creator and creation time, and the client's IP address and user agent. `client_ip` in `backend/main.py` takes the address `TRUSTED_FORWARDED_HOPS` (2) entries from the right of `X-Forwarded-For`: the entry Hosting appends before the Cloud Run front end appends Hosting's own address. Client-supplied leading entries are ignored, and a shorter chain records no address. The same address keys the per-address limit. A request sent straight to the `run.app` URL can still choose that entry. The token, addresses and user agent never reach the log. The consent wording should be confirmed with counsel before customer use.

`expire_at` on `_signing_links` is a Firestore TTL field (the link's expiry, then 30 days after signing). Expiry is enforced on every use; enable physical deletion once with:

```powershell
gcloud firestore fields ttls update expire_at --collection-group=_signing_links --enable-ttl --project=alert-disaster-field-2026
```

The per-address counters use the same field name in `_limits`; only those documents carry it, so per-user counters are unaffected. Enable their deletion once as a release step:

```powershell
gcloud firestore fields ttls update expire_at --collection-group=_limits --enable-ttl --project=alert-disaster-field-2026
```

The release verifiers create links on synthetic jobs, read and sign them with no sign-in, check that a replaced link and a link left unused before an on-device signature are refused, and remove the tracked `_signing_links` and `_signing_link_jobs` records with the jobs. The browser verifier opens the link in a separate signed-out browser context and confirms the routed technician tab switches to the signed agreement.

## Cutover and historical data

The old `alert-disaster-live` site (in `mitigation-project`) was retired as of 2026-10-12: it no longer redirects and its addresses return HTTP 404. Use the dedicated app's address instead. The redirect configuration that was kept in `deployment/legacy-redirect` has been deleted; the earlier redirect deploy log was removed from the repository with the rest of `review-artifacts/` and remains in git history.

Other sites and databases in `mitigation-project` are unchanged. The old backend is retained for rollback and receives no calls from the migrated app. The reviewed old authorization endpoint only logged metadata and did not persist agreements, signatures or photos; there were no application records to copy. No unrelated records were copied.

## Deployment

Never use a blanket `firebase deploy`. Keep both `index.html` copies identical. Deploy indexes separately and verify they are READY before enabling paginated queries.

Deploy the backend only with `scripts/deploy_backend.py`. Cloud Run copies environment variables from the latest service template, which can be a staged revision with no traffic, so a raw `gcloud run deploy` can silently inherit `WORKSPACES_ENABLED=true`. The script requires `--workspaces on|off`, always sets that flag, keeps the other existing variables (staff list, model settings), and stages a tagged revision with `--no-traffic`. Review the command with `--dry-run`, then rerun with `--yes`.

Every release is stamped with the commit it was built from. `deploy_backend.py` refuses uncommitted or untracked changes under `backend/` (`--allow-dirty` stamps `<commit>-dirty` instead), writes the commit to `backend/SOURCE_COMMIT` in the uploaded build context for the duration of the deploy, and sets the revision label `source-commit`. The image reports it as `source_commit` in `/api/health`; an image built without the script reports `unknown`. `gcloud run deploy` also copies the label onto the service, so the service-level `source-commit` follows the latest staged revision even while traffic stays on an older one or after a rollback; only the serving revision's label or `/api/health` identifies the code that is serving. Before a Hosting deploy, `python scripts/stamp_hosting.py` stamps the same kind of commit into the service-worker `VERSION`, every versioned asset URL and the Account menu's app version, which also gives each release a new worker cache. The committed shell carries the placeholder `unstamped`; `firebase.json` runs `node scripts/run_python.js scripts/stamp_hosting.py --check` as the Hosting predeploy hook (the launcher uses whichever of `python`, `python3` or `py` exists and blocks the deploy if none does), so an unstamped or inconsistently stamped shell, or one stamped with a commit other than HEAD or with Hosting changes not in that commit, is never deployed; a `-dirty` stamp declares such changes and is accepted as is. Restore the placeholder with `--reset` afterwards. Both scripts print a row to append to [RELEASES.md](../RELEASES.md), the only record of deployed state.

```powershell
firebase.cmd deploy --only firestore:indexes --project alert-disaster-field-2026
# Confirm the required indexes are READY before deploying the backend.
gcloud firestore indexes composite list --project=alert-disaster-field-2026
python scripts/deploy_backend.py --workspaces off --tag workspaces-off-YYYYMMDD --dry-run
python scripts/deploy_backend.py --workspaces off --tag workspaces-off-YYYYMMDD --yes
# Append the printed row to RELEASES.md. Before promotion, the tagged URL printed by the deploy must answer
# {"status":"healthy","schema_version":3,"source_commit":"<the stamped commit>"}.
curl.exe -s <tagged-revision-url>/api/health
# Configuration, including the chosen flag ("workspaces_enabled":false for --workspaces off), is staff-only at
# /api/health/details; `node scripts/verify_live_browser.js --backend-tag <tag>` prints it after normal staff sign-in.
gcloud run services update-traffic alert-disaster-field-estimator --to-tags=workspaces-off-YYYYMMDD=100 --region=us-west2 --project=alert-disaster-field-2026 --billing-project=alert-disaster-field-2026
# Append a "100% (promoted)" row for the backend to RELEASES.md.
firebase.cmd deploy --only firestore:rules --project alert-disaster-field-2026
firebase.cmd deploy --only auth --project alert-disaster-field-2026
python scripts/stamp_hosting.py
firebase.cmd deploy --only hosting:alert-disaster --project alert-disaster-field-2026
# Compare the deployed shell and backend commits, append the printed Hosting row to RELEASES.md, then reset.
node scripts/verify_hosting.js
python scripts/stamp_hosting.py --reset
```

The backend rejects a different project ID or evidence bucket. Production never enables local demo fallbacks.

## Verification and review scope

Local tests cover pricing, documents, ownership, retries, authentication, bounded uploads, failures, revision conflicts, Live formats and teardown. Chromium/WebKit tests exercise the real UI with synthetic adapters. Release verification uses scripts/verify_live_browser.js with normal staff sign-in and makes no IAM changes. Each verifier takes the dedicated backend URL as a required argument and has no default target. The historical `verify_migration.py`, `verify_repairs.py` and `verify_review_fixes.py` probes, which minted synthetic custom tokens through a signing grant, were removed; their shared helpers now live in `scripts/verify_common.py`.

The [original review](https://chatgpt.com/space/page_4a5293fc2ec481918bd32e5c78fb2dca) remains the baseline. Current repair status and device acceptance are in `docs/review-repairs.md`.

## Rollback

The previous dedicated backend revisions remain available. Restore traffic only with an explicit dedicated project/region and the matching Firebase Hosting release; do not pair the old backend with the new schema-3 frontend. No stored data is deleted on rollback. The historical shared project is not a repair rollback target.

[Firebase Hosting timeout documentation](https://firebase.google.com/docs/hosting/serverless-overview), [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets), [Live API formats](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api).


## Live protocol 2 checkpoints

Live configuration uses google-genai==2.29.0, whose Live wire messages match the earlier tested 2.8.0
baseline in mock tests (tests/test_live_reliability.py), LIVE_VOICE (default Charon),
64,000-token compression trigger and 32,000-token target. No model/region change is introduced.
Session handles stay in private _live_resume documents keyed by owner UID and bound to the
inspection, capture ID, lease and scope fingerprint (excluding transcript/capture metadata and
confirmation-state updates). Application expiry is 600 seconds after disconnection; provider
retention/resumption guarantees are separate. expire_at is a Firestore TTL field for this collection
only. Expiry rejects use immediately; physical TTL deletion is asynchronous. Stop/Finish deletes
its matching checkpoint. The protocol-2 finished acknowledgement follows the final-transcript drain (at most 3 seconds) and precedes lease/checkpoint cleanup, because the client stops waiting 3.5 seconds after End. Only audio above a speech-level RMS threshold arms that drain; open-microphone silence does not. `gemini-3.8-live` never sets a transcription's `finished` flag, so a completed model turn also ends the drain, and the client closes transcript segments on `turn_complete` and `interrupted`. The `Live session ended` log event adds content-free counters: microphone seconds, longest microphone gap, video frames, turns, interruptions, model audio seconds, reply latency (median and maximum, from the last received speech to the first reply audio), reply delivery pace, and the client's gap and video-pause counts.

The first-message handshake adds protocol_version=2, capture_id and resume. Older clients retain
protocol-1 responses. The authenticated /api/session advertises live_protocol_version=2.
Capture metadata is optional and omitted for old drafts with no capture; new data stores bounded
speaker/connection/sequence/text/finality segments plus completeness, gaps and technician edits.
No direct-client keys, ephemeral tokens, vocabulary options or Live tools are enabled.

## Normal staff sign-in release verification

The current release helper does not mint synthetic user tokens or change IAM. Start it from
the repository root:

```powershell
node scripts/verify_live_browser.js --backend-tag body-limits --hold
```

Select the exact candidate tag after checking its revision in the dedicated project and in
[RELEASES.md](../RELEASES.md); tags such as `body-limits` name past releases, not a permanent staging
alias. There is no implicit historical staged target. `--expect-commit <commit>` makes
`verify_live_release.py` fail unless the backend reports that `source_commit`.
Staged requests reach the tagged revision directly, so its signing-link phase reports `ip_address absent`; after the Hosting release, confirm with one synthetic link signature made through Hosting that the record's `signer.ip_address` is the signing device's public address.
`--workspaces` explicitly selects the
workspace staging tag (`workspaces`) and is not appropriate for a repairs-only release. `--production` verifies
deployed assets rather than the local candidate. Output defaults to a unique temporary directory;
`--artifact-dir` accepts an absolute external parent and creates a new run directory under it.

The helper opens normal private Chrome without automation attached. Complete Google sign-in
with the approved staff account; do not enter a customer job. Send `signed-in` to the helper
only after the app finishes signing in. Automation attaches after that handoff, avoiding the
Google rejection reproduced in automated Chrome. Signing in on the real site is the one
unrouted step: the app creates an empty draft in production, which the helper reports as
`SIGN_IN_TAB` and removes with the run's own records. The runner then opens a second tab in the
same private window, which inherits that sign-in through the app's own Firebase persistence,
tells Chrome to bypass service workers for that tab, holds the ID token in memory and passes it
to Python over stdin. The private profile is temporary and deleted with the window; the helper
exports no browser authentication state and never accepts a token as a command-line argument.

The staged UI uses the local frontend and proxies every `/api` call of the automated tab to
the dedicated tagged revision; the Live socket, which the app only opens to the production URL,
is bridged to that revision with the app's origin. Before each workflow phase the helper proves
the target: the page's own `/api/health` must report the tagged revision's `source_commit`, the
app's Live URL must be the one the bridge intercepts, and a bridged probe socket must answer
with the backend's authentication error (`TARGET_VERIFIED`). A request that escapes the route,
is answered by a service worker, cannot be fetched from the backend (transport error or the
115-second deadline) or is redirected stops the run with `ROUTING_VIOLATION`; HTTP error
statuses are routed answers that the workflow itself judges. `BACKEND[phase]` lines and
`routing.txt` in the artifact directory record what each phase reached, including the page load.
Finish & review is bounded (`FINALIZE_TIMEOUT`), the Python phases have watchdogs, and tracked
synthetic records are cleaned after every phase, including failed ones.
The Python helper validates identity through /api/session, checks for an
existing active/resumable walkthrough before opening Live, and refuses to replace that
existing capture. It verifies review-only suggestions, selective application, stale
revision rejection, actual OCR/Live/provider resumption, Finish checkpoint/lease deletion,
workbook totals, all four documents, signing and private evidence restoration.

After READY_FOR_CUTOVER, perform the backend-first isolated release. Send production to the
still-running helper's stdin to repeat its authenticated checks and UI workflow against the
production service; send quit when done. Test cleanup checks owner UID and removes only
IDs created by that run and their exact evidence prefixes. Failed-test checkpoint deletion
also uses an update-time precondition and cannot erase another inspection's checkpoint.
The existing staff identity, other jobs and staff quotas are retained.

Credential-free initialization check:

```powershell
node scripts/verify_live_browser.js --headless --auth-smoke
```

This check does not authenticate, create jobs or establish field-device acceptance.
If the browser closes before sign-in, authenticated verification has not run; restart the
helper and complete sign-in before changing traffic or Hosting.
