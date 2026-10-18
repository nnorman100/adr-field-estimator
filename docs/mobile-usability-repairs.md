# Mobile usability repairs (October 11, 2026)

The targeted repairs retain the existing appearance, server-owned pricing, workspace permissions and revision-bound handwritten authorization contract.

## Implemented behavior

- Native validation constraints and messages remain enabled. The first invalid control receives focus and inline native-message feedback; the native popup is suppressed during reporting because WebKit can cover the inline feedback with it. Measured sticky-header/fixed-footer bounds, including the footer's safe-area padding, guide scrolling. Scrolling happens only when validation jumps to a blocking control; ordinary taps on form fields leave scrolling to the browser's native keyboard handling. A constrained viewport lets the header scroll normally without removing persistent footer actions. The scope confirmation uses the same reveal path.
- Room removal opens a native modal identifying the room. Cancel is the initial focus, Escape cancels, and cancellation does not invoke draft invalidation or persistence. Confirmation checks that the same draft/user/local version is still current, removes only that room and retains existing invalidation/persistence. Focus moves to a remaining room name or Add room. Signed room removal stays disabled.
- Signature and document-confirmation errors have adjacent, associated alerts. Correction clears the corresponding error. Save errors stay local with retry-reference guidance; server confirmation remains required for saved/signed status.

## DryScope header bar and water/mold tags (October 18, 2026)

A navy header bar now sits above the company strip on the login, app and homeowner signing pages and holds the white DryScope lockup with the Help and Account controls; the white strip under it carries only the signed-in company's logo and name and is absent before sign-in. Room cards and the on-screen review are tagged with the words WATER (category 1 or 2) or MOLD (category 3). `tests/browser/help.spec.js`, `mobile-repairs.spec.js`, `auth-race.spec.js`, `workflows.spec.js`, `workspaces.spec.js` and `signing-link.spec.js` assert the bar's height (under 85 px), no horizontal scroll at 320 px and 390 px, the visible Help control inside the bar, the hidden strip before sign-in, the footer line and the tag words; colour is never asserted. Screenshots at 320x844 and 390x844 of the login page, the ADR shell, a tagged room list and the review chips are kept outside the repository with the task evidence (`adr-brand-pr6-header-tags`), as the earlier evidence roots below are.

## Unresolved signature-method decision (repair 4)

No new signature method was implemented. The frontend uses pointer strokes to create `signature_png`; `AuthorizeRequest` requires this PNG plus `documents_confirmed=true`, revision and proposal hash. The server validates ink, checks current signability/company access and stores immutable private image evidence. Saved records restore that image. Adding canvas tabindex alone would not supply a meaningful keyboard signing workflow.

ADR must explicitly approve a keyboard-operable authorization method before its implementation. The decision must specify:

1. Whether ADR accepts a typed electronic signature or another non-handwritten method alongside handwriting.
2. The exact signer-identification and explicit signer-intent/consent wording and required fields.
3. How the accepted method is represented in immutable evidence, rendered in saved/printed documents, and distinguished from historical handwritten signatures.

An approved method requires a versioned frontend/backend contract, validation and tests preserving company access checks, document confirmation, proposal-hash/revision binding, idempotent retries and saved-record restoration. A typed name must not be converted silently into a generated handwriting image. This note makes no legal-compliance or definitive WCAG determination; the essential-handwritten-gesture question requires separate assessment.

## Isolated browser regression

Use `playwright.isolated.config.js` with `ADR_BROWSER_PORT=8876` (after ownership checks) and `ADR_BROWSER_ARTIFACTS` set to an absolute directory outside the repository. The isolated config rejects port 8765 and in-repository output, including symlink targets. Existing screenshots use Playwright output paths; the default browser configuration is retained but was not used for this repair run.

The new `tests/browser/mobile-repairs.spec.js` exercises touch-enabled Chromium/WebKit contexts at 320x844 and 390x844 (plus 450px-height recovery), modal keyboard navigation, repeated validation, wrapped headers, control/error rectangles and hit-testing, cancellation memory/IndexedDB snapshots, signing request suppression/retry identity and immutable signed restoration. It blocks service workers to isolate these UI checks; the separate existing suites retain real service-worker/offline coverage. Synthetic local adapters are not production or physical-device evidence.

