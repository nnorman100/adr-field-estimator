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

The current production release uses verified Google sign-in and the `STAFF_EMAILS` allowlist. The company-workspace build replaces this with private memberships and company/job permissions when `WORKSPACES_ENABLED=true`; its migration binds `nathanaelcnorman@gmail.com` as initial superadmin and ADR owner. Read [company-workspaces.md](company-workspaces.md) before enabling it, configuring invitation email, migrating access or rolling it back. Until enabled, the legacy owner-only mode remains active.

Private drafts live in `inspections`, with schema version 3 for new records, owner UID, expected revision, structured scope, separate transcripts and photo references. Existing version-2 drafts remain readable and are updated in place; signed records remain immutable. Updates use Firestore transactions; conflicts return 409. Individual original photos live under `users/{uid}/inspections/{id}`. OCR status and result belong to the exact photo and room. Audits hash the saved revision, inputs, evidence and all four validated documents.

Signed agreements live in `authorizations` after signature validation. They reference the audited inspection revision and proposal hash and retain an immutable four-document snapshot plus evidence. Signature paths use a unique attempt ID and payload hash under `users/{uid}/authorizations/{id}`. Photo attempts also have unique paths. Rejected transactions delete only object generations confirmed unreferenced; if that confirmation or deletion fails, the private object is retained and cleanup failure is logged. Identical retries return the original receipt, including concurrent attempts. Signed inspections cannot be edited. Historical agreements remain readable; outdated clients cannot create new signatures.

Firestore rules deny direct browser access. The backend uses ADC and project-scoped IAM: datastore user, Vertex AI user and Firebase Authentication viewer in this project, object user on this bucket only. Firebase Authentication viewer permits revoked/disabled-user checks without granting account administration. Public Cloud Run transport supports Hosting; business endpoints verify Firebase tokens with `check_revoked=True` and check ownership. Active Live sessions recheck the original token every 20 seconds; propagation and request latency can add delay. Evidence responses are private and not cached. No service account keys or raw API keys are committed; the browser loads Firebase's Hosting initialization endpoint.

Limits: 20 MB/request, 30 photos, 2 MB/signature (4 MP), 8 MB/photo (60 MP), 750 KB metadata and 100 records per page with owner-checked next_cursor pagination. Photos upload individually. Firestore transactions enforce per-user limits across instances: 20 OCR calls, 6 scope-extraction requests, 3 audits and 10 authorization attempts per minute, 60 draft mutations per minute and one active Live session. Daily caps (`DAILY_LIMITS` in `backend/inspection_store.py`) allow each user 400 OCR calls, 120 scope extractions, 60 audits and 40 new Live sessions per 24-hour window that starts at the first call; resumed Live captures do not count. 429 responses include Retry-After; queued drafts remain recoverable. Failed saves remain visibly unsuccessful. There is no automated dispatch integration. Company-workspace invitations use the server-only Resend integration once a verified sender and secret are configured.

The Live relay checks origin, first-message Firebase authentication and inspection ownership before opening Vertex AI. Audio is 16 kHz mono PCM little-endian, video is JPEG at 1 FPS and playback is 24 kHz. A renewable 60-second Firestore lease limits concurrent sessions; cleanup releases it. Reconnect retries are bounded. Cloud Run allows 3600-second connections; REST OCR/audits have a 55-second overall deadline because Firebase Hosting has a 60-second request timeout.

## Cutover and historical data

The old `alert-disaster-live` site redirects to the dedicated app. A retirement service worker removes this app's old cache and moves existing clients to the new origin. Its isolated deployment files are in `deployment/legacy-redirect`.

Other sites and databases in `mitigation-project` are unchanged. The old backend is retained for rollback and receives no calls from the migrated app. The reviewed old authorization endpoint only logged metadata and did not persist agreements, signatures or photos; there were no application records to copy. No unrelated records were copied.

## Deployment

Never use a blanket `firebase deploy`. Keep both `index.html` copies identical. Deploy indexes separately and verify they are READY before enabling paginated queries.

Deploy the backend only with `scripts/deploy_backend.py`. Cloud Run copies environment variables from the latest service template, which can be a staged revision with no traffic, so a raw `gcloud run deploy` can silently inherit `WORKSPACES_ENABLED=true`. The script requires `--workspaces on|off`, always sets that flag, keeps the other existing variables (staff list, model settings), and stages a tagged revision with `--no-traffic`. Review the command with `--dry-run`, then rerun with `--yes`.

