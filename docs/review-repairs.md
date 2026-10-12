# Repair acceptance record

The October 6, 2026 [original review](https://chatgpt.com/space/page_4a5293fc2ec481918bd32e5c78fb2dca) is retained as the baseline. All 18 findings have implementation changes. Software verification and dedicated deployment are complete; physical iPhone acceptance remains open.

## Finding status

| # | Original finding | Repair and evidence | Status |
| --- | --- | --- | --- |
| 1 | Gemini Live missing | Authenticated ADC relay, ownership/origin checks, 16 kHz input, 1 FPS JPEG, 24 kHz playback, separate transcripts, interruption/reconnect/teardown. Real relay returned 177,600 audio bytes. | Implemented; physical audio/Bluetooth and latency open |
| 2 | Executable HTML | DOM textContent construction; injected onerror text remains literal in both browsers. Hosting CSP verified. | Verified |
| 3 | Failed audit signs a seeded claim | No seeded claims. Provider failures show errors; documents/signing stay unavailable. | Verified |
| 4 | Fabricated OCR saturation | Typed OCR, content validation, explicit pending/failed/no-meter states. Real non-meter portrait remained unverified. | Verified |
| 5 | Authorization discarded / false dispatch | Durable immutable four-document snapshot, private signature/evidence, awaited receipt; identical concurrent retry receipts. No dispatch/email claim. | Verified |
| 6 | Missing AI fabricates work | Unavailable/invalid AI returns error; no unrelated fallback, no invented completion. | Verified |
| 7 | Wrong prices / missing baseline | Server Decimal rate book; $1,180.20 exactly once, $567 equipment example, category/cabinet/labor rates; model prices excluded. | Verified |
| 8 | Invalid four-document output / missing clauses | Strict typed contracts, required audit inputs and deterministic exact age/granite/heater/crawl wording. AI narrative separate from observations/work. | Verified |
| 9 | Public APIs unbounded | Firebase approved verified-email authentication, owner checks, content/metadata limits, transaction quotas and one Live lease. | Verified |
| 10 | Shared Firebase / no database | Hosting, Auth, Firestore, bucket, Cloud Run, identities and Vertex calls belong to `alert-disaster-field-2026`. Peer resources unchanged. | Verified |
| 11 | Incomplete handoff / pending evidence | Server reads saved revision with room scope, equipment, labor, transcripts, original images, timestamps and OCR status; waits up to 30s and discloses unresolved evidence. | Verified |
| 12 | Waste totals overridden | Trusted arithmetic applies waste to demolition and rounds cents; caller/model totals ignored. | Verified |
| 13 | Camera errors / resources left running | Recoverable permission error and upload fallback; idempotent teardown stops tracks, timers, worklet, socket, audio and reconnect timer. | Automated checks pass; physical permissions/Finish open |
| 14 | Signature survives scope edits | Server revision/hash binding; edits invalidate audit/signature; signed inspection immutable and fully restored. | Verified |
| 15 | Blocking AI / no deadlines | Async SDK, 55s overall REST deadline, bounded image processing and provider error states. Actual cloud container build/start and service calls passed. | Verified |
| 16 | Stale installed app | Versioned local assets, network-first navigation, visible update prompt, draft preservation, no protected response caching. | Desktop update checks pass; installed iPhone/offline open |
| 17 | Stretched low-resolution stills | Native ImageCapture when supported, original-size video fallback/native camera upload, actual dimensions and preserved portrait ratio. | Portrait original tests pass; physical native still quality open |
| 18 | Currency / misleading export | Intl currency formatting, JSON download/copy, awaited clipboard errors, four printable documents. | Verified |

## Additional approved draft recovery

User-specific IndexedDB retains metadata, transcripts and original photos. Multiple queued inspections synchronize when online, with revision conflicts preserved for explicit recovery. AI/signing are disabled offline. Logout and identity changes stop resources and clear prior visible data; logout clears local drafts. Cloud drafts/signed jobs are retained without automatic deletion.

## Verification evidence

- Python: **27 passed**, including deterministic rates/clauses, invalid AI, provider failures, ownership, upload validation, metadata limits, concurrency, immutable retries, Live authentication/frame throttle/interruption/lease cleanup. Two dependency deprecation warnings do not fail the suite.
- Node: money, portrait scaling, PCM decoding, continuous 16 kHz resampling, mirror equality and idempotent resource teardown passed.
- Browser: **14 passed, 2 explicitly skipped**. Chromium and WebKit cover four-document rendering, injection, signing/retry/reopening, editing invalidation, controlled permission denial, portrait/non-meter evidence, clipboard denial, printing, revision conflicts, updates/cache privacy and logout. Chromium also covers actual offline reload and multiple queued inspections. Windows Playwright WebKit throws an internal navigation error for offline service-worker reload; the two real-offline cases remain open for iPhone verification.
- Print: four Letter pages were generated and visually inspected, including separate proposal/itemized amounts and unverified photo labels. Hidden unsigned signature placeholder and page background were corrected. `review-artifacts/repaired-documents.pdf` is a synthetic fixture, not a customer proposal.
- Real services: `scripts/verify_repairs.py` passed dedicated real OCR/audit generation, exact baseline/equipment/waste arithmetic, conditional wording, Live authentication/ownership/single-session/reconnect, concurrent signing receipts, full restoration, private evidence, denied anonymous/unapproved access and cross-owner reads. Synthetic accounts, inspections, authorizations, objects, quotas and leases were removed. The temporary test-token permission was revoked.
- Live smoke observation: first queued audio read was **0.88s** after synthetic speech finished; the test includes receive scheduling and is not a device latency benchmark. The sub-second conversational target remains open until measured on iPhone with Bluetooth.
- Deployed production checks passed HTML/asset equality, dedicated Firebase config, schema-2 API routing, anonymous denial, CSP, mobile sign-in shell and real Google OAuth popup. No real customer data was used.

## Dedicated rollout

The backend container built with the deployment dependencies on Python 3.11. Final revision: `alert-disaster-field-estimator-00003-f8d`, `us-west2`, 1 GiB, 3600s connection timeout, dedicated runtime/build identities. Models were smoke-tested before enabling them: `gemini-3.8-flash` in `global`, `gemini-3.8-live` in `us-central1`.

Only `hosting:alert-disaster` was deployed in `alert-disaster-field-2026`, after compatible backend verification. The [production app](https://alert-disaster-field-2026.web.app) uses the dedicated Firestore/bucket. Both HTML copies are identical. Previous dedicated backend revision `00001-2t7` and Firebase Hosting release history remain available for matching rollback; shared-project resources are not rollback targets.

## Guided iPhone acceptance — open

Use an explicitly synthetic inspection, not a customer agreement. Record iPhone model, iOS version, Safari vs installed app, network and Bluetooth device. Stop and report the exact visible error when a step fails.

1. Open the app, sign in with the approved Google account and connect the Bluetooth earpiece. Create **Synthetic iPhone test**, year 2000, room Bathroom, category 1, finished/unfinished areas 0 SF, waste 0%, zero fans/dehumidifiers, three days and zero additional labor. Leave default job-charge quantities in place and optional charges at zero. Keep scope confirmation unchecked until the voice suggestions have been reviewed.
2. Open Walkthrough, choose Bathroom as the current photo room and start the walkthrough. Deny permission once, verify recovery, then allow camera/microphone. Verify earpiece routing and separate technician/assistant transcripts. Say: "Bathroom, category one. I measured ten square feet of finished drywall demolition and zero square feet of unfinished demolition. Use three fans and one dehumidifier for three days." Choose Fill scope from walkthrough. Capture must stop; inspect the technician quotes and suggestions before applying. Leave Air movers unchecked, apply the other supported changes, and verify fans remain zero while finished SF becomes ten and dehumidifiers becomes one. Enter three fans manually, review defaults and confirm the scope. Expected itemized charges: **$1,775.00**; customer range: **$1,775.00–$1,788.90**.
3. Restart Live after the reviewed scope changes. Keep camera capture active for more than two minutes and check voice clarity with representative background noise. Interrupt the assistant by speaking; old audio must stop. Mute/unmute the microphone. Switch briefly offline and back; capture must stop, the draft must survive, and Live must remain stopped until Resume walkthrough is tapped. Verify visible resumed/restarted status and recovery-boundary warnings without duplicate audio. For at least five short questions, record end-of-speech and first audible answer timestamps, elapsed seconds and measurement method. Report all five values; approximate impressions alone do not establish the sub-second target.
4. Capture a portrait photo and try Camera / upload. In Evidence, check room, capture time and actual dimensions. Try a non-meter photo; it must remain unverified. If available, capture a clearly readable physical meter and compare OCR with its actual display. Color emulation under Camera options must remain labeled.
5. Tap Finish & review. Camera/microphone indicators and response audio must stop. In Review, open all four documents and check the estimate range and itemized calculation. Return to Property and edit a scope field; old documents/signature must invalidate. Reconfirm and generate documents again.
6. Reload a draft. Install/add to Home Screen, then test offline draft editing, cold reload and later synchronization. AI/signing must be disabled offline. If an update banner appears, apply it and verify the draft survives.
7. Use only a synthetic test stroke if checking signing. Use Jobs → Drafts & signed jobs to reopen the saved job and verify four documents, signature and photos. Check JSON download/copy and printing under Export. Sign out under Account and confirm capture stops and local drafts disappear.

Device results: **not yet provided**. Camera quality, physical meter accuracy, Bluetooth routing, interruptions/reconnect, installed-app/offline behavior, Finish cleanup and sub-second conversational latency remain open until these checks pass.

## Official website branding — deployed October 6, 2026

At the user's request, the app now follows [alertdisaster.com](https://alertdisaster.com/), inspected with the agent-browser skill. The official logo, red `#D42B32`, white/gray surfaces and Lato interface typography are applied to the responsive field app. Openly licensed EB Garamond supplies serif document text in place of the site's commercial Garamond Premier Pro. The current rendered site supplied the primary phone `(661) 426-2151`, Bakersfield office address and service locations. Brand assets/fonts are hosted locally with font licenses and cached for offline use.

Release `brand-20261006-2` was deployed only to `hosting:alert-disaster` in `alert-disaster-field-2026`. Node checks passed; browser workflows passed **14 tests with the same 2 Windows WebKit offline skips**. The final print case passed again after the logo/contact markup correction, and all four generated Letter pages were visually inspected. Production checks confirmed exact deployed assets, logo dimensions, local fonts, cached branding, no mobile horizontal overflow, dedicated Firebase/API routing, CSP and Google OAuth. Screenshots are in `review-artifacts/branded-live-mobile.png` and `branded-live-desktop.png`. Physical iPhone acceptance remains open as recorded above.

## UI review recommendations — deployed October 6, 2026

Release `ui-20261006-3` implements all six findings in [the UI review](../review-artifacts/ui-review-20261006/report.md): persistent task navigation, a compact header, larger/state-aware capture controls, visible document choices and mobile claim cards. Jobs, Account and Export menus group secondary actions. Package and itemized totals remain separate; printed claims retain the table. Logout clears in-memory state before reload so pagehide cannot recreate a cleared local draft.

Verification: **27 Python tests**, Node checks and **19 browser tests passed**, with **3 explicit Windows WebKit skips** (two real-offline cases and active audio because this build lacks Web Audio). Four Letter pages were inspected. Deployed asset/config/API/CSP/OAuth checks and agent-browser narrow-screen checks passed. Only the dedicated hosting target was deployed. Physical iPhone acceptance remains open.

## Estimating-sheet correction — deployed October 6, 2026

The user supplied `1 - Water . Mold - Estimating Sheet (2).xlsx` and confirmed that ADR does not use the package tiers previously coded. The user chose the workbook's low–high customer estimate and instructed us to mirror its $47.46/hr added-labor formula even for after-hours jobs. [Pricing source notes](pricing-source.md) identify the source cells, after-hours factors, optional charges and workbook defects. New audits reject a selected legacy package price with an update-required response; current clients clear it while preserving old signed documents.

New proposals show a customer estimate range and separate itemized base-rate charges. The backend uses confirmed job-charge quantities, demolition areas, waste, equipment and optional sheet items. It adds the sheet's $200 after-hours charge, applies its 20% labor/material adjustment, then calculates the high bound from the affected-area threshold. The default five job charges total $1,180.20, and 3 fans plus 1 dehumidifier for 3 days total $567.00. Schema-3 authorizations retain both range bounds and the original four documents.

Release `ui-20261006-5` was deployed only to `hosting:alert-disaster` in `alert-disaster-field-2026` after Cloud Run revision `alert-disaster-field-estimator-00004-rzx` became ready. **32 Python tests**, Node checks and **21 Chromium/WebKit browser tests passed**, with the same **3 platform-specific skips**. The live hosting check passed exact asset equality, mobile layout, schema-3 routing, anonymous denial, cache headers and OAuth initialization. A real synthetic dedicated-project check passed OCR, Gemini Live ownership and reconnect, generated the expected $1,777.78–$1,793.07 range from a 10-SF Category 1 scope with 10% waste, confirmed durable signing/restoration and private evidence, then removed its accounts, records, evidence, quotas and temporary token permission. The physical iPhone test remains open.


## Full-review repairs ? deployed October 7, 2026

All six findings from the subsequent [full review](../review-artifacts/full-review-20261006/report.md) are repaired and deployed. Cloud-restored photo originals now survive offline reload and conflict copies; reconciliation includes photos added by another device. Signing keeps the confirmed receipt independent of evidence display and offers a separate retry. Draft and signed-job lists use newest-first Firestore queries with owner-checked pagination and ready composite indexes. Firebase verification checks revoked/disabled users; active Live connections recheck every 20 seconds. Unique upload-attempt paths allow generation-checked cleanup of objects left by rejected transactions and losing signature retries. If cleanup cannot be safely confirmed, the private object is retained and the failure logged.

Current release: frontend `ui-20261006-6`, backend `alert-disaster-field-estimator-00005-htr`; dedicated Hosting version `60724bb918512475`, release `1791378004044000`. Prior backend `00004-rzx` and Hosting version `ef31df7f4a1fb47e` / release `1791344352511000` remain matching rollback points. No peer/shared resources were changed; staff/model settings and workbook pricing were preserved.

Verification: **37 Python tests passed**, Node/syntax checks passed, **32 Chromium/WebKit cases passed and 4 explicitly skipped** for Windows WebKit media/offline limitations. Deployed synthetic tests passed pagination across 105 drafts and 105 signed-job fixtures, cross-owner cursor denial, concurrent uploads/signature retries with only committed evidence retained, complete document/evidence restoration, and disabled-account REST rejection. A real active Gemini Live connection stopped 19.7 seconds after disabling its synthetic account. [Recorded live results](../review-artifacts/full-review-20261006/deployed-fix-checks.txt). Published assets/mobile layout, dedicated API routing, CSP, local fonts/cache and the real Google OAuth popup passed `scripts/verify_hosting.js`. All synthetic artifacts and temporary signing permissions were removed. Physical iPhone tests above remain open; office-wide access and automatic Live resumption after an offline event remain product decisions.


## Voice-driven scope entry — local implementation, October 7, 2026

Source release `voice-scope-20261007-1` adds **Fill scope from walkthrough** in Walkthrough and Property & scope. This release is **not deployed**; the production release documented above remains the latest recorded deployment. The action pauses capture, saves the current draft and proposes form values using technician transcript/notes and the configured audit model. It does not mutate the form continuously while Live is speaking. Live coaching now asks for explicit room/category/measurement and job-total equipment details.

The authenticated, owner-checked `POST /api/inspections/{id}/scope-suggestions` endpoint reads a saved revision, checks quoted technician source, supported field names/types/ranges and new-room category/area prerequisites, and returns proposed changes without writing the inspection. Assistant guidance is excluded. There is a six-per-minute per-user extraction quota and the existing 55-second REST deadline. The client discards results if the inspection, identity, revision or inputs change, including changes during the draft-saving phase.

The review shows old/new values and source quotes. Users can dismiss or selectively apply suggestions; room changes are grouped. Applying changes preserves other inputs, invalidates existing documents/signatures, and resets scope confirmation. Missing room fields retain the form defaults and require review. Prices, readings, work-completion status, signatures and confirmation are outside the model's editable fields. Photo-room selection remains technician-controlled.

Real provider evidence is separate from mocks: `scripts/verify_scope_extraction.py` passed direct ADC/Vertex generation in `alert-disaster-field-2026` using `gemini-3.8-flash`, extracting exactly Bathroom / Category 2 / 80 SF drywall / 3 fans / 1 dehumidifier / 4 days with supporting quotes. [Provider result](../review-artifacts/voice-scope-20261007/provider.txt). This was a direct synthetic provider request, not a check of a deployed new endpoint; it created no stored jobs, objects, signatures or IAM grants.

The initial response schema returned 400. Reducing the provider schema's enum/union nesting and decoding constraints fixed the real request while retaining strict Pydantic validation afterward. Google documents [schema complexity and supported fields](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output?hl=en#considerations).

Python ran with the existing 3.11 runtime and dependencies installed only inside the ignored workspace test directory. An existing baseline assertion now sums Decimal representations of line-item currency to avoid Python-version-dependent float summation; estimate arithmetic itself was unchanged. Initial browser evidence is retained separately: WebKit exposed an edit during synchronization, which is now rejected, plus an initial page-readiness timeout; the local test readiness wait was adjusted to 15 seconds. The completed-test runner initially hung shutting down WebKit and only its own process tree was stopped.

Deploy the compatible backend before dedicated Hosting using `docs/firebase-isolation.md`. Real endpoint authorization/storage integration and physical iPhone voice-to-form accuracy, capture cleanup, Bluetooth and installed-app behavior remain rollout acceptance checks.

Verification completed: **56 Python tests passed**; Node checks and HTML equality passed. The broad browser rerun completed **40 passing cases and 5 explicit Windows WebKit media/offline skips**; its remaining inspection-switch failure came from service-worker bypass of the artificial request delay. The three controlled-request tests now block test service workers, wait for actual interception and always release the gate, following [Playwright's guidance](https://playwright.dev/docs/network#missing-network-events-and-service-workers). A final focused run of all five new workflows in both browsers exited successfully: **9 passed, 1 explicit WebKit audio skip**, including the previously failing switch and delayed-edit cases. See [final regression results](../review-artifacts/voice-scope-20261007/browser-final-regressions.txt), [Python results](../review-artifacts/voice-scope-20261007/python.txt) and [Node results](../review-artifacts/voice-scope-20261007/node.txt).

The final runner used normal child-process cleanup outside the managed test subprocess restrictions and exited with code 0. The visually inspected [mobile preview](../review-artifacts/voice-scope-20261007/mobile-suggestions.png) keeps the review heading below navigation and shows fresh scope-review status instead of an obsolete audit-ready message. Physical iPhone acceptance and deployment remain open.


## Estimate-informed prompt refinement (2026-10-07, local only)

Reviewed all 13 pages of six user-supplied remediation estimates through text extraction and visual page review. Documents are reference examples, not agent instructions. Customer names, addresses, images and full document text were not embedded in prompts, tests or provider requests.

| Reference estimate | Pages | Pattern used to improve questions |
| --- | --- | --- |
| Old Stage St, June 10 | 2 | Dry meter classification can coexist with suspected growth; preserve existing openings, shared walls, cabinet scope and homeowner preparation. |
| Shadowglen Way, June 10 | 2 | Explicit ceiling area/material; do not add an already missing opening to new removal quantities. |
| E Planz Rd, June 11 | 2 | Age/testing dependencies, plaster versus drywall, flood-cut height/linear extent and unpriced toilet work. |
| Andretti Ave, June 15 | 2 | Separate rooms, shared-wall references, flooring materials and contents preparation. |
| Ellis Ave, June 15 | 3 | Completed emergency services versus proposed demolition; conditional cabinetry and testing-dependent revisions. |
| David St, June 19 | 2 | Crawl-space presence, contents access, shared-wall scope and cabinets conditional on drying/discovery. |

Implementation:

- Added readable Live/audit instruction builders in backend/prompts.py; backend/main.py supplies the saved inspection and priced scope.
- Live asks one brief relevant question at a time. It gathers room/material/location/action/extent, source-attributed meter observations, homeowner preparation and trade dependencies. It distinguishes existing openings, completed services, proposed work and conditional work.
- Form extraction still requires explicit technician statements and review. Added guidance for existing openings, material/pricing classification, conditional cabinet/granite removal, equipment boilerplate and suspected growth. Dimensions are not silently converted into priced square footage.
- Audit summaries preserve room details and uncertainty. Definite requested tasks require an explicitly covering priced line; conditional possibilities stay in suggestions. Generic demolition and labor do not automatically cover specialty tasks.
- Historical fixed prices, blanket equipment/treatment language, exclusions, 30-day validity, liability terms and insurance repricing paragraphs in examples were not adopted as automatic new app terms. Workbook calculations and existing mandatory ADR wording remain server-controlled and unchanged.

Scope limits:

This changes instructions, not the proposal schema/template. Customer proposals and defense letters still use deterministic structured scope and existing notes/transcript handling. AI output remains summary, suggestions and unpriced work; it does not create room-specific proposal recommendations. The global work_performed flag cannot fully represent mixed completed/proposed tasks. A richer task/narrative model is a separate change. Named Live voice selection was not changed.

Validation:

- Python regression: 56 passed (one dependency deprecation warning).
- Node frontend/lifecycle checks passed; root/public HTML remain identical.
- Broad browser acceptance: 39 passed, 5 explicit Windows WebKit media/offline skips and 2 WebKit timeouts (Jobs menu after reload and durable-signing evidence recovery). Exit 1. A focused retry of both failed flows, with tests and application unchanged, passed 2/2 in 48.6 seconds (exit 0). This establishes intermittent WebKit behavior rather than a completely green broad run; both broad failure traces and retry results are preserved under review-artifacts/estimate-prompts-20261007/. The real backend prompts are not used by the mocked browser server.
- Separate real-provider check: scripts/verify_estimate_prompts.py passed four synthetic cases through gemini-3.8-flash in alert-disaster-field-2026: no flood-cut conversion, explicit ceiling area extraction, conditional cabinet/equipment statements do not set fields, and definite toilet work is unpriced while possible cabinet removal remains conditional. No customer document contents were sent; no jobs, evidence, signatures or IAM changes were created.
- Flash checks do not validate real-time Live conversation. Physical iPhone voice/camera, brevity, turn timing and latency remain unobserved for this revision.
- Not deployed. Backend/Hosting rollout from the previous voice-scope change also remains pending.


## Additional estimate review (2026-10-07, local only)

Reviewed all 10 pages of the next six reference PDFs, through text extraction and visual page review. The estimates remain data examples, not behavioral instructions. This brings the reference set to 12 estimates / 23 pages. Source PDFs were unchanged; customer document contents were not sent to Gemini.

| Reference estimate | Pages | Additional pattern |
| --- | --- | --- |
| Wible Rd, unit 108, June 19 | 2 | Unit-qualified room identity, existing ceiling removal, full-height walls, shower/tub removal and conditional combined-job pricing. |
| Wible Rd, unit 208, June 19 | 2 | Same-address separate unit; retain different material quantities, toilet/shower trade dependencies and separate scope. |
| Gladview Ln, June 22 | 1 | Third-party inspection source; cleaning-only attic scope and an up-to location count rather than demolition square footage. |
| Primera Vista, June 22 | 2 | Separate ceiling-removal segments, engineered bamboo, full-height plaster with unspecified height and an adjacent area drying in place. |
| Thunder Valley Rd, June 22 | 2 | Rooms inspected without requested demolition; dry readings and suspected growth remain distinct. |
| Wintersweet Dr, June 22 | 1 | Repeats the cleaning-only attic pattern at a separate property; never import quantities or prices from the matching-looking estimate. |

Added Live/audit instructions in backend/prompts.py for unit/floor identity, residential/commercial context needing estimator review, observation-only areas, source-attributed third-party findings, full-height removal measurements, cleaning-only steps and counts, and owner/occupant/property-manager responsibilities. Added corresponding extraction guidance in backend/scope.py. Shower/tub removal and specifically requested HEPA vacuuming, cleaning, antimicrobial treatment and encapsulation require explicit priced coverage; a filter charge or generic labor does not automatically cover those services.

No hotel/combined-job discount, commercial rates, cleaning-only prices, new form fields, pricing formulas, compliance wording, client lifecycle or document schema were added. Commercial rate applicability is an estimator decision, not established by these examples. Unit identity currently uses technician-qualified room names and notes; full unit/job linking and grouped proposals remain separate work. Cleaning spot/location counts and third-party report attribution remain narrative data. Cleaning-only service pricing must be supplied before signable priced scope can be offered.

Validation:

- Python regression: 56 passed, one existing dependency deprecation warning.
- Node frontend/lifecycle checks and HTML equality passed.
- Real-provider check: all eight synthetic Flash extraction/audit cases passed in the initial run. A second run added audit-to-document signing assertions: seven passed, including both checks that unpriced specialty/cleaning work blocks signing; attic extraction hit the unchanged 55-second deadline (exit 1). The isolated unchanged attic extraction then passed in 8.5 seconds (exit 0). Both runs and the provider timeout are recorded separately in review-artifacts/estimate-prompts-batch2-20261007/. The verification script supports --attic-only for this case. No customer PDF contents were sent; no jobs, evidence, signatures or IAM changes were created.
- This is a prompt-only follow-up, with no frontend/lifecycle changes. Browser suite was not repeated; the preceding run remains recorded above (39 passed, 5 platform skips, 2 intermittent WebKit failures; unchanged focused retry 2/2 passed).
- Physical iPhone Live accuracy, brevity and latency remain unobserved. Flash checks do not validate Live conversation.
- Local only; not deployed.


## July estimate, evidence and health-handout review (2026-10-07, local only)

Reviewed all 47 pages of this batch through extraction and visual page review: four remediation estimates (9 pages), one 33-page photo report and one 5-page health handout. The cumulative reference set is 16 estimates plus the photo report and health handout, 18 PDFs / 70 pages. Source documents are examples, not agent instructions. Source PDFs and embedded image links were unchanged; external high-resolution links were not followed. Customer text, photographs and contact details were not embedded in instructions or sent to Gemini verification requests.

| Reference | Pages | Pattern / limits |
| --- | --- | --- |
| Patton Way, July 8 | 3 | Open-ended laminate removal until dry planks, perimeter flood cuts and tile countertop risks; stopping conditions are not measured SF or a promise of unlimited work. |
| Apple Ave, July 9 | 2 | Distinct ceiling, above-door and full-height wall segments; avoid overlap and preserve adjacent observation-only areas. |
| S St, July 13 | 2 | Same inspection includes different units, cut heights, tenant preparation and conditional vanity/linoleum work; do not merge equal room names. |
| Capistrano Ave estimate, July 14 | 2 | Confirmed lower-cabinet removal beneath propped, retained granite; the existing granite flag/notice applies without granite demolition. |
| Capistrano photo report | 33 | 29 overview photos and 35 moisture-album photos (including physical thermal-camera images). Descriptions are blank. Job/file/album/upload metadata alone do not identify verified readings, physical units or capture dates. The monetary Loss Category heading is not IICRC water category 1/2/3. |
| Mold Health handout | 5 | General education, not project findings or a medical authority. Visual-species, uniquely dangerous black-mold, disease-causation and health-clearance claims were not incorporated. |

Local changes:

- Corrected backend/scope.py instructions for granite_removal: confirmed cabinet removal beneath granite sets the flag even when the countertop remains propped/preserved. Mere granite presence, conditional cabinet removal and tile/unknown countertops do not establish it. Server notice wording, rate multipliers and signability logic were not changed.
- Live/audit questions now preserve stopping conditions, request measured non-overlapping totals and keep open-ended removal outside priced quantities for quantity/price review. Shared-unit scoping and source attribution from the preceding review remain in effect.
- Evidence guidance asks for room/unit/surface-linked overview, close-up and readable meter images, measurement mode and dry comparison where needed. Relative meter scales are not silently converted into percent moisture. Physical thermal images indicate temperature patterns, not verified moisture values; simulated color filters remain distinct.
- Centralized the existing OCR instructions in backend/prompts.py and clarified thermal-camera displays, unknown units/modes and invented saturation thresholds. Recognition statuses, transport, schema and lifecycle were unchanged.
- Personal symptoms remain reported concerns, with healthcare referral rather than species identification, toxicity diagnosis, illness attribution or an occupancy/mold-free guarantee. Generic health handouts do not become verified site evidence or authorized reconstruction scope.

Primary-source review supporting health/evidence boundaries:

- [CDC/NIOSH: Mold, Testing, and Remediation](https://www.cdc.gov/niosh/mold/testing-remediation/index.html) states that mold color does not determine greater/lesser danger and that airborne counts cannot be interpreted as a health-risk threshold.
- [CDC: Facts About Stachybotrys chartarum](https://www.cdc.gov/mold-health/data-research/facts-stats/) describes nonspecific symptoms, no test proving association with particular symptoms, and physician consultation for persistent symptoms. This does not say mold has no health effects.
- [CDC: Mold](https://www.cdc.gov/mold-health/about/) describes variable health effects, including respiratory/allergic effects and infection risks for certain vulnerable people; the handout should not turn these into definite illness predictions for a specific property.
- [EPA: Basic mold cleanup steps](https://www.epa.gov/mold/what-are-basic-mold-cleanup-steps) emphasizes moisture correction and cleaning/drying before painting. Live asks about those conditions rather than promising that coating replaces cleanup.

Validation:

- Python regression: 56 passed, one existing dependency deprecation warning.
- Node frontend/lifecycle checks and HTML equality passed.
- scripts/verify_estimate_batch3.py passed seven synthetic real-provider checks through gemini-3.8-flash (extraction/audit/OCR), exit 0. These verified the retained-granite notice flag with document integration, tile negative case, unmeasured stopping-condition/budget-band clarification, attributed health concerns with healthcare referral, thermal/unverified evidence handling, unsigned open-ended unpriced flooring, and a non-meter OCR fixture. All request text/images were synthetic; no customer PDF material or actual photo readings were submitted and no stored jobs/evidence/signatures/IAM changes were made. These are bounded checks, not a guarantee for all model outputs.
- Browser suite was not repeated for this instruction-only change; prior broad-run and focused-retry results remain recorded above. No client or lifecycle implementation changed.
- Live speech behavior and physical iPhone acceptance remain unobserved. Flash extraction/audit/OCR checks are separate evidence, not proof of deployed Live behavior.
- Not deployed. Proposal template, unit fields, cleaning rates and schema extensions remain separate work. The health PDF itself was not edited.


## Live reliability implementation — October 7, 2026, staged

Implemented the approved core release and retained reviewed voice-to-form entry. Named Charon
voice, the SDK pin, standalone OCR import, prompt organization, compression, private resumption
checkpoints, GoAway/usage/control dispatch, microphone stream-end, immediate media stop with bounded
final drain, transcript segments/deduplication/limit warnings, explicit offline Resume and startup/
late-event guards are in the source. Legacy signed-document pricing/schema are preserved; old drafts
without capture metadata retain their serialized shape. Custom vocabulary and Live tools remain deferred.

Backend revision alert-disaster-field-estimator-00006-yer is deployed with **zero production traffic**,
using the dedicated runtime/build identities, region and 3600-second timeout. Its tag is
https://live-reliable---alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app . Rollback/current-production
pair remains backend 00005-htr and Hosting version 60724bb918512475 / release 1791378004044000
(ui-20261006-6). Hosting has not been changed. The private _live_resume.expire_at TTL policy was enabled
only in the dedicated default database.

Verification completed so far:

- Python: **59 passed**, one existing dependency deprecation warning. Includes standalone backend
  launch, Vertex converter compatibility, checkpoint binding/expiry/stale cleanup, rollover, provider
  resume rejection/fallback, microphone pause and final drain. Finish now acknowledges after cleanup.
- Node: frontend/lifecycle checks, exact split-word concatenation, identity deduplication, explicit
  storage limits and HTML mirror checks passed.
- Initial browser run during implementation: 33 passed, 5 skips, 8 failures. Inconsistent asset versions
  and absent-metadata serialization were corrected; this is not the final acceptance run.
- Direct synthetic Vertex: Charon output 240,962 audio bytes, camera session 137.8 seconds, two
  checkpoint updates and provider resumption accepted. Two input-transcription chunks had no finality
  flags; this release labels an unfinished drain conservatively rather than asserting completeness.
  Natural GoAway was not observed in that short test. All frames/speech were synthetic.
- Tagged backend: health/project/model, anonymous REST denial, invalid Live origin and invalid-token
  rejection passed; these checks created no jobs or permissions.

Authenticated deployment checks are currently gated: automatic approval review rejected a conditional
Service Account Token Creator grant to the project operator on the dedicated runtime account. No IAM
binding was added. A normal existing-Google-OAuth sign-in alternative was attempted without IAM changes,
but Firebase returned HTTP 400 before any synthetic jobs were created. The exact synthetic release
checker is scripts/verify_live_release.py; its public mode ran successfully. No customer content was used.

Final additional evidence:

- Full browser acceptance: **43 passed, 7 explicit Windows WebKit media/offline skips**, exit 0.
  All Chromium workflows passed, including both new protocol-2 capture cases. WebKit skips do not
  establish physical iPhone support.
- Longer direct Vertex check: **545.7 seconds** of camera session, natural GoAway observed, 225,124
  response audio bytes, two checkpoint updates and accepted provider resumption. No transcription
  finality flags were observed. This verifies direct SDK/provider behavior; authenticated deployed
  relay behavior still needs the gated release check.
- The dedicated _live_resume.expire_at TTL policy reports ACTIVE. No IAM grant was added.
- Capture also checks a conservative 550,000-byte UTF-8 budget, leaving room for saved evidence and
  audit metadata rather than relying solely on character limits. Node coverage passed.

Production cutover/Hosting, authenticated scope/OCR/audit/signing restoration and physical
 iPhone/Bluetooth acceptance remain open. The implementation is staged, not a completed rollout.

Final focused browser verification after the capture-budget/status refinement: **2 passed, 2 explicit Windows WebKit skips**, exit 0. The protocol-2 drain/review and explicit offline Resume cases passed in Chromium.


## Normal-sign-in release completion — October 7, 2026, awaiting authentication

The verification helper now accepts a Firebase ID token only through stdin and authenticates
it with the dedicated backend rather than attempting the failed Google Cloud token exchange.
A browser runner uses ordinary Google sign-in with Firebase persistence NONE in an isolated
context; tokens remain in memory, are never printed or placed in command-line arguments, and
no browser authentication state is exported. The missing inspection_id in the verifier's
scope-suggestion request was corrected. Release checks now cover selective review, revision
conflicts, actual Live resumption, Finish checkpoint/lease removal, workbook low/high totals,
signed immutability and private evidence restoration. Synthetic cleanup checks record
ownership and exact evidence prefixes; checkpoint cleanup preserves a successor using an
update-time precondition.

Completed evidence:

- Python regression: **69 passed**, one existing dependency deprecation warning.
- Frontend/lifecycle and HTML equality checks passed.
- Browser regression: **43 passed, 7 explicit Windows WebKit skips**, exit 0 (6.8 minutes).
  The test server also emitted Windows connection-reset diagnostics; no test failed.
- Real Firebase SDK memory-only initialization smoke check passed, without authenticating
  or creating jobs.
- Updated public checker passed against tagged revision 00006-yer, including health,
  anonymous REST denial, invalid Live origin and invalid token.
- Reconfirmed backend 00005-htr receives 100% production traffic; 00006-yer remains tagged
  with zero traffic. Current Hosting release remains 1791378004044000, version 60724bb918512475.
  The verified pair is retained in review-artifacts/live-release-20261007/rollback.json.
- Two interactive test browser sessions closed before Google staff sign-in completed.
  Authenticated staged/prod release checks did not run and no synthetic jobs were created.
  The cause of the interactive window closure has not been determined.
- Authentication authorized domains were inspected only; no domains, IAM roles, accounts,
  database rules or production deployments were changed.

The old iPhone guide's reconnect step now explicitly requires Resume walkthrough after
offline capture stops. Physical iPhone/Bluetooth acceptance remains open. Traffic promotion
and Hosting deployment must wait for successful authenticated staged verification.


## Google sign-in diagnosis - October 7, 2026

Google rejected automated Chrome with "This browser or app may not be secure" before the
password step. The same failure reproduced against direct Google sign-in, independent of
Firebase and the staged API proxy. The normal user Chrome app already had a working staff
session. Repro: review-artifacts/sign-in-debug-20261007/repro-google.js (both normal and
--google-only modes exit 1 at this known failure; no password or token is recorded).

The verifier now launches normal private Chrome and waits for human sign-in before attaching
automation. This avoids automation during Google sign-in; it does not alter Google security
checks. Helper regression and real Firebase memory-only initialization smoke checks passed.
Successful manual sign-in and authenticated staged verification still need to be observed.
No traffic promotion, Hosting release or IAM change has occurred. An automatic approval review
rejected a diagnostic retry of the old Cloud token exchange before it executed; that path was
abandoned in favor of the approved browser Firebase-token approach.

Manual handoff follow-up: after the technician reported sign-in, initialization failed and
temporary-profile deletion raised EPERM, masking the earlier error. No authenticated release
checks ran. Cleanup now explicitly closes the dedicated Chrome instance and preserves the
original result if profile removal fails. A real normal-private-Chrome CDP attachment check
passed with a blank page, and the Firebase memory-only initialization smoke check passed.
A new manual sign-in window is awaiting the handoff; this is not proof of authenticated
verification. Production backend traffic was reconfirmed unchanged (00005-htr at 100%).

Firebase initialization timing regression: the manual handoff exposed an unguarded
Firebase auth call before initializeApp. An anonymous real-SDK check with a controlled
1.5-second configuration delay reproduced the exact app-compat/no-app failure (exit 1).
Readiness predicates now require a registered Firebase app before calling auth. The
--hold runner retains in-memory sign-in after workflow failures and supports retry, so
repairs do not require another Google sign-in. These are verifier changes only.

After the initialization guard, the controlled-delay real Firebase SDK regression passes
(exit 0). Normal private Chrome also initialized the actual dedicated Firebase app successfully
with CDP attachment (one app, anonymous sign-in UI visible). Authenticated staged verification
is still pending the new manual sign-in; production traffic and Hosting remain unchanged.

Private-context handoff regression: staff Google sign-in was observed successfully in the
original tab. Playwright context.newPage opened a default-context tab, which had no private
Firebase session; closing the original destroyed that private context. A real installed
Chrome test with synthetic localStorage reproduced the isolation and passed when the tab
was opened by the original private page. The verifier now uses that method, caches the
Firebase token only in memory before handoff, and retains the original until test-page
authentication is confirmed. Test: node tests/test_manual_handoff.js (passed). No synthetic
release workflow or production deployment has run yet. Blank drafts automatically created
during earlier private sign-ins were not deleted without tracked provenance.

Authenticated staged check progress: ordinary approved staff Google sign-in and memory-only
Firebase authentication passed. The staged API passed review-only extraction, selective
application, revision conflicts, actual Live audio/transcripts, pause/unmute, provider
resumption, Finish checkpoint/lease deletion, non-meter OCR, workbook totals, four documents,
signing and evidence restoration. The staged UI also passed reviewed form filling and
signing. Browser cleanup initially rejected the canonical UUID agreement IDs generated by
the app; cleanup now accepts that exact format, validates all targets before admin calls,
and retains ownership/exact-prefix checks. Focused verifier regression: 17 passed. The
retained in-memory session is repeating checks and cleanup before cutover.


## Dedicated cutover - October 7, 2026, production follow-up pending

Authenticated staged API, Live and browser workflow checks passed, including cleanup after
correcting the browser-generated canonical UUID identifier format. Python: 76 passed (one
existing dependency warning); frontend/lifecycle/HTML mirror checks passed. A full-suite
revocation test initially asserted cleanup after an error event; delaying provider close
reproduced the premature assertion. The test now observes server close before asserting
cleanup; backend code was unchanged. Prior complete browser suite remains 43 passed and
7 explicit Windows WebKit skips for this product source.

Backend 00006-yer was promoted to 100% traffic, then only hosting:alert-disaster was deployed
in alert-disaster-field-2026. Hosting version 0350de7b1566a1b5, live release
1791398669068000, frontend live-reliable-20261007-1. Exact production asset equality, narrow
layout, cache/fonts, dedicated routing, CSP and Google OAuth popup checks passed. The CLI
reported its optional Cloud Functions listing API was disabled; Hosting completed with
exit 0. No API enablement or IAM change was made. The before/after release-pair metadata
is in review-artifacts/live-release-20261007/cutover-before.json and cutover-after.json.

Production synthetic follow-up failed on scope extraction with HTTP 504. The dedicated
Cloud Run request log confirms revision 00006-yer and 55.095592455 seconds latency. The
bounded AI request expired; sign-in and inspection creation had succeeded. Failed-run
synthetic records/evidence were removed. Remaining production workflow checks did not run.
The helper erroneously closed its private session after this production-phase failure;
production command handling now retains authentication on failure just as staged handling
does. A fresh normal browser session is required for the remaining retry. Physical
iPhone/Bluetooth acceptance remains open.


## Production verification completed - October 7, 2026

Normal approved staff Google sign-in succeeded. The token was retained only in memory and
passed over stdin; no credential was printed/exported and no IAM change was made. The
production API check passed read-only scope extraction, selective application and revision
conflicts; non-meter OCR; real protocol-2 audio/transcripts, pause/unmute, provider resumption
and Finish checkpoint/lease deletion; workbook totals ($1,775.00 itemized, $1,775.00-$1,788.90
range); four documents; signing, saved evidence and immutable reopening. The real production
UI at a 390 x 844 viewport passed reviewed/selective form filling, totals, all document tabs,
synthetic signing and restoration. Both runners removed only their tracked synthetic records
and exact evidence prefixes. Logs: review-artifacts/live-release-20261007/production-authenticated.txt
and production-browser-cleanup.txt; screenshot: production-synthetic-mobile.png.

The complete production repeat passed after the earlier 55-second scope timeout. The checker
now allows one explicitly logged retry only for read-only scope extraction, never arbitrary
write replay. Python: 78 passed, one existing dependency warning. Frontend/lifecycle/HTML
mirror checks passed; prior full browser regression remains 43 passed and seven explicit
Windows WebKit skips for the same product source. The initialization-delay and real private
Chrome context/cleanup regressions passed. Windows temporary profile deletion now uses
checked native PowerShell removal and waits for browser shutdown locks. Four earlier closed
private sign-in profiles were removed, the completed verifier was stopped, and the assistant
cleared its retained Firebase credential. Earlier untracked blank sign-in drafts were
preserved rather than deleting records without provenance.

Production remains backend 00006-yer / frontend live-reliable-20261007-1, Hosting version
0350de7b1566a1b5 (release 1791398669068000). The matched prior rollback pair is backend
00005-htr / Hosting version 60724bb918512475 (release 1791378004044000). Before/after resource
metadata and current status are recorded beside the logs. Physical iPhone/Bluetooth,
installed-app/offline behavior and measured device latency remain open. The guided device
check above now includes selective voice-to-form review and five measured response turns.


## Company workspace staging — October 7, 2026

Company authorization, role dashboards, explicit invitations, office coordination, company-branded documents and private sidecar migration are built. Backend `00008-jom` is tagged `workspaces` with zero production traffic. Production retains the matched `00006-yer` / `live-reliable-20261007-1` pair; Hosting was not deployed. The four new indexes are ready. Migration created seven sidecars/membership records, and reconciliation fingerprint checks preserved source records.

The Python suite passed 110 tests; frontend/lifecycle and identical HTML checks passed. Workspace browser checks passed on Chromium/WebKit, including phone layouts, selective role controls, branded signing/reopening and sign-in navigation cleanup. Real Firestore/storage verification passed twelve checks with two synthetic companies and all four policy roles; cleanup deleted its 38 tracked records and signature evidence. Those inputs were synthetic identities, so this does not establish Firebase-authenticated role acceptance, Vertex acceptance or email delivery. The credential-free real Firebase initialization check passed. See `review-artifacts/workspaces-20261007/` and [the workspace release guide](company-workspaces.md).

Resend verified sender and server-only API secret remain unconfigured. Real delivery/acceptance and staged authenticated role workflows must pass before production promotion and isolated Hosting deployment. Physical iPhone/Bluetooth acceptance remains independently open.

## Batch 1 backend release — October 10, 2026

Backend `alert-disaster-field-estimator-00009-ved` was deployed with `scripts/deploy_backend.py --workspaces off --tag legacy-fixes` at zero traffic, then promoted to 100%. Its environment matches `00006-yer` except the explicit `WORKSPACES_ENABLED=false`. Before deployment, 154 Python tests passed on Python 3.11 with the pinned `backend/requirements.txt`. After promotion, `/api/health` through Hosting and the direct service URL reported healthy with workspaces disabled, anonymous `/api/session` returned 401, and no error logs appeared in the first 15 minutes. The frontend remains `live-reliable-20261007-1`. Rollback: `gcloud run services update-traffic alert-disaster-field-estimator --region=us-west2 --project=alert-disaster-field-2026 --to-tags=live-reliable=100`.

Identity Platform public sign-up is disabled (`client.permissions.disabledUserSignup=true`); email/password and Google providers remain enabled.

## Batch 3 backend release — October 11, 2026

Backend `alert-disaster-field-estimator-00011-geb` (master `e7f70e7`) was deployed with `scripts/deploy_backend.py --workspaces off --tag ops-fixes` at zero traffic, then promoted to 100%. It is the first build of the non-root Dockerfile. Its environment, resources and concurrency match `00009-ved`. CI passed on GitHub for Python 3.11 with pinned requirements and for Node. After promotion, `/api/health` through Hosting and the direct service URL reported healthy with workspaces disabled, anonymous `/api/session` returned 401, and no error logs appeared. No structured AI or Live log entries existed yet because no AI feature had been used since the switch; confirm their shape after first use. The frontend remains `live-reliable-20261007-1`. Rollback: `gcloud run services update-traffic alert-disaster-field-estimator --region=us-west2 --project=alert-disaster-field-2026 --to-tags=legacy-fixes=100`.

## Current status — October 12, 2026

**Production (recorded, not rechecked here).** The read-only check recorded in [mobile-usability-repairs.md](mobile-usability-repairs.md) on October 11 found backend `alert-disaster-field-estimator-00013-hup` (tag `harden-fixes`) at 100% traffic with workspaces disabled, and Hosting version `05af952eff367594` / release `1791758723456000` serving frontend `hardening-20261011-1`. This supersedes the `00011-geb` / `live-reliable-20261007-1` pair in the section above as the latest recorded production state. This document does not record the `00012`/`00013` backend or `hardening-20261011-1` Hosting releases themselves; recheck the pair before the next cutover and keep it as the rollback baseline.

**Merged, not deployed.** `master` `5bf0e53` (nnorman100/adr-field-estimator#10) adds the mobile usability repairs 1–3, the WebKit first-install reload fix, Live start that no longer waits on camera preview playback (nnorman100/adr-field-estimator#9), and a CI browser job that runs the Playwright suite in Chromium and Linux WebKit. Asset marker: `mobile-repairs-20261012-1`. CI passed on the merged source (`f1d0f90`/`04067f1`), including WebKit. That job's first Linux WebKit run had exposed four Live failures; their cause and fix are in [mobile-usability-repairs.md](mobile-usability-repairs.md).

**Release gates for this frontend** (from [mobile-usability-repairs.md](mobile-usability-repairs.md)):

1. Confirm the serving backend, then deploy only `hosting:alert-disaster` in `alert-disaster-field-2026`.
2. Authenticated acceptance with normal approved-staff sign-in: `node scripts/verify_live_browser.js --backend-tag harden-fixes --hold`.
3. The guided iPhone acceptance above, now including the camera preview appearing and Live connecting promptly.
4. ADR approval to release repairs 1–3 with the keyboard signature method (repair 4) deferred.

**Still open.** Physical iPhone/Bluetooth acceptance, installed-app/offline behavior and measured sub-second latency (device results not yet provided). Company workspaces remain disabled pending the invitation sender/secret and authenticated role acceptance. Cleaning-only pricing, unit/job linking and a richer task/narrative model remain separate work.