## Physical iPhone acceptance still open

- VoiceOver labels, modal announcement/focus trap, field-error announcement and correction.
- Software keyboard, Safari visual viewport, address/year/second-room/scope validation and safe-area footer in portrait/landscape.
- Actual touch handwriting, clearing, document review confirmation, failed-save retry and reopening the saved signature.
- Camera/microphone permission and capture; Bluetooth audio route; interruption and reconnect.
- Finish cleanup of tracks/audio/socket; measured sub-second conversational turnaround.

Emulation cannot close these acceptance items.

## Recorded verification for this repair session

- `python -B -m pytest tests -q -p no:cacheprovider`: 171 passed, two dependency deprecation warnings.
- `npm test`: exit 0, seven PASS groups across the frontend and lifecycle scripts.
- Isolated existing suites: 80 passed, two failed, ten skipped. Failures are Windows WebKit local-draft tests: draft writes counted five rather than at most four, and legacy draft migration did not reach Saved privately within its assertion deadline. No complete existing-suite pass is claimed.
- Focused repair suite with service workers blocked: 44 passed, no skips/failures, and zero page errors asserted. Both engines exercised touch-enabled 320x844/390x844 contexts, keyboard operation and 450px-height recovery. Earlier worker-enabled focused runs had intermittent WebKit local fetch access errors; they remain separate failed evidence, not ignored passes.
- Evidence root: `C:\Users\nnorm\AppData\Local\Temp\adr-ui-repairs-20261011`. Final focused report/artifacts: `focused-no-worker`; existing report/artifacts: `existing-origin-fixed`; logs retain earlier failures and interrupted runs.

No production API/physical-device verification, deployment, dependency installation or commit was performed during that initial repair session.

## Deployment preparation follow-up (October 11, 2026 local / October 12 UTC)

Candidate asset marker: `mobile-repairs-20261011-2`. This is a repairs-only candidate; workspace activation and a new signature method are not included. No production deployment is authorized by this document.

### Failure diagnosis and changes

- The migration fixture reused two globally keyed inspection IDs under a fresh owner on each invocation. A repeated WebKit run against one retained synthetic server reproduced the failure twice: local images restored, but creation was correctly rejected by ownership checks. Both IDs and the owner now use per-run UUIDs; assertions verify remote photos on both the open and queued draft. No ownership checks or assertion deadlines were relaxed. The colliding fixture and persistence paths were already present in source baseline `32ee17c`; this source comparison alone is not a baseline-browser pass claim.
- Immediate saving left the 1500 ms autosave scheduled. A new browser regression observed two sync calls instead of one before the fix. `syncDraft()` now consumes the existing timer **when queued**, never at completion, so subsequent edits can schedule their own save. The regression also verifies later autosave and reload recovery.
- The typing write-budget test previously counted late OCR/setup work. It now awaits photo OCR and an explicit completed save before resetting its counter. Its existing maximum of four draft writes and zero photo-byte rewrites remain unchanged.
- The first full follow-up run exposed a separate startup race: opening Jobs before the initial save completed was undone by late navigation. The trace showed the menu open, then hidden after save completion. A delayed-save regression reproduced it before the fix. New-draft navigation now happens before persistence/network awaits so completion cannot close the menu or change the selected task. The workflow helper also waits for completed authentication startup. The delayed-save test gates `window.fetch` entry, retaining real service-worker coverage; Playwright request routing alone was bypassed intermittently in worker-controlled WebKit runs.
- Auth-race tests now gate the first session request at `window.fetch` entry for the same reason, rather than depending on page routing/response events under service-worker control. An attempted worker-blocked variant caused the expected offline-launch warning and was rejected; final auth tests retain workers and the original no-error assertions.
- Release verification now requires an explicit backend target, restricts tags to the dedicated service, rejects ambiguous/unsafe targets and authenticated redirects, and writes to a fresh external artifact directory. No token is accepted in command-line arguments.
- CI now includes the isolated browser suite and uploads its external report. The new Node target-validation tests are part of `npm test`. The GitHub-hosted Linux job has not run in this local session.

### Follow-up verification

