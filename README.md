# Alert Disaster Restoration field estimator

An owner-private mobile inspection app for ADR technicians in Bakersfield and Kern County. Open [the dedicated app](https://alert-disaster-field-2026.web.app) and sign in with the approved Google account, initially `nathanaelcnorman@gmail.com`.

Hosting, Firebase Authentication, Firestore, Cloud Run, private evidence storage and Vertex AI belong to `alert-disaster-field-2026`. The historical `alert-disaster-live` site was retired as of 2026-10-12; use this app's address. Peer sites and shared databases remain untouched. See [infrastructure and deployment](docs/firebase-isolation.md) and [repair acceptance evidence](docs/review-repairs.md).

## Company dashboards

The new build adds isolated company workspaces with superadmin, owner, estimator and office roles. Owners manage their company and team; estimators see jobs they create or are assigned; office staff coordinate jobs and view documents. Google or verified email/password sign-in uses private server-checked memberships. Password accounts are created only by invitation: the invitation email carries a link to set the password. Public sign-up is disabled in the Firebase project and must stay disabled. Invitations require explicit acceptance by a verified account with the matching email. The initial ADR owner also has a separate superadmin role.

Company workspaces are enabled in production since October 15, 2026; the serving backend and Hosting release are recorded in [RELEASES.md](RELEASES.md). Invitations are sent by Gmail SMTP. See [workspace permissions, migration and release checks](docs/company-workspaces.md). The new dashboard does not create a blank inspection at sign-in. Company identity is saved with documents; workbook pricing remains shared and unchanged.

## Inspection workflow

Use the persistent **Property / Walkthrough / Evidence / Review** navigation to move between tasks. **Jobs** opens drafts and signed agreements; **Account** contains sign-out and company contact details. The **?** (Help) button beside **Account** opens short how-tos that work offline: topics for the signed-in role come first, followed by getting started, other roles' topics and the company contact. Role only orders the text; it shows no job data or controls. Draft saving and **Finish & review** remain available at the bottom of the screen. Scope confirmation is required before document generation.

1. Enter the address, confirmed year built, rooms, measured demolition areas, water categories, waste, cabinetry, equipment, drying days and additional labor. Add applicable Matterport, dump-truck, decontamination, power-distribution and wood-floor drying charges from the sheet. Describe crawl spaces, countertops, water heaters and similar job conditions in the notes or walkthrough. Documents describe the work as proposed.
2. Open **Walkthrough**, choose the current photo room and start the camera/microphone for real Gemini Live coaching. The Cloud Run relay authenticates the Firebase user and checks inspection ownership before connecting with server ADC. It sends 16 kHz mono PCM and aspect-preserving JPEG at 1 FPS; responses play at 24 kHz. Technician and assistant transcripts remain separate. Active sessions reveal Stop/Mute controls; optional color emulation is under Camera options, is explicitly labeled and does not produce thermal evidence.
3. Capture a supported native still or use Camera / upload. Originals, dimensions, room and capture time are retained privately. Pending, failed and non-meter OCR remain unverified. Recognition can be retried.
4. Confirm every pricing input and select **Finish & review**. Capture stops. The server reads the saved revision and evidence, validates AI output, applies deterministic pricing and mandatory ADR wording, and produces four documents. Provider failures show a retry error and cannot create a signable fallback.
5. Review the proposal's low–high estimate range, itemized claim, scope defense letter and photo log. Unpriced work or pending recognition blocks signing. Edits invalidate the audit and signature. Draw a signature and confirm document review; success is shown only after a durable server receipt. To let the homeowner sign on their own phone instead, choose **Send to homeowner**: the app shows a QR code, a copyable link and (where the phone supports it) the share sheet. The homeowner opens the link with no account, reads the same four documents, types their name, chooses owner or authorized representative, checks two confirmations and draws a signature. The link works once, expires after 7 days, can be revoked, and stops working as soon as anything in the inspection changes. While it is outstanding, the Review tab checks every 10 seconds and switches to the signed agreement when the homeowner signs. After signing, the homeowner can reopen the link for 30 days to view or print the signed copy. The server sends no email or text.
6. Open **Jobs → Drafts & signed jobs** to recover a draft or restore the immutable signed agreement, all four documents, signature and evidence. Recent records appear first; use **Load older drafts** or **Load older signed jobs** for additional pages. A confirmed agreement stays saved if evidence display fails; **Retry loading saved evidence** reloads its display without signing again. **Export** contains JSON copy/download and printing. Mobile claims use readable line-item cards; desktop and printed claims retain the table. Export uses ADR internal codes without ESX compatibility claims. Saving does not dispatch technicians or send email.

## Pricing and evidence

`backend/claims.py` calculates money with Decimal and cent rounding. The populated default job charges total $1,180.20 and appear exactly once. Rates and the estimate-range formulas are traced to the user-supplied workbook in [pricing source notes](docs/pricing-source.md). Three fans and one dehumidifier for three days cost $567.00. Waste increases applicable demolition item totals. Added labor uses the workbook's $47.46/hr formula even for an after-hours loss, as confirmed by the user; after-hours estimates add $200 in job charges and apply the sheet's labor/material factor.

The customer proposal shows the sheet-derived low–high estimate, with itemized base-rate charges shown separately as its calculation detail. ADR package tiers are not in the supplied sheet and are no longer accepted for new audits. Models cannot supply prices, override totals or remove conditional clauses. AI summaries and suggestions are labeled for technician review; suggestions do not become observed evidence or authorized work.

## Private drafts and updates

Changes autosave to a user-specific IndexedDB queue and synchronize to Firestore when online. Photos upload individually. Reopening a draft merges evidence added on other devices and stores downloaded originals privately on this device for offline recovery and conflict copies. If an original cannot be fetched, retry online before copying that draft. Offline drafts can be edited; AI and signing require connectivity. Conflicts return 409 and preserve local work until the user restores the saved revision or creates a separate inspection. Logout stops resources and clears local drafts once they have synced. If any draft has not synced, sign-out stops and offers **Discard unsynced work and sign out**. Retained cloud drafts and agreements are not automatically deleted.

The worker caches versioned app assets and public Firebase initialization configuration. Authenticated APIs and evidence are excluded. Navigation is network-first, and the app shell is served with `Cache-Control: no-store` so a browser refresh can pick up a release. The app checks for updates when brought to the foreground and prompts before activation, preserving drafts. The **Account** menu shows the installed app version, the start of the source commit stamped at release. If an older screen persists, save the draft, open [the current field app with a fresh URL](https://alert-disaster-field-2026.web.app/?v=ui-20261006-6), and use **Save & update** if prompted. `alertdisaster.com` is the separate public company website and is not this field app. Physical iPhone offline launch, Bluetooth routing, interruption and conversational latency remain acceptance checks until the guided device test passes.

## ADR branding

The field app follows [ADR's official website](https://alertdisaster.com/): the official logo, red `#D42B32`, white and gray surfaces, Lato interface typography, and serif document text. EB Garamond supplies the document face as an openly licensed alternative to the site's commercial Garamond Premier Pro. Logo and fonts are hosted locally and included in the offline asset cache; font licenses are in `public/fonts/`. The live site supplied the primary phone `(661) 426-2151`, Bakersfield office address and service locations, verified October 6, 2026.

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

## Voice-driven scope entry and Live reliability — deployed, acceptance pending

The current source adds **Fill scope from walkthrough** in Walkthrough and Property & scope. Describe explicit room names, water categories, measured demolition areas in square feet, and job-total equipment counts/days. Requesting fill stops capture, saves the draft, and uses the configured audit model to extract suggested values from technician transcript/notes. Assistant guidance is excluded. This is a review action after speaking, rather than automatic form mutation on each Live turn.

Each proposed change displays its previous value, new value and supporting technician quote. Select the changes to apply or dismiss them; new-room changes are selected together. Unstated fields keep their existing form defaults and need technician review. Address, year, flags, equipment, labor and sheet-charge quantities are supported; prices, signatures, readings and work-completion status are not model-editable. Unknown/conflicting inputs require clarification. Accepted edits invalidate documents/signatures and reset scope confirmation. Save and confirm the scope before Finish & review.

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