```powershell
firebase.cmd deploy --only firestore:indexes --project alert-disaster-field-2026
# Confirm the required indexes are READY before deploying the backend.
gcloud firestore indexes composite list --project=alert-disaster-field-2026
python scripts/deploy_backend.py --workspaces off --tag workspaces-off-YYYYMMDD --dry-run
python scripts/deploy_backend.py --workspaces off --tag workspaces-off-YYYYMMDD --yes
# Before promotion, the tagged URL printed by the deploy must report the chosen flag ("workspaces_enabled":false for --workspaces off).
curl.exe -s <tagged-revision-url>/api/health
gcloud run services update-traffic alert-disaster-field-estimator --to-tags=workspaces-off-YYYYMMDD=100 --region=us-west2 --project=alert-disaster-field-2026 --billing-project=alert-disaster-field-2026
firebase.cmd deploy --only firestore:rules --project alert-disaster-field-2026
firebase.cmd deploy --only auth --project alert-disaster-field-2026
firebase.cmd deploy --only hosting:alert-disaster --project alert-disaster-field-2026
```

The backend rejects a different project ID or evidence bucket. Production never enables local demo fallbacks.

## Verification and review scope

Local tests cover pricing, documents, ownership, retries, authentication, bounded uploads, failures, revision conflicts, Live formats and teardown. Chromium/WebKit tests exercise the real UI with synthetic adapters. `scripts/verify_review_fixes.py` checks dedicated pagination, upload conflicts, signing retries and disabled Live/REST sessions with synthetic data. `scripts/verify_repairs.py` checks live routing, actual OCR/audits/Live relay, durable records, private evidence and owner isolation. It creates/removes only synthetic records and accounts. Those historical helpers use a synthetic-token path that requires a signing grant. Current release verification uses scripts/verify_live_browser.js with normal staff sign-in and makes no IAM changes; do not use the historical token path for this release. Each verifier takes the dedicated backend URL as a required argument and has no default target. The historical `verify_migration.py` probe, which minted owner-email tokens against the old API, was removed; its helpers now live in `scripts/verify_repairs.py`.

The [original review](https://chatgpt.com/space/page_4a5293fc2ec481918bd32e5c78fb2dca) remains the baseline. Current repair status and device acceptance are in `docs/review-repairs.md`.

## Rollback

The previous dedicated backend revisions remain available. Restore traffic only with an explicit dedicated project/region and the matching Firebase Hosting release; do not pair the old backend with the new schema-3 frontend. No stored data is deleted on rollback. The historical shared project is not a repair rollback target.

[Firebase Hosting timeout documentation](https://firebase.google.com/docs/hosting/serverless-overview), [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets), [Live API formats](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api).


## Live protocol 2 checkpoints

Live configuration uses the tested google-genai==2.8.0 baseline, LIVE_VOICE (default Charon),
64,000-token compression trigger and 32,000-token target. No model/region change is introduced.
Session handles stay in private _live_resume documents keyed by owner UID and bound to the
inspection, capture ID, lease and scope fingerprint (excluding transcript/capture metadata and
confirmation-state updates). Application expiry is 600 seconds after disconnection; provider
retention/resumption guarantees are separate. expire_at is a Firestore TTL field for this collection
only. Expiry rejects use immediately; physical TTL deletion is asynchronous. Stop/Finish deletes
its matching checkpoint. The protocol-2 finished acknowledgement follows the final-transcript drain (at most 3 seconds) and precedes lease/checkpoint cleanup, because the client stops waiting 3.5 seconds after End. Only audio above a speech-level RMS threshold arms that drain; open-microphone silence does not.

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

Select the exact candidate tag after checking its revision in the dedicated project; `body-limits`
was production revision `00015-kem` after the October 12 backend release (`harden-fixes`, revision
`00013-hup`, is its rollback), not a permanent staging alias. There is no implicit historical staged target.
`--workspaces` explicitly selects the older
workspace staging tag and is not appropriate for a repairs-only release. `--production` verifies
deployed assets rather than the local candidate. Output defaults to a unique temporary directory;
`--artifact-dir` accepts an absolute external parent and creates a new run directory under it.

The helper opens normal private Chrome without automation attached. Complete Google sign-in
with the approved staff account; do not enter a customer job. Send `signed-in` to the helper
only after the app finishes signing in. Automation attaches after that handoff, avoiding the
Google rejection reproduced in automated Chrome. The runner then forces Firebase
authentication persistence to NONE in its isolated test context,
holds the ID token in memory and passes it to Python over stdin. It exports no browser
authentication state and never accepts a token as a command-line argument.

The staged UI uses the local frontend and proxies only its API calls to the dedicated
tagged revision. The Python helper validates identity through /api/session, checks for an
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