- Python: 226 passed, two dependency deprecation warnings.
- Node: seven existing PASS groups plus five release-target tests passed.
- Repeated complete local-draft suite: 21 passed, three existing Windows WebKit offline-navigation skips, across three runs per engine. The pre-fix repeated migration failures and failing timer regression are retained separately.
- Delayed-startup regression with the final fetch gate: six passed across three repeats per engine. The initial routing-gate variant's failures are retained and are not counted as passes.
- Final complete per-engine browser runs (separate isolated servers, no retries): Chromium 70 passed; WebKit 59 passed, one failed, ten existing skips. Total 129 passed, one failed, ten skipped. The remaining failure is `workspaces.spec.js` other-company branding/signing: after New job, the address stayed hidden. Its trace shows an interrupted inspection POST, a page reload/new session, then local-draft recovery while the dashboard remains visible. Root cause is not established; do not classify it as harmless or claim clean browser acceptance. The original draft failures and signed-recovery menu race passed these final runs.
- Earlier `full` run: 127 passed, one startup-menu failure, ten skips. `full-final` was interrupted to apply the startup fix. `acceptance` finished with 128 passed, two auth-interception failures, ten skips before the final fetch-gate correction. Final per-engine runs supersede these for current-source results, but failed evidence is retained.
- Real Firebase unsigned initialization: passed with the local candidate UI and real SDK using memory-only authentication. This did not sign in, create jobs, invoke model providers, or verify authenticated workflows.
- Public backend/Live verifier: passed health and anonymous API, invalid-origin and invalid-token denials. No valid staff authentication or customer writes were involved.
- HTML copies match; syntax and whitespace checks passed.
- Evidence: `C:\Users\nnorm\AppData\Local\Temp\adr-deploy-ready-20261011` (`repeat-before`, `timer-red`, `repeat-after`, `startup-red`, `startup-fetch-green`, `full`, `acceptance`, `final-chromium`, `final-webkit`, `auth-smoke`, logs and exit files). Do not confuse synthetic local-server checks with real-service acceptance.

### Observed deployed pair and remaining release gates

The observations below are historical; current production is recorded only in [RELEASES.md](../RELEASES.md).

Read-only checks found backend `alert-disaster-field-estimator-00013-hup` at 100% traffic, tagged `harden-fixes`, runtime `adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com`, timeout 3600 seconds. Production health reports the dedicated project/schema 3 and configured models, with workspaces disabled. Hosting and direct backend anonymous session/inspection requests returned 401. These checks establish public routing/configuration only, not successful authenticated API or model execution.

Observed Hosting version: `05af952eff367594`; release: `1791758723456000`; frontend: `hardening-20261011-1`. The same-project `/api/**` rewrite points to the service in `us-west2` without a revision tag. The local candidate is not deployed. Recheck this pair immediately before cutover and retain it as the rollback baseline if unchanged; do not use the older workspace document's historical `00006-yer` pair.

Before release:

1. Diagnose and fix the remaining WebKit workspace/new-job lifecycle failure, then rerun full browser acceptance without masking failures. Review and commit the candidate; run CI on that exact commit. Leave unrelated historical screenshot changes uncommitted.
2. Verify the intended tag still maps to the reviewed dedicated backend. Run `node scripts/verify_live_browser.js --backend-tag body-limits --hold` from the repository root for **normal approved staff sign-in** and local-candidate authenticated acceptance. This step uses real private services and creates tracked synthetic jobs; it was not run during this preparation. Keep credentials out of chat. A different backend candidate requires its own explicitly checked tag and backend-first release.
3. Complete the physical-iPhone checklist above, including installed-app update/offline recovery. Desktop WebKit and emulation cannot close it.
4. Obtain ADR approval for a repairs-1–3-only release with repair 4 explicitly deferred, or approve and implement the versioned keyboard-signature contract separately. Do not silently generate a handwriting image from typed text.
5. Keep `WORKSPACES_ENABLED=false` for this release. The workspace-tag revision is older and invitation sender/secret plus authenticated role/email acceptance remain separate blockers; do not promote that tag as part of this repair.
6. Only after the gates pass and deployment is authorized, deploy **only** `hosting:alert-disaster` in `alert-disaster-field-2026`, with the verified backend already serving. Do not use blanket deployment or treat Hosting previews as data isolation. Recheck asset versions, authenticated workflows and service-worker update behavior; retain the matched rollback pair.

