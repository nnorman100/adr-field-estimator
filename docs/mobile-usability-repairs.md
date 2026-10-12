# Mobile usability repairs (October 11, 2026)

The targeted repairs retain the existing appearance, server-owned pricing, workspace permissions and revision-bound handwritten authorization contract.

## Implemented behavior

- Native validation constraints and messages remain enabled. The first invalid control receives focus and inline native-message feedback; the native popup is suppressed during reporting because WebKit can cover the inline feedback with it. Measured sticky-header/fixed-footer bounds, including the footer's safe-area padding, guide scrolling. ResizeObserver and visualViewport changes recheck the focused control. A constrained viewport lets the header scroll normally without removing persistent footer actions. The scope confirmation uses the same reveal path.
- Room removal opens a native modal identifying the room. Cancel is the initial focus, Escape cancels, and cancellation does not invoke draft invalidation or persistence. Confirmation checks that the same draft/user/local version is still current, removes only that room and retains existing invalidation/persistence. Focus moves to a remaining room name or Add room. Signed room removal stays disabled.
- Signature and document-confirmation errors have adjacent, associated alerts. Correction clears the corresponding error. Save errors stay local with retry-reference guidance; server confirmation remains required for saved/signed status.

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

No production API/physical-device verification, deployment, dependency installation or commit was performed.