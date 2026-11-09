# Dedicated Firebase migration

The app was migrated on October 6, 2026. Hosting, Firebase Authentication, Firestore, Cloud Run, private evidence storage, service identities and Vertex AI requests use `alert-disaster-field-2026` (project number `545776254070`).

| Resource | Dedicated value |
| --- | --- |
| App | https://alert-disaster-field-2026.web.app/app (the site root is the public landing page) |
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

Production has run with `WORKSPACES_ENABLED=true` since October 15, 2026 (see [RELEASES.md](../RELEASES.md)). The legacy owner-only mode, used when it is false, relies on verified Google sign-in and the `STAFF_EMAILS` allowlist, which fails closed: an unset or empty value admits nobody. For how deploys set it, see [Deployment](#deployment) and [Automatic deploys](#automatic-deploys). The company-workspace build replaces this with private memberships and company/job permissions when `WORKSPACES_ENABLED=true`; its migration binds `nathanaelcnorman@gmail.com` as initial superadmin and ADR owner. Read [company-workspaces.md](company-workspaces.md) before enabling it, configuring invitation email, migrating access or rolling it back. Rolling back to a workspaces-off revision restores the legacy owner-only mode.

Private drafts live in `inspections`, with schema version 3 for new records, owner UID, expected revision, structured scope, separate transcripts and photo references. Existing version-2 drafts remain readable and are updated in place; signed records remain immutable. Updates use Firestore transactions; conflicts return 409. Individual original photos live under `users/{uid}/inspections/{id}`; uploads also store a 1600 px JPEG copy beside each original (`<name>-1600.jpg`, recorded as the photo's `model_file`), which the audit sends instead of the original. Photos without a readable copy fall back to the original. Phones upload each photo as a binary multipart body (a `metadata` JSON part and one `file` part); older app versions still send base64 JSON. A photo larger than 2,560 px on its longest edge uploads as a 2,560 px JPEG copy (quality about 0.85) that becomes the photo's `file`, and the upload records the full-size original's SHA-256 and type as the photo's `original`. The phone later sends that original as the raw body of `POST /api/inspections/{id}/photos/{photo_id}/original`; the server checks type, size and decoding as for any photo, accepts only bytes matching the recorded hash and stores them beside the copy as `original-<sha256>.<type>` with `if_generation_match=0` (a retry that finds the object is a success). Nothing in the inspection or a signed agreement changes when it arrives. Documents, OCR and the 1600 px model copy all use the 2,560 px copy; the original is evidence only. OCR status and result belong to the exact photo and room. Audits hash the saved revision, inputs, evidence and all four validated documents.

Drying-log readings live in `drying_logs`, one document per inspection, appended and removed in transactions after the same access check as the inspection; they are never copied into the revision or the signed record. Signed agreements live in `authorizations` after signature validation. They reference the audited inspection revision and proposal hash and retain an immutable four-document snapshot plus evidence. Signature paths use a unique attempt ID and payload hash under `users/{uid}/authorizations/{id}`. Photo attempts also have unique paths. Rejected transactions delete only object generations confirmed unreferenced; if that confirmation or deletion fails, the private object is retained and cleanup failure is logged. Identical retries return the original receipt, including concurrent attempts. Signed inspections cannot be edited. Historical agreements remain readable; outdated clients cannot create new signatures.

Firestore rules deny direct browser access. The backend uses ADC and project-scoped IAM: datastore user, Vertex AI user, Firebase Authentication viewer and the custom role `adrInviteProvisioner` in this project, object user on this bucket only. Firebase Authentication viewer permits revoked/disabled-user checks. `adrInviteProvisioner` (granted October 14, 2026) adds `firebaseauth.users.create` and `firebaseauth.users.sendEmail` beyond that, for invitation account provisioning and set-password links; it grants no user deletion or configuration access. Superadmin-created owner logins and the owner's temporary-password change also use `firebaseauth.users.update` (setting a password, marking the email verified and setting the `password_change_required` custom claim). [RELEASES.md](../RELEASES.md) records that `adrInviteProvisioner` has held `firebaseauth.users.update` since 2026-10-20 (the `00057-bos` row; checked on tag `tpw-20261019`, revision `00056-qaf`, which was not itself a release). This sentence states that record and does not re-read the live IAM policy. See [company-workspaces.md](company-workspaces.md#owner-logins-with-a-temporary-password). Public Cloud Run transport supports Hosting; business endpoints verify each Firebase token's signature and expiry on every request and check ownership. The revoked/disabled-user lookup (`check_revoked=True`) runs live for signing (`POST /api/authorize`), creating and revoking homeowner signing links, signed-evidence downloads, Live session start, `/api/admin/**`, company profile, team and invitation management, invitation acceptance, the temporary-password change (`POST /api/account/password`) and job-coordination saves (which change job access). Other routes reuse a passed lookup for the same token, keyed by its SHA-256 digest in a bounded per-instance cache, for `REVOCATION_CACHE_SECONDS` (default 45, at most 60, 0 disables reuse) and never past the token's expiry, so a revoked or disabled user is refused on those routes within that time. Active Live sessions recheck the newest token (the initial one or a client refresh for the same user) every 20 seconds and repeat the revocation lookup at every recheck, so revocation ends a session at the next recheck, within 20 seconds; propagation and request latency can add delay. Evidence responses are private and not cached. No service account keys or raw API keys are committed; the browser loads Firebase's Hosting initialization endpoint.

The login page leads with email and password; Google sign-in is the secondary option below them. On the live site `alert-disaster-field-2026.web.app`, the browser overrides the configured `authDomain` with that host, so Google sign-in uses Hosting's same-origin `/__/auth/` helper. Safari's third-party storage blocking would otherwise cut the popup off from the page ([Firebase guidance, option 1](https://firebase.google.com/docs/auth/web/redirect-best-practices#update-authdomain)). This requires `https://alert-disaster-field-2026.web.app/__/auth/handler` as an authorized redirect URI on the Google OAuth web client that Firebase Authentication uses, and the domain in Authentication's authorized domains. Preview channels and localhost keep the configured `firebaseapp.com` helper. `scripts/verify_hosting.js` fails if Google rejects the popup's redirect URI.

Firebase App Check is in its monitor-only first step. The browser sends a token with each API request and Live connection; the backend records whether it is valid, missing or invalid and never rejects on it. Enforcement for the backend and for Authentication is a later, separate change. See [app-check.md](app-check.md) for key setup, debug tokens and reading the results.

Limits: 20 MB/request, 60 photos, 2 MB/signature (4 MP), 8 MB/photo (60 MP, the copy and the original alike; the original route caps its body at 8 MB), 750 KB metadata and 100 records per page with owner-checked next_cursor pagination. Photos upload individually. Firestore transactions enforce per-user limits across instances: 20 OCR calls, 6 scope-extraction requests, 10 voice-note transcriptions, 3 audits and 10 authorization attempts per minute, 60 draft mutations per minute and one active Live session. Daily caps (`DAILY_LIMITS` in `backend/inspection_store.py`) allow each user 400 OCR calls, 120 scope extractions, 200 voice-note transcriptions, 60 audits and 40 new Live sessions per 24-hour window that starts at the first call; resumed Live captures do not count. The Maps routes add their own per-user caps (see [Address suggestions and the job map](#address-suggestions-and-the-job-map)). A separate shared company monthly AI allowance also applies ([Company AI spending](ai-spending.md)). 429 responses include Retry-After; queued drafts remain recoverable. Failed saves remain visibly unsuccessful. There is no automated dispatch integration. Company-workspace invitations use the server-only Resend or Gmail SMTP transport once a sender and its secret are configured (see [company-workspaces.md](company-workspaces.md#invitations-and-interfaces)).

Offline voice notes (`POST /api/inspections/{id}/voice-notes`) carry one note of at most 10 MB of MP4, WebM or Ogg audio as base64 in a request capped at 14 MB; the server checks the audio's file signature, and that the transcript has room for the note, before any model call. A note the server refuses for good (4xx other than 409 and 429) is marked as not processed on the phone, where the technician can replay or remove it; it does not count as unsynced work, and sign-out says such notes are kept only on this phone and removed by signing out. Network errors, 5xx, 409 and 429 retry, as does any failure of the draft save that precedes the upload. The route needs the job's scope permission, refuses signed inspections, and sends the audio inline to `AUDIT_MODEL` with low thinking for a verbatim transcript inside the 55-second REST deadline. One transaction appends the transcript text, labeled with a short note ID, room and local recording time, to the inspection's technician transcript and raises its revision; a note whose label is already in the transcript skips the model call and settles any pending or failed ledger row without appending text again. The audio is never written to Firestore, the evidence bucket or logs; the `Vertex AI call` log line records only `operation=transcribe`, timing and outcome. The inspection's `voice_notes` ledger records pending, failed, transcribed/reviewed or resolved notes. `POST /api/inspections/{id}/voice-notes/pending` reserves a note, clears scope confirmation and the audit, advances the revision and invalidates signing links. The sibling `/{note_id}/review` and `/{note_id}/resolve` endpoints acknowledge a transcribed note or resolve a pending/failed note; they require scope permission and an unsigned inspection. Pending, failed and unreviewed rows block scope extraction, audits and signing, including homeowner links. Records without a ledger remain compatible. Appending new transcript text also clears scope confirmation; lost-response recovery accepts that server-owned reset for both reservation-only responses and appended transcripts, in open and background drafts, while preserving other local edits. For the technician workflow, see [Offline notes](../README.md#offline-notes-for-bad-reception--deployed-acceptance-pending). On the phone, IndexedDB version 3 of `adr-private-drafts-v2` adds `notes` (metadata) and `note_audio` (slices) beside the draft and photo stores; they are removed with their draft.

The Live relay checks origin, first-message Firebase authentication and inspection ownership before opening Vertex AI. Audio is 16 kHz mono PCM little-endian, video is a 640 px JPEG every 2 s and playback is 24 kHz. Protocol-2 audio packets carry a sequence number and the relay acknowledges every tenth (`ready.audio_ack`); the client pauses video for 10 seconds, with a weak-signal status, while acknowledged audio is more than 600 ms behind, and sends no frame while microphone audio is queued. When `ready.shot_updates` is set, the client sends a `shots` packet after every `ready` and whenever the server stores a photo shot tag or room shot-list answer or count; the relay re-reads the saved inspection under the same access check and gives the model the per-room shot status as context between replies (never while it speaks or while a reply is expected — up to 5 seconds after the greeting trigger or technician speech, until the reply ends — and at most once a second), so the model hears saved shot status. Optional [readiness updates](readiness.md) use this same channel for saved job gaps. Room shot-list answers and counts are left out of the scope fingerprint, so setting one does not restart a walkthrough. A renewable 60-second Firestore lease limits concurrent sessions; cleanup releases it. Reconnect retries are bounded. Cloud Run allows 3600-second connections; REST OCR/audits have a 55-second overall deadline because Firebase Hosting has a 60-second request timeout. Audit and scope calls use low thinking. An audit model call still running after 25 seconds is cancelled and retried once if at least 10 seconds remain before the 5-second save reserve (the last 5 seconds of the deadline stay reserved to save the documents). With less than 35 seconds left when the audit starts, for example after a long OCR wait, the single attempt gets the whole remaining budget and is not retried. Each retry is logged as `Vertex AI retry`.

## Homeowner signing links

A technician who holds the `sign` permission for a job (any approved staff user in owner-only mode; owner or estimator in workspaces mode) can create a link for the current signable audit with `POST /api/inspections/{id}/signing-links`. The server makes a 256-bit random token, returns it once inside the link (`/sign#<token>`) with a server-generated QR code (the `qrcode` package, hash-locked in `backend/requirements.txt`), and stores only the token's SHA-256 digest in `_signing_links/{digest}` with the inspection, revision, proposal hash, creating user, company and expiry. `_signing_link_jobs/{inspection id}` names the one active link; creating another link revokes it, and `POST /api/inspections/{id}/signing-links/revoke` revokes it directly. `GET /api/inspections/{id}/signing-links` reports that link's state to a technician with the same `sign` access (`pending` with its expiry only while it can still sign, otherwise `used`, `revoked`, `voided`, `expired` or `none`) and never returns the token, so the Review & Sign step restores the waiting status, polling and Revoke after a reload or job switch; the QR code and link are shown only when created. The token stays in the URL fragment, so it never reaches Hosting or Cloud Run request logs or a Referer header; the homeowner page sends it only in the `X-ADR-Signing-Link` header.

`GET /api/sign`, `GET /api/sign/photos/{photo_id}`, `GET /api/sign/signature` and `POST /api/sign` are anonymous business routes alongside the [read-only document routes](#read-only-document-links); the bearer precheck exempts only `POST /api/sign` (3.5 MB body limit). Each request reads and signs as the technician who created the link, through the same store hooks as staff requests, so owner-only and company job access apply in both modes and a technician who loses access also disables their outstanding links. A link reads only its own inspection's four documents and photos. Every read and the signature re-run the revision and proposal-hash check: any edit, photo, recognition change or on-device signature turns an unused link into `voided` (409, "This estimate was updated"). Unknown, expired (7 days), revoked, archived-job and inaccessible links all return the same 404. Archiving a draft revokes its pending link in the same transaction, and restoring the draft does not bring the link back. The signature uses the existing authorization transaction with a reference derived from the link digest (`ADR-AUTH-link-…`), so an identical retry returns the same receipt; the same transaction marks the link `used`. A used link stays read-only (documents, photos, receipt and signature) for 30 days after signing and then returns 404.

Limits: 60 document reads per minute per link, 10 signing attempts per link in total, 120 anonymous requests per minute per client address (counted in `_limits/ip-<HMAC-SHA-256 of the address>` under a random server key created once in `_server_keys/signing_link_addresses`, so the counter cannot be reversed to an address; retention is described under [Firestore TTL policies](#firestore-ttl-policies)), and link creation or revocation counts 10 per minute against the technician's quota. The homeowner page loads photos one at a time.

The signed record adds `signing_channel: link`, the typed name and role (`owner` or `authorized_representative`), the consent statements the page displayed with their version (`homeowner-link-v1`), the link digest, creator and creation time, and the client's IP address and user agent. `client_ip` in `backend/main.py` takes the address `TRUSTED_FORWARDED_HOPS` (2) entries from the right of `X-Forwarded-For`: the entry Hosting appends before the Cloud Run front end appends Hosting's own address. Client-supplied leading entries are ignored, and a shorter chain records no address. The same address keys the per-address limit. A request sent straight to the `run.app` URL can still choose that entry. The token, addresses and user agent never reach the log. The consent wording should be confirmed with counsel before customer use.

For signing-link and per-address counter retention and physical deletion, see
[Firestore TTL policies](#firestore-ttl-policies).

The release verifiers create links on synthetic jobs, read and sign them with no sign-in, check that a replaced link and a link left unused before an on-device signature are refused, and remove the tracked `_signing_links` and `_signing_link_jobs` records with the jobs. The browser verifier opens the link in a separate signed-out browser context and confirms the routed technician tab switches to the signed agreement.

## Address suggestions and the job map

Three authenticated routes proxy Google's Places API (New) and Static Maps API so the browser never loads a Google script, image or key: `POST /api/places/autocomplete` (typed address to up to five suggestions), `POST /api/places/details` (a chosen suggestion to its address, city, state, ZIP and coordinates) and `POST /api/places/map` (coordinates to a PNG map image). `backend/places.py` holds the calls. The typed address, the place and the coordinates travel only in POST bodies, never in a URL that Cloud Run request logs keep, and no log line carries them: `Places lookup` events hold only `operation`, `outcome`, `status` and `elapsed_ms` (the allowlist in `backend/cloud_log.py`). Provider errors are not passed on, because a provider message can echo the request; every provider failure reads "Address lookup is unavailable. Type the address instead." (502).

- **Who:** a signed-in member whose role holds the `places` capability; see [company-workspaces.md](company-workspaces.md) for role access. The check runs on the server for every call (`places_access` in the stores), so it also follows a disabled member or suspended company. Without a key the routes answer 503 and use no quota.
- **Per-user caps** (`backend/inspection_store.py`, same `_limits` counters as the AI calls): suggestions 30 per minute and 200 per 24 hours, details 10 per minute and 60 per day, map images 20 per minute and 60 per day. A spent cap answers 429 with Retry-After, and the app falls back to a plain address box. The browser pauses lookups after 429 or 502 until Retry-After elapses (one second if absent), then retries; an online event also retries once that delay has elapsed. Only 403 and 503 disable lookups for the rest of the page load.
- **Key:** project `alert-disaster-field-2026` has one API key for this feature, restricted to the Places API (New) (`places.googleapis.com`) and the Maps Static API (`static-maps-backend.googleapis.com`) only. The key value lives only in Secret Manager as `dryscope-maps-api-key` (version 1), readable by `adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com`. `scripts/deploy_backend.py` mounts it as `MAPS_API_KEY` with `--update-secrets=MAPS_API_KEY=dryscope-maps-api-key:latest`, so a rotated key is a new secret version and a new revision. Never put the value in the repository, chat, CLI arguments or artifacts.
- **Project quota caps** (set on Oct 24, 2026, so a bug or stolen session cannot run up the bill beyond them): 1,000 `AutocompletePlacesRequest`, 500 `GetPlaceRequest` and 500 Static Maps `billable_default` requests per day.
- **Budget alert:** a $25 monthly budget on the project alerts at 50%, 90% and 100%.
- **Data:** a chosen suggestion's coordinates are saved on the draft as `coordinates` (latitude, longitude and the address text they belong to). They apply only while the address still reads that text; editing the address removes them. The `coordinates` object, including its copy of the address text, is excluded from Gemini input (`prompt_inspection`, `scope_prompt`) and from the Live scope fingerprint; the inspection's main `address` field remains model input. Drafts and signed jobs saved before this feature have no `coordinates` and show only a keyless directions link; nothing is backfilled.
- **Offline or no key:** the address stays a plain text box, and the map area reads "Map unavailable offline" above the directions link.

## Read-only document links

A document link (`backend/document_links.py`) opens one signed agreement's documents at `/documents#<token>`, read-only, for the people the roadmap's delivery step will email after signing (`docs/roadmap.md`, Phase 2). The server mints it with `document_links.mint(store, uid, auth_id, document_set)` as a user who holds the job's `sign` permission (the signing technician, or the owner or an estimator with access in workspaces mode). There is no API route or app action that creates one. For the signing-triggered homeowner email and recipient rules, see [Document delivery](company-workspaces.md#document-delivery). Each link is bound to one signed authorization and one document set: `homeowner` (the signed proposal with the saved signature, and the photo log with its photos) or `adjuster` (the itemized claim with its scope-code JSON, and the scope defense letter). The 256-bit token is returned once; Firestore keeps only its SHA-256 digest in `_document_links/{digest}` with the agreement, inspection, set, creating user, company and expiry, and `_document_link_agreements/{auth_id}` names the active link of each set, so minting a set again revokes its earlier link. `document_links.revoke(store, uid, auth_id, document_set=None)` revokes one set or every set. Links expire `LINK_SECONDS` after minting (30 days; the constant is the place to change it) and work for any number of views.

`GET /api/documents`, `GET /api/documents/photos/{photo_id}` and `GET /api/documents/signature` are anonymous like the signing-link routes and read only the `X-ADR-Document-Link` header; the token stays in the URL fragment. The view returns the set's documents with the other set's documents emptied (the adjuster's copy keeps only the customer, property and date of the proposal; for a company price table's `estimate`, see [Document links](pricing-source.md#documents-from-a-company-price-table-calculation-dryscope-v2)), never the estimator's AI notes or the owner's quantity notes, plus the receipt (reference, time, channel and, for a link signature, the signer's name and role). Photos and the signature are served only to the homeowner set. Every document, photo and signature read goes through `store.get` as the link's creator and rechecks that user's `sign` permission, so losing either job access or signing permission disables their links; the signed record is never changed. Unknown, tampered, expired, revoked and inaccessible links, and a signing-link token sent to these routes, all answer 404 "This document link is not available". Document-view requests count against a 60-per-minute per-link limit; all three routes count against the shared 120-per-minute per-address counter described under [homeowner signing links](#homeowner-signing-links). Tokens, digests, addresses, user agents and customer names never reach the log.

The page is `public/sign.html` and `sign.js` under the `/documents` rewrite, with the same `no-store`, `noindex` and `Permissions-Policy: tools=()` headers as `/sign`: the signing area stays off, only the set's tabs show and only its included documents print, and the adjuster's set offers **Download scope JSON**. It needs a connection; offline it shows the connection error and nothing is stored on the device. For physical deletion and retention, see [Firestore TTL policies](#firestore-ttl-policies).

## Cutover and historical data

The old `alert-disaster-live` site (in `mitigation-project`) was retired as of 2026-10-12: it no longer redirects and its addresses return HTTP 404. Use the dedicated app's address instead. The redirect configuration that was kept in `deployment/legacy-redirect` has been deleted; the earlier redirect deploy log was removed from the repository with the rest of `review-artifacts/` and remains in git history.

Other sites and databases in `mitigation-project` are unchanged. The old backend is retained for rollback and receives no calls from the migrated app. The reviewed old authorization endpoint only logged metadata and did not persist agreements, signatures or photos; there were no application records to copy. No unrelated records were copied.

## Deployment

Never use a blanket `firebase deploy`. Keep both `index.html` copies (the landing page) identical; the app shell is `public/app.html`, served at `/app`. Deploy indexes separately and verify they are READY before enabling paginated queries.

Deploy the backend only with `scripts/deploy_backend.py`. Cloud Run copies environment variables from the latest service template, which can be a staged revision with no traffic, so a raw `gcloud run deploy` can silently inherit `WORKSPACES_ENABLED`, `AI_FEATURES`, `PRICE_BOOKS_ENABLED` or `RETENTION_ENABLED` from that revision. The script requires `--workspaces on|off` and always sets `WORKSPACES_ENABLED`, `AI_FEATURES`, `PRICE_BOOKS_ENABLED` and `RETENTION_ENABLED`. The defaults are the repository baseline, today `AI_FEATURES=readiness`, price books off (`PRICE_BOOKS_ENABLED=false`) and record retention off (`RETENTION_ENABLED=false`); see [Turning a feature on or off](#turning-a-feature-on-or-off). `--ai-features` and `--price-books on|off` set one revision only, such as a staged 0% check, and are not how a feature is turned on. The script prints the baseline, always mounts the Maps key secret (`--update-secrets`, see [Address suggestions and the job map](#address-suggestions-and-the-job-map)), keeps the other existing variables (model settings, and the staff list unless `--staff-emails` sets it on purpose; it refuses, `--dry-run` included, when the flag is omitted and the service template has no `STAFF_EMAILS`), and stages a tagged revision with `--no-traffic`. Review the command with `--dry-run`, then rerun with `--yes`.

Every release is stamped with the commit it was built from. `deploy_backend.py` refuses uncommitted or untracked changes under `backend/` (`--allow-dirty` stamps `<commit>-dirty` instead), writes the commit to `backend/SOURCE_COMMIT` in the uploaded build context for the duration of the deploy, and sets the revision label `source-commit`. The image reports it as `source_commit` in `/api/health`; an image built without the script reports `unknown`. `gcloud run deploy` also copies the label onto the service, so the service-level `source-commit` follows the latest staged revision even while traffic stays on an older one or after a rollback; only the serving revision's label or `/api/health` identifies the code that is serving. Before a Hosting deploy, `python scripts/stamp_hosting.py` stamps the same kind of commit into the service-worker `VERSION`, every versioned asset URL and the Account menu's and footer's app version, which also gives each release a new worker cache. A production release also passes `--version <YYYY.MM.DD-N>` (from `python3 scripts/auto_deploy.py --next-version`) to both scripts: the backend reports it as `version` in `/api/health` and the app version shows it instead of the short commit. Both scripts refuse `--version` on a dirty tree; a build without it reports `version` `unknown` and shows its short commit. The committed shell carries the placeholder `unstamped`; `firebase.json` runs `node scripts/run_python.js scripts/stamp_hosting.py --check` as the Hosting predeploy hook (the launcher uses whichever of `python`, `python3` or `py` exists and blocks the deploy if none does), so an unstamped or inconsistently stamped shell, or one stamped with a commit other than HEAD or with Hosting changes not in that commit, is never deployed; a `-dirty` stamp declares such changes and is accepted as is. Restore the placeholder with `--reset` afterwards. Both scripts print a row to append to [RELEASES.md](../RELEASES.md), the only record of deployed state.

```powershell
firebase.cmd deploy --only firestore:indexes --project alert-disaster-field-2026
# Confirm the required indexes are READY before deploying the backend.
gcloud firestore indexes composite list --project=alert-disaster-field-2026
$VERSION = python scripts/auto_deploy.py --next-version
python scripts/deploy_backend.py --workspaces off --tag workspaces-off-YYYYMMDD --version $VERSION --dry-run
python scripts/deploy_backend.py --workspaces off --tag workspaces-off-YYYYMMDD --version $VERSION --yes
# The dry run prints the feature baseline. Defaults are the repository baseline, today AI_FEATURES=readiness and PRICE_BOOKS_ENABLED=false.
# Without --staff-emails the revision inherits the service template's STAFF_EMAILS; both commands refuse when
# that template has none. Then add --staff-emails <comma-separated staff emails> to both.
# A feature is turned on by a reviewed pull request that changes the baseline, not by flags on this command.
# Append the printed row to RELEASES.md. Before promotion, the tagged URL printed by the deploy must answer
# {"status":"healthy","schema_version":3,"version":"<the release version>","source_commit":"<the stamped commit>"}.
curl.exe -s <tagged-revision-url>/api/health
# Configuration, including the chosen flag ("workspaces_enabled":false for --workspaces off), is staff-only at
# /api/health/details; `node scripts/verify_live_browser.js --backend-tag <tag>` prints it after normal staff sign-in.
gcloud run services update-traffic alert-disaster-field-estimator --to-tags=workspaces-off-YYYYMMDD=100 --region=us-west2 --project=alert-disaster-field-2026 --billing-project=alert-disaster-field-2026
# Append a "100% (promoted)" row for the backend to RELEASES.md.
firebase.cmd deploy --only firestore:rules --project alert-disaster-field-2026
firebase.cmd deploy --only auth --project alert-disaster-field-2026
python scripts/stamp_hosting.py --version $VERSION
firebase.cmd deploy --only hosting:alert-disaster --project alert-disaster-field-2026
# Compare the deployed shell and backend commits, append the printed Hosting row to RELEASES.md, then reset.
node scripts/verify_hosting.js
python scripts/stamp_hosting.py --reset
# Create the tag and GitHub Release so this version can be chosen for a rollback (needs gh signed in).
python scripts/auto_deploy.py --publish "$(git rev-parse HEAD)"
```

The backend rejects a different project ID or evidence bucket. Production never enables local demo fallbacks.

### Automatic deploys

`.github/workflows/deploy.yml` releases a master commit after its CI run succeeds on a push to master.
It runs `scripts/auto_deploy.py`, which computes the next UTC date-style version (`YYYY.MM.DD-N`, starting at `1` each day) and uses the manual path: `deploy_backend.py --workspaces on
--ai-features <repository baseline> --price-books <repository baseline> --staff-emails <serving value> --version <YYYY.MM.DD-N>` stages a tagged 0% revision (the tag is `a<7-character commit prefix>-<run id digits>`, trimmed so tag plus service name stays within Cloud Run's 46 characters);
the staged revision's environment, secret bindings, service account and limits must equal the serving
revision's apart from the three baseline flags; the service must also keep one minimum instance
(`MIN_INSTANCES` in `deploy_backend.py`, set as the service-level `--min=1`, not the per-revision
`--min-instances`), checked on the service after staging; the tagged URL must report healthy, schema 3, the release `version` and the
stamped commit and answer the signed-out requests listed in `REFUSED_GET` and `REFUSED_POST` with 401;
only then does traffic move. Next it stamps the shell with `--version <YYYY.MM.DD-N>`, deploys only `hosting:alert-disaster`, runs
`verify_hosting.js` and resets the stamp. Only after verification succeeds, a separate workflow step (the only one holding a GitHub write token) creates the immutable git tag for the version the live backend reports and a GitHub Release whose notes list the merged pull requests in plain words. A failure before promotion promotes nothing and creates no tag. A failure after
it restores traffic to the revision that was serving, clones the previous Hosting version back to the
live channel and fails the run without creating a tag. One release runs at a time (`concurrency: production-deploy`).

It stops with a message, and the owner releases that commit by hand, when:

- `firestore.rules` or `firestore.indexes.json` changed since the serving commit. The workflow never
  deploys rules, indexes or TTL policies. After releasing them by hand (and confirming the indexes are
  READY), release the commit by hand too; later merges deploy automatically again.
- The serving revision's `source-commit` label is not a clean commit in this history, or traffic is not
  100% on one revision.
- A Firestore TTL policy is missing (`scripts/ensure_firestore_ttls.py`, read-only).
- The serving revision has no non-empty, valid `STAFF_EMAILS`. The check runs before anything is staged;
  set the variable on the service by hand, then rerun.
- The repository baseline would turn off a feature the serving revision has on. The check runs before
  anything is staged and names the setting; see
  [Turning a feature on or off](#turning-a-feature-on-or-off).

A commit that is already serving, or older than what is serving, is skipped without error, so a manual
release made in parallel is never overwritten. So is a commit whose changes since the serving commit touch
no file the legacy app is built from: `backend/`, `public/`, the root `index.html`, `firebase.json`,
`.firebaserc`, `firestore.rules`, `firestore.indexes.json`, the root `package.json` and lockfile, and the
release scripts listed in `LEGACY_FILES` (`scripts/auto_deploy_helpers.py`). A DryScope rebuild merge
(`web/`, `infra/`, docs, tests, workflows) therefore exits cleanly with the logged reason `No file the
legacy app is built from changed ...` and deploys nothing; the next merge that does change a listed file
releases everything merged since. A check-only run still runs every refusal check and notes that a real run
would skip. The rules and index check above runs first, so a rules or index change still stops for a hand
release. Add a path to the list if the legacy build or release starts reading it. Each run's job summary is the release record; see
[RELEASES.md](../RELEASES.md). Stale tags accumulate on old revisions at 0% traffic; Cloud Run
allows 1000 tags per service, so clear old ones occasionally with `gcloud run services update-traffic
--remove-tags`.

**Warm instance.** One minimum instance removes the Python cold start (about 5 to 8 seconds) when scaling up from zero after an idle spell or a deploy; a second concurrent instance (up to `--max-instances=2`) still starts cold. The service-level minimum follows the traffic split, so tagged revisions at 0% keep no warm instance of their own and the service keeps exactly one; a per-revision minimum would bill one more instance for every tagged revision. It takes effect when staging runs, warming the serving revision until promotion. The minimum is held to the repository value, not to the service before staging, so the first release that adds it is recorded as a baseline change instead of stopping. One always-on instance costs about $7 to $10 a month.

**Owner setup, once.** Nothing below is done by the repository or its agents.

1. Review, then run, with `gcloud` signed in as a project owner:
   ```bash
   scripts/setup_auto_deploy.sh --dry-run   # prints each change
   scripts/setup_auto_deploy.sh
   ```
   It enables the IAM Credentials and STS APIs; creates the `adr-deployer` service account (no keys), a
   Workload Identity pool and an OIDC provider whose condition admits only repository
   `nnorman100/adr-field-estimator`, ref `refs/heads/master` and the `deploy.yml` workflow; lets that
   repository impersonate the account; and grants it `run.developer`, `cloudbuild.builds.editor`,
   `logging.viewer`, `serviceusage.serviceUsageConsumer`, `firebasehosting.admin`, `firebase.viewer` and
   `datastore.viewer` on the project, `serviceAccountUser` on `adr-runtime` and `adr-builder` only, and
   write access to the Cloud Run source bucket and Artifact Registry repository only. It cannot edit
   Firestore rules, indexes or TTLs, IAM, or any other project.
2. Set the two repository variables the script prints, `GCP_WORKLOAD_IDENTITY_PROVIDER` and
   `GCP_DEPLOY_SERVICE_ACCOUNT`, and `AUTO_DEPLOY_ENABLED=true`.
3. Run **Deploy** once from the Actions tab (`workflow_dispatch`, `version` left blank). It runs only the refusal checks
   (`--check-only`) and proves authentication, the roles for reading the service and the TTL check,
   without staging or deploying.
4. The first real release is the next merge. The roles for source builds and Hosting were derived from
   reading the scripts, not from a live run; a missing permission fails the run before promotion. Watch
   the first run and add only what its error names.

Set `AUTO_DEPLOY_ENABLED` to anything but `true` to pause automatic deploys; manual releases are
unaffected.

### Turning a feature on or off

The production baseline is three repository constants in `scripts/deploy_backend.py`: `DEFAULT_PRICE_BOOKS` sets `PRICE_BOOKS_ENABLED`, `DEFAULT_RETENTION` sets `RETENTION_ENABLED` (the daily record-retention deletion, [Record retention](company-workspaces.md#record-retention)) and `DEFAULT_AI_FEATURES` sets `AI_FEATURES`. Today they are off, off and `readiness`. Every automatic release stages with them and a hand `deploy_backend.py` run defaults to them.

- **Turning a feature on is one reviewed pull request.** Rated High, it changes the constant (for `AI_FEATURES`, add the name and keep the ones already on), the tests that pin today's values (`BASELINE` and the staged values in `tests/test_auto_deploy.py`, the default baseline in `tests/test_deploy_backend.py`) and `docs/STATUS.md`. Do any rules, index or data step the feature needs first. Merging it with the owner's go is the release: the automatic deploy stages the new baseline, and every later merge stages the same one, so no later merge can undo it. A commit with a rules or index change still stops for a hand release, which uses the same constants.
- **Turning a feature off is a reviewed pull request plus one confirmation.** The pull request changes the constant back. The automatic deploy then refuses that commit, as below, because the refusal cannot tell a deliberate change from a mistake. Release it by hand with `python3 scripts/auto_deploy.py --commit <commit> --confirm-baseline`, then `--publish <commit>` and append the rows to [RELEASES.md](../RELEASES.md). Later merges deploy automatically again.
- **`--ai-features`, `--price-books` and `--retention` are not how a feature is turned on.** They set one revision only, such as a staged 0% check. If one is promoted, the next automatic release refuses until the constant matches or the owner confirms.

**The refusal.** Before anything is staged, including on a check-only run, `scripts/auto_deploy.py` compares the serving revision with the repository baseline the way the server reads them: price books are on only for the value `true` in any case, `AI_FEATURES` is a set of names, and an unset flag is off. If the baseline would turn off anything now serving, the run fails and names the setting (`PRICE_BOOKS_ENABLED: serving 'true', repository baseline 'false'`). `--confirm-baseline` is accepted only on a hand run or a rollback dispatch; the automatic run never passes it. A baseline that adds to what is serving is not blocked, and is recorded as a `Baseline change` line in the job summary.

### Firestore TTL policies

Five collection groups carry an `expire_at` Firestore TTL field. Each expiry is also enforced in code on every use, so a record that has not been deleted yet is already refused; deletion only trims the leftovers. Firestore deletes asynchronously, typically within about a day of the time (not at it), and a policy is per collection group in the `(default)` database.

| Collection group | Documents that carry `expire_at` | Value | Why deleting at that time is safe |
| --- | --- | --- | --- |
| `_live_resume` | the Live checkpoint per technician | 600 s after the last update | The checkpoint is refused after its `expires`; Stop/Finish deletes it anyway. |
| `_signing_links` | every signing link | the link's expiry (7 days after creation), moved to 30 days after signing | The link is refused at `expires`, and for a signed link after the 30-day view window. A deleted link reads as unknown (404), and the job's pointer to it reads as `none`, so a new link can still be made. The signed agreement is a separate record. |
| `_limits` | only per-address counters (`ip-<HMAC>`) | 1 hour after the address's last request | Every counter window is a minute, so an hour-idle counter holds nothing a limit needs. Per-user counters (AI, places, link creation) never set the field. |
| `_document_links` | every document link | 30 days after creation, the link's expiry | A deleted link reads as unknown (404) and its pointer as `none`; the signed agreement is untouched. |
| `_job_insights` | internal, regenerable job summaries | 30 days after generation | Expired summaries are ignored on reads even before TTL deletion. A missing cache is regenerated against current authorized facts; inspections and signed agreements are separate and unchanged. |

A new collection group, or a new document in one of these groups, that sets `expire_at` needs the same review before its policy is enabled. Company price-book previews expire in code on the field `expires` and are not a new TTL group.

`scripts/ensure_firestore_ttls.py` is the one owner-run step for all five policies. It always targets `alert-disaster-field-2026` and needs `gcloud` signed in with a Firestore admin role (`datastore.indexAdmin` or owner); the runtime service account does not hold one and this step grants no IAM.

```powershell
# Read-only: prints match or missing per policy; exits 1 if any is missing (2 if gcloud failed).
python scripts/ensure_firestore_ttls.py
# Owner-run, once per project: enables only the missing policies. A re-run changes nothing.
python scripts/ensure_firestore_ttls.py --apply
```

A new policy reports `CREATING` while Firestore backfills, then `ACTIVE`; the script counts both as in place. Run the read-only check in every release before promoting a backend (see [RELEASES.md](../RELEASES.md)) and `--apply` only when it reports `missing`. Do not enable a policy by hand with `gcloud firestore fields ttls update`.

## Verification and review scope

Local tests cover pricing, documents, ownership, retries, authentication, bounded uploads, failures, revision conflicts, Live formats and teardown. Chromium/WebKit tests exercise the real UI with synthetic adapters. Release verification uses scripts/verify_live_browser.js with normal staff sign-in and makes no IAM changes. Each verifier takes the dedicated backend URL as a required argument and has no default target. The historical `verify_migration.py`, `verify_repairs.py` and `verify_review_fixes.py` probes, which minted synthetic custom tokens through a signing grant, were removed; their shared helpers now live in `scripts/verify_common.py`.

The [original review](https://chatgpt.com/space/page_4a5293fc2ec481918bd32e5c78fb2dca) remains the baseline. Current repair status and device acceptance are in `docs/review-repairs.md`.

## Rollback

To roll back to a previous `YYYY.MM.DD-N` release version in one step:

- **GitHub Actions**: run **Deploy** (`workflow_dispatch` with `version` set to the target `YYYY.MM.DD-N`). This needs `AUTO_DEPLOY_ENABLED` set to `true`.
- **Single operator command**: `git fetch --tags`, then `python3 scripts/auto_deploy.py --rollback <YYYY.MM.DD-N>`. Use this while automatic deploys are paused, and append rows to [RELEASES.md](../RELEASES.md) as for any manual release.

The rollback resolves the version tag and checks the Firestore `_migrations` ledger (#184) for any applied data migrations newer than the target version. When it finds one, or cannot read the ledger, it emits a `::warning::` banner and job-summary warning and stops before staging, because rolling back code does not undo Firestore data changes; `--confirm-past-migration` (workflow input `confirm_past_migration` set to `yes`) goes ahead anyway. A change to `firestore.rules` or `firestore.indexes.json` between the target and what is serving warns and stops the same way, with the same confirmation: a rollback does not roll them back, so they stay at the newer hand-released version, and the next automatic release stops for a hand release. It then redeploys that tag's backend and Hosting through the same staged checks and `verify_hosting.js` verification. Afterwards, pause automatic deploys (`AUTO_DEPLOY_ENABLED`) or revert the bad change before the next merge, otherwise the next release brings it back.

A rollback restores code, not the baseline. It stages the target's code with the baseline of the checkout running it, which on the **Deploy** workflow is the commit it runs from, normally `master`. When that baseline would turn off a feature now serving it stops before staging, and `--confirm-baseline` (workflow input `confirm_baseline` set to `yes`) goes ahead; both refusals are reported together when a migration or rules warning also applies. The target's own deploy script runs the stage, so a target that does not know a name in `AI_FEATURES` stops before staging with `unknown AI feature` (`estimate_assist` is unknown before `2026.11.04-2`); use the traffic restore below for one of those. The automatic rollback after a failed release is separate: it moves traffic back to the revision that was serving, flags included, and stages nothing, so this check never stops it.

The previous dedicated backend revisions also remain available for manual traffic restoration. Restore traffic only with an explicit dedicated project/region and the matching Firebase Hosting release; do not pair the old backend with the new schema-3 frontend. No stored data is deleted on rollback. A revision from before address suggestions rejects a draft that holds `coordinates` (its contract forbids unknown fields), so fix forward rather than roll back once technicians have chosen suggestions. The historical shared project is not a repair rollback target.

[Firebase Hosting timeout documentation](https://firebase.google.com/docs/hosting/serverless-overview), [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets), [Live API formats](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api).


## Live protocol 2 checkpoints

The repository pins google-genai==2.33.0 in `backend/requirements.txt`. The serving revision's pin is the one in the commit `RELEASES.md` records, not this sentence. Live wire messages are still checked against the earlier tested 2.8.0
baseline in mock tests (tests/test_live_reliability.py), LIVE_VOICE (default Charon),
64,000-token compression trigger and 32,000-token target. No model/region change is introduced.
Session handles stay in private _live_resume documents keyed by owner UID and bound to the
inspection, capture ID, lease and scope fingerprint (excluding transcript/capture metadata and
confirmation-state updates). Application expiry is 600 seconds after disconnection; provider
retention/resumption guarantees are separate. For checkpoint retention and physical deletion, see
[Firestore TTL policies](#firestore-ttl-policies). Stop/Finish deletes its matching checkpoint. The protocol-2 finished acknowledgement follows the final-transcript drain (at most 3 seconds) and precedes lease/checkpoint cleanup, because the client stops waiting 3.5 seconds after End. Only audio above a speech-level RMS threshold arms that drain; open-microphone silence does not. `gemini-3.8-live` never sets a transcription's `finished` flag, so a model reply that began after the last speech packet and completed without interruption also ends the drain; a reply the technician talked over does not, and the `turn_complete` closing an interrupted reply neither ends the drain nor counts as another turn. The client closes the assistant segment on `interrupted` and both speakers' segments on `turn_complete`, except that the `turn_complete` closing an interrupted reply closes only the assistant segment. The `Live session ended` log event adds content-free counters: microphone seconds, longest microphone gap, video frames, turns, interruptions, model audio seconds, reply latency (median and maximum, from the last received speech to the first reply audio), reply delivery pace, and the client's gap and video-pause counts.

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

## Estimate assist rollout

`AI_FEATURES=estimate_assist` turns on the user-facing parts of [Estimate assist](estimate-assist.md). It needs no rules or data change. Turning it on is a separate owner decision, made in one reviewed pull request that adds it to `DEFAULT_AI_FEATURES` and keeps the features already on; see [Turning a feature on or off](#turning-a-feature-on-or-off). Turning it off hides the suggestions and the close card. Counts already applied stay on their jobs, and recorded closes stay in the company's history.

**Index step for the job-close release.** Every signature writes a row to `_estimate_history/{company_id}`, flag on or off, so deploy the `rows` field override in `firestore.indexes.json` before the backend that carries it, and verify it:

```bash
firebase deploy --only firestore:indexes --project alert-disaster-field-2026
```

The override keeps the map of rows out of Firestore's automatic single-field indexes. Without it signing still works, but each row's fields are indexed for nothing. Deny-all rules already cover the collection, so no rules deploy is needed.

## Drying watch rollout

Deploy the `_job_monitoring` indexes in `firestore.indexes.json` separately
and verify them before enabling the feature:

```bash
firebase deploy --only firestore:indexes --project alert-disaster-field-2026
```

No rules or TTL policy change is needed. See [Drying watch](drying-watch.md)
for feature and owner switches, quotas, retention, preview/backfill behavior
and evaluation prerequisites.