Status at the end of that follow-up: deployment preparation was **incomplete; not cleared for production rollout**. One automated browser failure plus authenticated/device acceptance and signature-scope approval remained. No deployment, cloud configuration mutation, production customer writes, commit or push was performed by that follow-up.

## Authorized release follow-up

The user subsequently authorized commit, push and deployment. That authorization does not establish successful authenticated or physical-device acceptance, or select a new signature contract. Workspaces remain disabled and the existing handwritten signing contract is unchanged.

### WebKit reload diagnosis and repair

- Repeating the unchanged other-company workflow reproduced the failure: four passes, one failure. This was not dismissed as harmless flakiness.
- Instrumented first-install runs identified `public/app.js`'s service-worker `controllerchange` handler as the reload caller. WebKit exposed the first worker as controller before its `installed` callback; the app set `waitingWorker` for that initial installation and then reloaded during activation. An in-flight New job save was interrupted; startup correctly returned the workspace owner to the dashboard, leaving the editor hidden.
- Update detection now captures the controller at `updatefound` and only prompts when it is a distinct existing worker. It no longer classifies the installing worker as its own replacement. Company authorization, dashboard recovery, ownership and signing assertions were not changed.
- New deterministic lifecycle checks cover first-install event ordering without reload and replacement-worker Save & update with draft restoration. Before the fix, Chromium reported one failed first-install test and one passed replacement test. After the fix, both lifecycle checks and the unchanged other-company signing test passed three repetitions on each engine: **18 passed**. These lifecycle event tests use a synthetic worker facade; the existing suites still exercise real service workers.
- Evidence is retained outside the repository at `C:\Users\nnorm\AppData\Local\Temp\adr-release-authorized-20261011`: `workspace-repeat`, `diagnosis.log`, `worker-red`, `worker-green`, and subsequent full-run logs/reports. Earlier failed evidence remains intact.

### Release status

- Final unchanged application/test source: Chromium **72 passed**; WebKit **62 passed, 10 existing skips**. Combined **134 passed, zero failures, 10 skips**, with both process exits zero. These supersede the earlier failed full run without deleting it. Windows server logs include connection-reset diagnostics; no test assertion was waived.
- Final Python: **226 passed**, two dependency warnings. Final Node suites: passed, including five target/artifact tests. HTML mirrors, candidate asset markers (`mobile-repairs-20261011-2`), JavaScript syntax and diff whitespace checks passed; source hashes are retained with external evidence.
- Real-service checks: unsigned real-Firebase initialization passed; public dedicated-backend health and anonymous/invalid Live denials passed. These are not authenticated or physical-device acceptance.
- Read-only production recheck: `00013-hup` / `harden-fixes` still receives 100% traffic; runtime identity and 3600-second timeout are unchanged; health reports workspaces disabled; deployed assets remain `hardening-20261011-1`.
- Review: no blocking implementation or standards issue found. One low-priority maintainability observation concerns duplicated artifact-path validation; it is not a safety failure and was not expanded into an unrelated refactor.

The candidate is ready to commit and push for exact-commit CI. Production rollout remains withheld pending that CI, normal approved-staff authenticated acceptance, physical-iPhone acceptance, and explicit repairs-1–3-only approval deferring repair 4 (or separate approved signature implementation). No deployment, cloud mutation or production customer write was performed. The historical screenshot remains excluded from the candidate.
## Live start no longer waits on the camera preview — October 12, 2026

The first Linux WebKit CI run failed four Live tests: `startWalk` awaited `cameraVideo.play()`, which never settled for the synthetic stream, so Live stayed "Not connected" with no message and a disabled Start button. A temporary CI probe confirmed `play()` was the only stalled step; resume, worklet loading and the microphone graph succeeded. Live start now begins preview playback without waiting for it, hides the placeholder once playback starts and reports a rejected preview while voice guidance continues. Video frames were already skipped until the preview has dimensions. Asset marker: `mobile-repairs-20261012-1`. Not deployed.
