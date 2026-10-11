# Alert Disaster Restoration field estimator

An owner-private mobile inspection app for ADR technicians in Bakersfield and Kern County. Open [the dedicated app](https://alert-disaster-field-2026.web.app) and sign in with the approved Google account, initially `nathanaelcnorman@gmail.com`.

Hosting, Firebase Authentication, Firestore, Cloud Run, private evidence storage and Vertex AI belong to `alert-disaster-field-2026`. The historical app redirects here. Peer sites and shared databases remain untouched. See [infrastructure and deployment](docs/firebase-isolation.md) and [repair acceptance evidence](docs/review-repairs.md).

## Company dashboards — staged release

The new build adds isolated company workspaces with superadmin, owner, estimator and office roles. Owners manage their company and team; estimators see jobs they create or are assigned; office staff coordinate jobs and view documents. Google sign-in uses private server-checked memberships. Invitations require explicit acceptance by the matching Google account. The initial ADR owner also has a separate superadmin role.

Production remains on the existing Live release while the workspace backend is staged. Real Resend delivery and authenticated role workflows must pass before activation. See [workspace permissions, migration and release checks](docs/company-workspaces.md). The new dashboard does not create a blank inspection at sign-in. Company identity is saved with documents; workbook pricing remains shared and unchanged.

## Inspection workflow

Use the persistent **Property / Walkthrough / Evidence / Review** navigation to move between tasks. **Jobs** opens drafts and signed agreements; **Account** contains sign-out and company contact details. Draft saving and **Finish & review** remain available at the bottom of the screen. Scope confirmation is required before document generation.

1. Enter the address, confirmed year built, rooms, measured demolition areas, water categories, waste, cabinetry, equipment, drying days and additional labor. Add applicable Matterport, dump-truck, decontamination, power-distribution and wood-floor drying charges from the sheet. Select crawl-space, granite and water-heater flags where applicable. Work is described as proposed unless the technician explicitly records completion.
2. Open **Walkthrough**, choose the current photo room and start the camera/microphone for real Gemini Live coaching. The Cloud Run relay authenticates the Firebase user and checks inspection ownership before connecting with server ADC. It sends 16 kHz mono PCM and aspect-preserving JPEG at 1 FPS; responses play at 24 kHz. Technician and assistant transcripts remain separate. Active sessions reveal Stop/Mute controls; optional color emulation is under Camera options, is explicitly labeled and does not produce thermal evidence.
3. Capture a supported native still or use Camera / upload. Originals, dimensions, room and capture time are retained privately. Pending, failed and non-meter OCR remain unverified. Recognition can be retried.
4. Confirm every pricing input and select **Finish & review**. Capture stops. The server reads the saved revision and evidence, validates AI output, applies deterministic pricing and mandatory ADR wording, and produces four documents. Provider failures show a retry error and cannot create a signable fallback.
5. Review the proposal's low–high estimate range, itemized claim, scope defense letter and photo log. Unpriced work or pending recognition blocks signing. Edits invalidate the audit and signature. Draw a signature and confirm document review; success is shown only after a durable server receipt.
6. Open **Jobs → Drafts & signed jobs** to recover a draft or restore the immutable signed agreement, all four documents, signature and evidence. Recent records appear first; use **Load older drafts** or **Load older signed jobs** for additional pages. A confirmed agreement stays saved if evidence display fails; **Retry loading saved evidence** reloads its display without signing again. **Export** contains JSON copy/download and printing. Mobile claims use readable line-item cards; desktop and printed claims retain the table. Export uses ADR internal codes without ESX compatibility claims. Saving does not dispatch technicians or send email.

## Pricing and evidence

`backend/claims.py` calculates money with Decimal and cent rounding. The populated default job charges total $1,180.20 and appear exactly once. Rates and the estimate-range formulas are traced to the user-supplied workbook in [pricing source notes](docs/pricing-source.md). Three fans and one dehumidifier for three days cost $567.00. Waste increases applicable demolition item totals. Added labor uses the workbook's $47.46/hr formula even for an after-hours loss, as confirmed by the user; after-hours estimates add $200 in job charges and apply the sheet's labor/material factor.

The customer proposal shows the sheet-derived low–high estimate, with itemized base-rate charges shown separately as its calculation detail. ADR package tiers are not in the supplied sheet and are no longer accepted for new audits. Models cannot supply prices, override totals or remove conditional clauses. AI summaries and suggestions are labeled for technician review; suggestions do not become observed evidence or authorized work.

## Private drafts and updates

Changes autosave to a user-specific IndexedDB queue and synchronize to Firestore when online. Photos upload individually. Reopening a draft merges evidence added on other devices and stores downloaded originals privately on this device for offline recovery and conflict copies. If an original cannot be fetched, retry online before copying that draft. Offline drafts can be edited; AI and signing require connectivity. Conflicts return 409 and preserve local work until the user restores the saved revision or creates a separate inspection. Logout stops resources and clears local drafts; retained cloud drafts and agreements are not automatically deleted.

The worker caches versioned app assets and public Firebase initialization configuration. Authenticated APIs and evidence are excluded. Navigation is network-first, and the app shell is served with `Cache-Control: no-store` so a browser refresh can pick up a release. The app checks for updates when brought to the foreground and prompts before activation, preserving drafts. The **Account** menu shows the installed app version. If an older screen persists, save the draft, open [the current field app with a fresh URL](https://alert-disaster-field-2026.web.app/?v=ui-20261006-6), and use **Save & update** if prompted. `alertdisaster.com` is the separate public company website and is not this field app. Physical iPhone offline launch, Bluetooth routing, interruption and conversational latency remain acceptance checks until the guided device test passes.

## ADR branding

The field app follows [ADR's official website](https://alertdisaster.com/): the official logo, red `#D42B32`, white and gray surfaces, Lato interface typography, and serif document text. EB Garamond supplies the document face as an openly licensed alternative to the site's commercial Garamond Premier Pro. Logo and fonts are hosted locally and included in the offline asset cache; font licenses are in `public/fonts/`. The live site supplied the primary phone `(661) 426-2151`, Bakersfield office address and service locations, verified October 6, 2026.

## Code and verification

| Location | Responsibility |
| --- | --- |
| `public/app.js`, `core.js`, `audio-worklet.js` | Lifecycle, safe DOM, offline recovery, camera and audio |
| `public/app.css`, `sw.js` | Responsive/print layout and app updates |
| `index.html`, `public/index.html` | Identical root and hosting HTML |
| `backend/contracts.py`, `claims.py` | Typed contracts, rates and four documents |
| `backend/inspection_store.py`, `job_store.py` | Revision transactions, owner checks, private evidence, retries and quotas |
| `backend/main.py` | Authenticated REST and Live relay |
| `tests/` | Synthetic behavioral tests; browser harness never ships |
| `scripts/verify_repairs.py` | Real dedicated infrastructure acceptance with scoped synthetic cleanup |

```powershell
python -m pip install -r backend/requirements.txt pytest httpx
python -m pytest tests -q -p no:cacheprovider
npm ci
npm test
npx playwright install chromium webkit
npm run test:browser
```

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

Production now uses backend alert-disaster-field-estimator-00006-yer at 100% traffic and frontend
live-reliable-20261007-1, Hosting version 0350de7b1566a1b5. Exact deployed assets and mobile routing
checks passed. The previous matched backend 00005-htr / Hosting version 60724bb918512475 is retained
for rollback. See docs/review-repairs.md for evidence and remaining acceptance gates.
