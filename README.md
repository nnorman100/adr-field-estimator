# DryScope

A mobile inspection app serving Alert Disaster Restoration first, and other restoration companies as isolated company workspaces. Open [the dedicated app](https://alert-disaster-field-2026.web.app) and sign in with Google or a verified, invited email/password account.

Hosting, Firebase Authentication, Firestore, Cloud Run, private evidence storage and Vertex AI belong to `alert-disaster-field-2026`. The historical `alert-disaster-live` site was retired as of 2026-10-12; use this app's address. Peer sites and shared databases remain untouched. See [infrastructure and deployment](docs/firebase-isolation.md) and [repair acceptance evidence](docs/review-repairs.md).

## Company dashboards

The new build adds isolated company workspaces with superadmin, owner, estimator and office roles. Owners manage their company and team; estimators see jobs they create or are assigned; office staff coordinate jobs and view documents. Google or verified email/password sign-in uses private server-checked memberships. Password accounts are created only by invitation: the invitation email carries a link to set the password. Public sign-up is disabled in the Firebase project and must stay disabled. Invitations require explicit acceptance by a verified account with the matching email. The initial ADR owner also has a separate superadmin role.

Company workspaces are enabled in production since October 15, 2026; the serving backend and Hosting release are recorded in [RELEASES.md](RELEASES.md). Invitations are sent by Gmail SMTP. See [workspace permissions, migration and release checks](docs/company-workspaces.md). The new dashboard does not create a blank inspection at sign-in. Company identity is saved with documents; workbook pricing remains shared and unchanged.

## Inspection workflow

Use the persistent **1. Walk & Photo / 2. Check Scope / 3. Review & Sign** step bar to move between tasks. A new job opens on Walk & Photo; Check Scope is one tap away for desk estimates. **Jobs** opens drafts and signed agreements; **Account** contains sign-out and company contact details. On a phone with a job open, one navy header row shows **← Jobs**, the job title with a short save status (**Saved**, **Saving…**, **Offline · saved on phone**, **Signed**) and **More**, which holds the job actions, Job coordination, Help and Account. Owners and estimators start jobs from **+ New job** at the top of the dashboard. The **?** (Help) button beside **Account** opens short how-tos that work offline: topics for the signed-in role come first, followed by getting started, other roles' topics and the company contact. Role only orders the text; it shows no job data or controls. Drafts save automatically (status under the job title; hover it for the revision or authorization ID); **Jobs → Save draft** (**More → Save draft** on a phone) saves on demand. On Walk & Photo and Check Scope the bottom bar offers **Finish & review**, or **Fill scope from walkthrough** on Walk & Photo while unconfirmed walkthrough notes, transcript or a running Live session exist. The bar is hidden on Review & Sign, where the signing area stays below whichever document is open, and on signed jobs. Scope confirmation is required before document generation.

1. Enter the address, confirmed year built, rooms, measured demolition areas, water categories, waste, cabinetry, equipment, drying days and additional labor. Add applicable Matterport, dump-truck, decontamination, power-distribution and wood-floor drying charges from the sheet. Describe crawl spaces, countertops, water heaters and similar job conditions in the notes or walkthrough. Documents describe the work as proposed.
2. On **Walk & Photo**, tap a room chip to choose the current room (tap the selected chip to rename it, or **+ Room** to add one) and start the camera/microphone for real Gemini Live coaching. The Cloud Run relay authenticates the Firebase user and checks inspection ownership before connecting with server ADC. It sends 16 kHz mono PCM and an aspect-preserving 640 px JPEG every 2 s; responses play at 24 kHz after a short cushion. On a weak connection the camera feed pauses automatically so voice keeps flowing, and the Live status says so. Technician and assistant transcripts remain separate. Active sessions reveal Stop/Mute controls; optional color emulation and the transcript are under **More walkthrough options**; the emulation is explicitly labeled and does not produce thermal evidence. When reception is too poor for Live, use **Offline notes** (see [Offline notes for bad reception](#offline-notes-for-bad-reception--deployed-acceptance-pending)).
3. **Capture photo** takes a still while Live runs and opens the camera or file chooser otherwise; **Upload file** adds an existing photo. The photo strip under the button, and each room card on Check Scope, show every photo with its room, capture time, dimensions and recognition badge; a room menu on the card moves a photo to another room of the unsigned draft. Originals are retained privately. Pending, failed and non-meter OCR remain unverified. Recognition can be retried.
4. Confirm every pricing input and select **Finish & review**. Capture stops. The server reads the saved revision and evidence, validates AI output, applies deterministic pricing and mandatory ADR wording, and produces four documents. Provider failures show a retry error and cannot create a signable fallback.
5. Review the proposal's low–high estimate range and itemized scope total; in the app only the proposal must be opened before the technician signs, while the itemized claim, scope defense letter and photo log remain available as supporting documents. AI summary and suggestion notes appear in an estimator-only **AI review notes** callout above the document tabs, never in the customer proposal. Unpriced work, pending recognition or missing company settings block signing; the message names each item and where to fix it. Edits invalidate the audit and signature; selecting **Finish & review** again without changes returns the saved audit. Draw a signature and confirm document review; success is shown only after a durable server receipt. To let the homeowner sign on their own phone instead, choose **Send to homeowner**: the app shows a QR code, a copyable link and (where the phone supports it) the share sheet. The homeowner opens the link with no account, opens all four documents (signing unlocks only after each is opened, matching the consent statement), types their name, chooses owner or authorized representative, checks two confirmations and draws a signature. The link works once, expires after 7 days, can be revoked, and stops working as soon as anything in the inspection changes. While it is outstanding, the **Review & Sign** step checks every 10 seconds and switches to the signed agreement when the homeowner signs. After signing, the homeowner can reopen the link for 30 days to view or print the signed copy. The server sends no email or text.
6. Open **Jobs → Drafts & signed jobs** to recover a draft or restore the immutable signed agreement, all four documents, signature and evidence. Recent records appear first; use **Load older drafts** or **Load older signed jobs** for additional pages. A confirmed agreement stays saved if evidence display fails; **Retry loading saved evidence** reloads its display without signing again. **Export** contains JSON copy/download and printing. Mobile claims use readable line-item cards; desktop and printed claims retain the table. Export uses ADR internal codes without ESX compatibility claims. Saving does not dispatch technicians or send email.

## Pricing and evidence

`backend/claims.py` calculates money with Decimal and cent rounding. The populated default job charges total $1,180.20 and appear exactly once. Rates and the estimate-range formulas are traced to the user-supplied workbook in [pricing source notes](docs/pricing-source.md). Three fans and one dehumidifier for three days cost $567.00. Waste increases applicable demolition item totals. Added labor uses the workbook's $47.46/hr formula even for an after-hours loss, as confirmed by the user; after-hours estimates add $200 in job charges and apply the sheet's labor/material factor.

The customer proposal shows the sheet-derived low–high estimate, with itemized base-rate charges shown separately as its calculation detail. ADR package tiers are not in the supplied sheet and are no longer accepted for new audits. Models cannot supply prices, override totals or remove conditional clauses. AI summaries and suggestions are labeled for technician review; suggestions do not become observed evidence or authorized work.

## Private drafts and updates

Changes autosave to a user-specific IndexedDB queue and synchronize to Firestore when online. Photos upload individually. Reopening a draft merges evidence added on other devices and stores downloaded originals privately on this device for offline recovery and conflict copies. If an original cannot be fetched, retry online before copying that draft. Offline drafts can be edited; AI and signing require connectivity. Conflicts return 409 and preserve local work until the user restores the saved revision or creates a separate inspection. Logout stops resources and clears local drafts once they have synced. If any draft has not synced, or a job still has an offline voice note waiting to reach its transcript, sign-out stops and offers **Discard unsynced work and sign out**. Voice notes the server could not process are kept only on the phone; sign-out says so before removing them. Retained cloud drafts and agreements are not automatically deleted.

The worker caches versioned app assets and public Firebase initialization configuration. Authenticated APIs and evidence are excluded. Navigation is network-first, and the app shell is served with `Cache-Control: no-store` so a browser refresh can pick up a release. The app checks for updates when brought to the foreground and prompts before activation, preserving drafts. The **Account** menu shows the installed app version, the start of the source commit stamped at release. If an older screen persists, save the draft, open [the current field app with a fresh URL](https://alert-disaster-field-2026.web.app/?v=ui-20261006-6), and use **Save & update** if prompted. `alertdisaster.com` is the separate public company website and is not this field app. Physical iPhone offline launch, Bluetooth routing, interruption and conversational latency remain acceptance checks until the guided device test passes.

## Branding

Every page starts with a navy header bar carrying the white DryScope lockup and, in the app, the Help and Account controls. Pre-sign-in screens show nothing else of a company. Once signed in, the white strip under the bar, the Account menu and documents take the company name, logo and contact details from the company profile (see [docs/company-workspaces.md](docs/company-workspaces.md)); DryScope then appears only in the bar, beside the app version in Account and in the footer's "Powered by DryScope" line. Room cards and the on-screen review are tagged WATER, MOLD or both from each room's Loss type (chosen beside the water category and filled from the walkthrough's "water, mold, or both" answer; pricing keeps reading the category) in the water-blue and mold-green tints; printed documents carry words only, and green never means success. Until ADR's profile stores a logo, ADR alone falls back to the bundled ADR logo. The interface uses DryScope's navy `#0B2545` palette (tokens in `public/app.css`); success states use a navy check mark, never green. Interface text uses Lato and document text a serif face. EB Garamond supplies the document face as an openly licensed alternative to the site's commercial Garamond Premier Pro. Logo and fonts are hosted locally and included in the offline asset cache; font licenses are in `public/fonts/`. The live site supplied the primary phone `(661) 426-2151`, Bakersfield office address and service locations, verified October 6, 2026.

The DryScope logo is a water droplet and spore cluster inside an eight-tick moisture-meter ring, in navy `#0B2545`, water blue `#7CC4E8` and mold green `#9ED8A8`. It fills the app icons (`public/icon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`), the header bar of the app and the homeowner signing page, and invitation emails for companies other than ADR without a logo (`backend/brand/dryscope-logo.png`). `public/brand/dryscope-*.svg` holds the full-colour, reverse, navy and white versions of the mark and wordmark. A company's own logo always replaces it.

Provenance: the concept was generated on 2026-10-17 by an AI image model (Antigravity's built-in image generator, which did not report its underlying model or version) from a written prompt, then redrawn as vector geometry by an AI coding agent the same day: chosen circles, tick coordinates and droplet curves written directly as SVG, not an automatic trace or another generated image. Every shape is a filled outline with no strokes, embedded rasters or live text. The lettering is Noto Sans Display Condensed ExtraBold converted to outlines; Noto is © Google and licensed under the SIL Open Font License 1.1, and no font file ships. This records how the logo was made; it is not trademark clearance.

## Code and verification

| Location | Responsibility |
| --- | --- |
| `public/app.js`, `core.js`, `audio-worklet.js` | Lifecycle, safe DOM, offline recovery, camera and audio |
| `public/documents.js` | The four documents, rendered with text nodes for both the app and the homeowner page |
| `public/sign.html`, `sign.js` | Homeowner signing page reached through a signing link; no sign-in |
| `public/app.css`, `sw.js` | Responsive/print layout and app updates |
| `index.html`, `public/index.html` | Identical root and hosting HTML |
| `backend/contracts.py`, `claims.py` | Typed contracts, rates and four documents |
| `backend/inspection_store.py`, `job_store.py` | Revision transactions, owner checks, private evidence, retries and quotas |
| `backend/main.py` | Authenticated REST, homeowner signing-link routes and Live relay |
| `backend/signing_links.py` | Single-use signing-link tokens (stored as digests), limits and QR codes |
| `tests/` | Synthetic behavioral tests; browser harness never ships |
| `scripts/verify_live_release.py`, `verify_live_browser.js` | Real dedicated infrastructure acceptance with normal staff sign-in and scoped synthetic cleanup |
| `scripts/deploy_backend.py`, `stamp_hosting.py`, `RELEASES.md` | Source-commit stamping of each release and the release log |
| `tests/fixtures/` | Small synthetic inputs shared by tests and release verifiers (for example the 16 kHz Live prompt) |

### Release-helper environment

The scripts under `scripts/` run on Linux, macOS and Windows and resolve tools from the environment instead of fixed paths:

| Variable | Used by | Resolution when unset |
| --- | --- | --- |
| `ADR_GCLOUD` | `verify_live_release.py`, `record_live_release.py` | `gcloud` on `PATH` (including `gcloud.cmd` on Windows) |
| `ADR_TEST_PYTHON` | `verify_live_browser.js` | `.venv` in the repository, then `python3` (`python` on Windows) |
| `ADR_CHROME_PATH` | `manual_chrome.js` (used by `verify_live_browser.js`) | Platform install locations, then `google-chrome`/`chromium` on `PATH` |

From WSL2, `PATH` may resolve `gcloud` to the Windows SDK's shell wrapper, which takes roughly 30 seconds per call through Windows interop; point `ADR_GCLOUD` at a native Linux gcloud for a fast check. `verify_live_release.py` caches the access token until two minutes before gcloud says it expires (at most 45 minutes) and reads the Live checkpoint off the socket's event loop, so a slow lookup can no longer miss the relay's keepalive pings (uvicorn closes with 1011 "keepalive ping timeout" after 20 s + 20 s).

When gcloud or Chrome cannot be found, the helper stops with a message naming its variable. The release helper bridges the app's Live socket with Node's built-in WebSocket client, so run it with Node 22 or newer. Review evidence (screenshots, traces, logs) is local only: keep it in the gitignored `review-artifacts/` directory, and attach archives to a GitHub Release rather than committing them.

```powershell
python -m pip install --require-hashes -r backend/requirements.txt -r backend/requirements-dev.txt
python -m pytest tests -q -p no:cacheprovider
npm ci
npm test
npx playwright install chromium webkit
npm run test:browser
python -m ruff format . ; python -m ruff check .   # Python format and lint
npm run format ; npm run lint                      # JavaScript/CSS format and lint (npm run format:check in CI)
```

Direct Python dependencies live in `backend/requirements.in` (runtime) and `backend/requirements-dev.in` (tests and lint). The hash-locked `requirements.txt` and `requirements-dev.txt` beside them are generated for Python 3.11 and used by Docker, CI and local installs. After editing an `.in` file, regenerate both locks from `backend/` with [uv](https://docs.astral.sh/uv/):

```powershell
uv pip compile requirements.in --universal --python-version 3.11 --generate-hashes --output-file requirements.txt
uv pip compile requirements-dev.in --universal --python-version 3.11 --generate-hashes --output-file requirements-dev.txt
```

Dependabot opens weekly grouped update pull requests for these locks, npm, GitHub Actions and the Docker base image.

CI runs the Python jobs on the version in the `backend/Dockerfile` base image (`scripts/ci_python_version.py`), so a Dependabot base-image bump is tested on that version. The `audit` job runs `pip-audit` against both hash-locked files and `npm audit --audit-level=high`, and fails on known vulnerabilities. For a false positive or an advisory with no fix, add `--ignore-vuln <ID>` to the `pip-audit` step in `.github/workflows/ci.yml` (for npm, pin a patched version through `overrides` in `package.json`, or lower the failing level in the workflow only as a last resort) with a comment giving the reason and date, and remove it once a fix ships. `tests/test_ci_config.py` fails if `firestore.rules` stops denying all client access. Enable Dependabot security alerts in the GitHub repository settings (Settings > Advanced Security) so advisories also open pull requests between scans.

`tests/test_firestore_emulator.py` runs the quota, Live lease and signing transactions of the real store classes against the Firestore emulator, with concurrent callers standing in for separate Cloud Run instances. It is skipped unless `FIRESTORE_EMULATOR_HOST` is set; the `firestore-emulator` CI job runs it. Locally, with Java 21 or later:

```powershell
npx firebase-tools emulators:exec --only firestore --project demo-adr-emulator "python -m pytest tests/test_firestore_emulator.py -q -p no:cacheprovider"
```

The `demo-` project ID keeps the emulator and client offline; never point these tests at a real project.

The browser suite serves production code with fake cloud adapters over temporary local TLS. Local AI failures and unsafe text are deliberate synthetic fixtures. Real service checks are recorded separately. Windows Playwright WebKit offline service-worker navigation fails internally; this does not establish iPhone Safari behavior.

Use [the operating guide](docs/firebase-isolation.md) for production deployment and rollback. Never run a blanket Firebase deploy. Deploy the compatible backend first, then only `hosting:alert-disaster` in the dedicated project.

## Offline notes for bad reception — deployed, acceptance pending

Live stays the default walkthrough. **Offline notes** is a record-now, process-later option for basements, crawlspaces and large buildings where Live cannot hold a connection:

- When Live has shown the weak-signal status, or has been disconnected, for 25 seconds, the Walkthrough panel offers **Switch to offline notes**. It never switches by itself; **Not now** keeps Live and the offer returns only after the signal has recovered and weakened again. The app also offers the switch when the phone goes offline or Live cannot reconnect, and **Offline notes** starts the mode manually at any time. Switching stops Live with its transcript kept, and **Back to live assistant** resumes it once online.
- **Record voice note** saves audio on the phone (MP4/AAC in iPhone Safari and the Home Screen app, WebM or Ogg Opus elsewhere) every few seconds while recording, so a reload, crash or lost signal keeps what was captured. A note is limited to 10 minutes. Each note is tagged with the **Current room** chip. Photos use **Upload file** with the same room and the existing photo upload queue. **Add typed note** adds a room-tagged line to the technician notes.
- Once online, each voice note uploads, including notes for jobs that are not open; the background queue retries every minute on a weak connection. The server checks the same company and job permissions as other scope changes (owners and the job's estimators; office staff and superadmin support access cannot), sends the audio to the configured audit model for a verbatim transcript and appends it to the technician transcript as `[Offline voice note … · room · recorded … · transcribed later]`. The server does not store the audio. Retrying a note never adds it twice.
- After notes are added to the open job, **Fill scope from walkthrough** runs as before: the filled values still need review and scope confirmation. When it could not run (Live was on, or the notes were transcribed while the job was closed), Walk & Photo and Check Scope show a one-tap **N voice notes transcribed - Fill scope and check for missing items** prompt. Its panel now also lists what is still missing (no address, year built, measured area or photo for a room, or drying equipment) beside the model's clarification questions, so the technician can fill gaps before leaving the site.
- The Walkthrough panel shows each note's status (saved on this phone, waiting to upload, uploading and transcribing, added to the transcript, or why the upload failed; failed uploads retry every minute) and how many voice notes and photos are still waiting to upload. A note the server refuses for good is marked as not processed and stops retrying; **Remove** deletes it once the technician has typed its key facts. **Play** replays a note on the phone. The phone keeps each note beside the job's local draft and removes it with that draft.

Physical iPhone recording, screen lock during a recording, Bluetooth microphones and real reception loss remain open until observed on a device; see [the guided iPhone acceptance](docs/review-repairs.md#guided-iphone-acceptance--open).

## Voice-driven scope entry and Live reliability — deployed, acceptance pending

The current source adds **Fill scope from walkthrough** in Walk & Photo and Check Scope. Describe explicit room names, whether each room is water, mold or both with its water category (mold, alone or with water, maps to category 3), measured demolition areas in square feet, and job-total equipment counts/days. Requesting fill stops capture, saves the draft, and uses the configured audit model to extract values from technician transcript/notes. Assistant guidance is excluded. Values backed by a matching technician quote are filled into the form after speaking, rather than mutating the form on each Live turn.

The **Scope from walkthrough** summary opens at the top of Check Scope with the clarification questions and missing items; the filled values and their technician quotes are listed under **Filled values & source statements**. Each changed field is marked **From walkthrough · Undo**; Undo restores the value entered before (for a walkthrough-added room, the name's Undo removes the room only while none of its fields was edited by hand). A manual edit clears only that field's marker. On a fresh inspection, the first spoken room replaces the untouched default `Room 1` (0 SF) instead of being added beside it, and photos taken under `Room 1` are relabelled. Unquoted values are not filled and become clarification questions. Unstated fields keep their existing form defaults and need technician review; **Confirm scope** in the summary ticks the scope confirmation. Address, year, flags, equipment, labor and sheet-charge quantities are supported; prices, signatures, readings and work-completion status are not model-editable. Unknown/conflicting inputs require clarification. Filled or undone values invalidate documents/signatures and reset scope confirmation; a fill that changes nothing keeps them. Save and confirm the scope before Finish & review.

The endpoint is authenticated, owner/revision checked, bounded by the existing REST deadline and limited to six extraction requests per minute per user. It proposes values without writing the saved inspection. Deploy the compatible backend before the frontend through the dedicated project instructions. Authenticated staged extraction, Live recovery and reviewed form filling passed with synthetic statements. The feature is published, and authenticated production API/Live/browser checks passed, including signing, reopening and tracked synthetic cleanup. One earlier scope request reached the 55-second deadline; the complete retry passed. Physical iPhone dictation and Bluetooth acceptance remain open.


The Live reliability release uses protocol 2, named Charon voice, 64k/32k context compression,
private owner/job-bound checkpoints and explicit Resume after offline interruptions. Microphone pause
signals stream end; Finish stops media immediately and allows a bounded transcript drain. Recognized
text retains segment identities and incomplete/gap/edit metadata; form changes still require review.
Live connects with a freshly issued Firebase ID token and, when the relay's ready message offers
token_refresh, sends a new one every 10 minutes. The relay verifies each refresh like the initial token,
rejects one for a different user and re-checks the newest token, so sessions outlive the one-hour token.
A new walkthrough opens with a brief spoken greeting that asks for the property address, or the next
missing intake item when the address is saved; resumed and restarted sessions do not greet again.

Deployed backend and Hosting releases, their source commits and traffic are recorded only in
[RELEASES.md](RELEASES.md). Recheck the live pair before any release and keep it as the rollback
baseline. See docs/review-repairs.md for the release gates and docs/mobile-usability-repairs.md for the
repair evidence.
