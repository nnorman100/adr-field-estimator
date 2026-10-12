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

Firestore rules deny direct browser access. The backend uses ADC and project-scoped IAM: datastore user, Vertex AI user and Firebase Authentication viewer in this project, object user on this bucket only. Firebase Authentication viewer permits revoked/disabled-user checks without granting account administration. Public Cloud Run transport supports Hosting; business endpoints verify Firebase tokens with `check_revoked=True` and check ownership. Active Live sessions recheck the newest token (the initial one or a client refresh for the same user) every 20 seconds; propagation and request latency can add delay. Evidence responses are private and not cached. No service account keys or raw API keys are committed; the browser loads Firebase's Hosting initialization endpoint.

Firebase App Check is in its monitor-only first step. The browser sends a token with each API request and Live connection; the backend records whether it is valid, missing or invalid and never rejects on it. Enforcement for the backend and for Authentication is a later, separate change. See [app-check.md](app-check.md) for key setup, debug tokens and reading the results.

Limits: 20 MB/request, 30 photos, 2 MB/signature (4 MP), 8 MB/photo (60 MP), 750 KB metadata and 100 records per page with owner-checked next_cursor pagination. Photos upload individually. Firestore transactions enforce per-user limits across instances: 20 OCR calls, 6 scope-extraction requests, 3 audits and 10 authorization attempts per minute, 60 draft mutations per minute and one active Live session. Daily caps (`DAILY_LIMITS` in `backend/inspection_store.py`) allow each user 400 OCR calls, 120 scope extractions, 60 audits and 40 new Live sessions per 24-hour window that starts at the first call; resumed Live captures do not count. 429 responses include Retry-After; queued drafts remain recoverable. Failed saves remain visibly unsuccessful. There is no automated dispatch integration. Company-workspace invitations use the server-only Resend integration once a verified sender and secret are configured.

The Live relay checks origin, first-message Firebase authentication and inspection ownership before opening Vertex AI. Audio is 16 kHz mono PCM little-endian, video is JPEG at 1 FPS and playback is 24 kHz. A renewable 60-second Firestore lease limits concurrent sessions; cleanup releases it. Reconnect retries are bounded. Cloud Run allows 3600-second connections; REST OCR/audits have a 55-second overall deadline because Firebase Hosting has a 60-second request timeout.

## Cutover and historical data

The old `alert-disaster-live` site (in `mitigation-project`) was retired as of 2026-10-12: it no longer redirects and its addresses return HTTP 404. Use the dedicated app's address instead. The redirect configuration that was kept in `deployment/legacy-redirect` has been deleted; `review-artifacts/migration-redirect-deploy.log` remains as historical evidence of the earlier redirect deploy.

Other sites and databases in `mitigation-project` are unchanged. The old backend is retained for rollback and receives no calls from the migrated app. The reviewed old authorization endpoint only logged metadata and did not persist agreements, signatures or photos; there were no application records to copy. No unrelated records were copied.

## Deployment

Never use a blanket `firebase deploy`. Keep both `index.html` copies identical. Deploy indexes separately and verify they are READY before enabling paginated queries.

Deploy the backend only with `scripts/deploy_backend.py`. Cloud Run copies environment variables from the latest service template, which can be a staged revision with no traffic, so a raw `gcloud run deploy` can silently inherit `WORKSPACES_ENABLED=true`. The script requires `--workspaces on|off`, always sets that flag, keeps the other existing variables (staff list, model settings), and stages a tagged revision with `--no-traffic`. Review the command with `--dry-run`, then rerun with `--yes`.

Every release is stamped with the commit it was built from. `deploy_backend.py` refuses uncommitted or untracked changes under `backend/` (`--allow-dirty` stamps `<commit>-dirty` instead), writes the commit to `backend/SOURCE_COMMIT` in the uploaded build context for the duration of the deploy, and sets the revision label `source-commit`. The image reports it as `source_commit` in `/api/health`; an image built without the script reports `unknown`. `gcloud run deploy` also copies the label onto the service, so the service-level `source-commit` follows the latest staged revision even while traffic stays on an older one or after a rollback; only the serving revision's label or `/api/health` identifies the code that is serving. Before a Hosting deploy, `python scripts/stamp_hosting.py` stamps the same kind of commit into the service-worker `VERSION`, every versioned asset URL and the Account menu's app version, which also gives each release a new worker cache. The committed shell carries the placeholder `unstamped`; `firebase.json` runs `python scripts/stamp_hosting.py --check` as the Hosting predeploy hook, so an unstamped or inconsistently stamped shell, or one stamped with a commit other than HEAD or with Hosting changes not in that commit, is never deployed; a `-dirty` stamp declares such changes and is accepted as is. Restore the placeholder with `--reset` afterwards. Both scripts print a row to append to [RELEASES.md](../RELEASES.md), the only record of deployed state.

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

Select the exact candidate tag after checking its revision in the dedicated project and in
[RELEASES.md](../RELEASES.md); tags such as `body-limits` name past releases, not a permanent staging
alias. There is no implicit historical staged target. `--expect-commit <commit>` makes
`verify_live_release.py` fail unless the backend reports that `source_commit`.
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
