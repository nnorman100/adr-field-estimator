# ADR field estimator UI review

| Field | Value |
| --- | --- |
| Date | October 6, 2026 |
| Live app | https://alert-disaster-field-2026.web.app/ |
| Sessions | `adr-ui-review`, `adr-ui-fixture` |
| Scope | Visual design and field workflow; desktop 1440×1000, mobile 390×844 and 320×740 |
| Method | agent-browser inspection, screenshots and rendered layout measurements. Signed-in states use the existing local synthetic browser harness, without customer records. |

## Summary

**Baseline: 6 medium-severity UI/UX findings; 0 critical, 0 high, 0 low.** The findings and original screenshots below describe the pre-redesign app. The approved implementation and verification are recorded at the end of this report.

**Current pricing correction:** The package-tier amounts mentioned in historical findings and the first UI release were not present in the user's estimating sheet. Release `ui-20261006-5` replaced them with the workbook's low–high estimate range. See the final section and [pricing source notes](../../docs/pricing-source.md).

## Findings

### ISSUE-001: Mobile walkthrough is buried below the scope form

**Severity:** Medium · **Category:** UX/layout · **Repro video:** N/A (static layout)

Open the live app at 390×844. Property, pricing, scope flags, equipment and notes precede the camera. The walkthrough card starts approximately **1,370 px** below the page top even before a signed-in room is displayed. There is no section navigation or persistent Capture action. A technician must scroll through estimating fields before reaching the app's main field function.

**Recommendation:** Use task navigation for Property, Walkthrough, Evidence and Review. Put Start walkthrough within the first mobile screen after property setup, and preserve the current room/capture action while working.

**Evidence:** [Mobile entry](screenshots/mobile-entry.png), [desktop entry](screenshots/desktop-entry.png). Rendered measurements were taken at scroll position zero.

### ISSUE-002: Mobile typography and control layout are too small

**Severity:** Medium · **Category:** Readability/accessibility · **Repro video:** N/A (static layout)

At 390 px width, capture button text is **11.25 px**, connection/photo status is **10.8 px**, and explanatory text is **11.4 px**. Four capture controls share one row; Start walkthrough, Mute microphone and Color emulation wrap onto two lines. Most standard buttons are 42 px high, below the recommended 44–48 px design target for this touch-heavy field app. These are usability concerns, not a claim that all controls fail a WCAG minimum.

**Recommendation:** Use 14–16 px action/status text, 16 px body text, and 48 px primary capture targets. Give Start/Stop and Capture distinct rows; move optional emulation into a secondary menu.

**Evidence:** [Mobile entry](screenshots/mobile-entry.png); capture-screen evidence is added below. Measurements are from rendered styles and element bounds.

Signed-in measurements strengthen ISSUE-001: the walkthrough starts at **1,756 px** and Start walkthrough at **2,024 px**, roughly 2.4 viewport heights from the top. [Signed-in mobile entry](screenshots/mobile-authenticated-top.png), [capture controls](screenshots/mobile-capture.png).

### ISSUE-003: The header competes with the inspection and breaks down on narrow screens

**Severity:** Medium · **Category:** Visual/layout · **Repro video:** N/A (static layout)

The masthead combines logo, app title, license, emergency sales phone, account message and authentication control. At 390 px it consumes 140 px; at 320 px it grows to **241 px**, nearly one-third of a 740 px viewport. A second company/service strip and a separate job bar add more chrome before the first field. The prominent emergency phone is aimed at customers, while this screen is for technicians.

At 320 px, “Sign in to start an inspection” wraps into a near-vertical column of letters/short fragments between the phone and sign-in button. The package selector is only **121 px** wide and truncates its default label. The page has no horizontal overflow, but that does not mean its content remains usable.

**Recommendation:** Keep a compact logo, current inspection and account menu in one app header. Move company/service information and phone to a contact/help panel. On mobile, let job status and task navigation carry the hierarchy.

**Evidence:** [390 px entry](screenshots/mobile-entry.png), [320 px entry](screenshots/narrow-mobile-entry.png), [desktop entry](screenshots/desktop-entry.png).

### ISSUE-004: The idle camera is oversized and controls lack state hierarchy

**Severity:** Medium · **Category:** Visual/UX · **Repro video:** N/A (static idle state)

On desktop, a large dark camera placeholder dominates the right column before capture starts. Start, Stop, Mute microphone, Color emulation, Capture still and Camera / upload are all shown simultaneously. Stop and Mute appear available even while the status says Not connected. Optional emulation receives similar visual treatment to core evidence capture. The idle screen offers many controls without clarifying which action is valid next.

**Recommendation:** Use a compact start/upload empty state, expand the viewfinder when active, and make controls reflect connection/camera state. Separate live session controls from photo capture and put emulation under secondary options.

**Evidence:** [Signed-in desktop](screenshots/desktop-authenticated.png), [mobile capture](screenshots/mobile-capture.png). This finding concerns presentation and affordances; it does not claim the backend accepts unauthorized actions.

### ISSUE-005: Mandatory document navigation is partially hidden on mobile

**Severity:** Medium · **Category:** UX/layout · **Repro video:** N/A (static document state)

After generating a synthetic audit, the document navigation is **414 px wide inside a 322 px viewport**. Photo audit log begins at x=345 and ends at x=448 on a 390 px screen; only its left edge is initially visible. All four documents must be reviewed, but the navigation provides no explicit overflow cue or review progression. Three export buttons stack above the tabs, consuming substantial vertical space before the content.

**Recommendation:** Display all four document choices in a readable two-column grid or a document selector with clear position/count. Give document review precedence over export controls; group export actions in one menu. Keep signing available after document review without relying on a hidden tab to imply completeness.

**Reproduce:** In the local synthetic harness, enter address “Synthetic UI review property,” year 2000, package $1,999, room Bathroom, finished area 10 SF, and confirm scope. Finish & audit, then view the document navigation at 390×844. No signature is submitted.

**Evidence:** [Document navigation](screenshots/mobile-document-navigation.png), [itemized tab](screenshots/mobile-itemized-claim.png), [desktop document layout](screenshots/desktop-documents.png).

### ISSUE-006: The mobile itemized table is compressed beyond comfortable reading

**Severity:** Medium · **Category:** Readability/layout · **Repro video:** N/A (static claim state)

The five-column itemized claim is squeezed into **322 px**. “Quantity” wraps as “Quan / tity,” “Waste” as “Wa / ste,” and descriptions break into many short lines while the numeric columns remain narrow. This technically fits the screen but is difficult to scan and compare during homeowner review. The desktop-oriented table has not been adapted to mobile use.

**Recommendation:** Use mobile line-item cards with description, quantity × rate, waste and a prominent row total. Keep the conventional table for desktop and printing. Keep ADR package and itemized totals visibly separate in a concise review summary.

**Reproduce:** Prepare the same synthetic audit as ISSUE-005, then choose Itemized claim at 390×844.

**Evidence:** [Mobile itemized claim](screenshots/mobile-itemized-claim.png), [document navigation/table](screenshots/mobile-document-navigation.png).

## Recommended redesign direction

Preserve the official ADR logo, red/white/gray palette and offline local assets. Replace the long single-page presentation with clear tasks: **Property → Walkthrough → Evidence → Review**. Scope confirmation and pricing remain required before audit/signing, while field capture is easy to reach earlier. Use a compact mobile header, readable type, larger primary controls, state-aware camera actions, a visible current room and persistent draft/save status. Put package and itemized totals side by side with explicit labels; show all four review documents without hidden navigation. Keep serif typography for documents and Lato for app controls.

This is a structural redesign; another palette or font substitution alone will not resolve these findings.

## Review limits and positives

- Live production was inspected without signing into customer data. Authenticated scope/document states were exercised in the existing local fake-cloud harness. Fixture AI text intentionally contains an injection test string; it is not a production-content finding.
- These are browser viewport checks, not a physical iPhone acceptance test. Desktop is 1440×1000, main mobile is 390×844, narrow mobile is 320×740.
- Browser error/console checks returned no application exceptions during the observed states. Recording was unavailable because the CLI's ffmpeg dependency is missing; the six findings are static visual states with screenshot evidence. The recording setup also reset the synthetic session, so that transition is excluded from findings.
- The logo loads, branded fonts render, the main page avoids horizontal overflow, and package/itemized totals are labeled separately. These should be retained.
- No application code or deployed resources were changed during this review.

## Approved implementation — October 6, 2026

| Finding | Implementation |
| --- | --- |
| ISSUE-001 | Persistent Property, Walkthrough, Evidence and Review task navigation. Each task has its own view; draft/save actions stay available at the bottom. Scope validation routes back to the property form when correction is required. |
| ISSUE-002 | 15–16 px capture labels, 14 px status/helper text, 48 px action targets, separate session/photo control rows and a full-width primary Start action on mobile. |
| ISSUE-003 | Compact official-logo masthead; company/contact/sign-out details under Account and saved-job actions under Jobs. Header measures 65 px at 320 px width; no vertical sign-in text fragments. |
| ISSUE-004 | Compact, light idle camera state; viewfinder expands during capture. Stop/Mute appear only with an active stream; native still capture is disabled until a stream exists, while Camera / upload remains available. Emulation is under Camera options and is cleared on Stop. |
| ISSUE-005 | All four document choices fit a two-column mobile grid. Review shows clearly separate package/itemized totals and a truthful count of documents opened. Copy/download/print actions are grouped under Export. |
| ISSUE-006 | Mobile claim cards show description, quantity × rate, waste and row total. Desktop/print retain the table. |

The implementation also prevents pagehide from re-saving a draft during logout after IndexedDB has been cleared. Updates preserve drafts and use a compact floating prompt. Print rendering excludes invalidated documents and preserves the four-document layout. Document-opening counts are navigation feedback, not proof the technician has read or approved them; the explicit review confirmation is still required.

Local preview evidence: [320 px walkthrough](../redesigned-narrow-preview.png), [390 px walkthrough](../redesigned-walkthrough-preview.png), [desktop walkthrough](../redesigned-desktop-walkthrough-preview.png), [mobile claim cards](../redesigned-mobile-claim.png). Browser layout checks place the Start action on the first screen rather than 2,024 px down the original page. All four synthetic Letter pages were visually inspected in `review-artifacts/redesigned-print-1.png` through `redesigned-print-4.png`.

### Final verification and deployment

Release **`ui-20261006-3`** was deployed only to `hosting:alert-disaster` in `alert-disaster-field-2026`. All six findings are implemented and verified in supported browser/print checks.

- **27 Python tests passed**, plus Node currency/HTML-mirror/audio-conversion/resource-teardown checks.
- **19 browser tests passed; 3 explicitly skipped**. Chromium and WebKit cover the task navigation, 320/390 px layouts, all four visible document choices, mobile claim cards, safe text rendering, signing/restoration/invalidation, permissions, photo evidence, printing, conflicts, updates and logout. Chromium also covers active synthetic Live controls/track teardown and real offline recovery. Windows WebKit lacks Web Audio in this build; its two existing real-offline navigation cases also remain excluded. Physical iPhone audio/Bluetooth/offline acceptance is still open.
- Four generated Letter pages were visually inspected. The synthetic print fixture is not a customer agreement.
- Production checks passed exact HTML/asset equality, dedicated Firebase/schema-2 backend routing, anonymous API denial, local fonts/offline brand cache, no horizontal mobile overflow, a 65 px masthead, first-screen capture placement and real Google OAuth. agent-browser reported no page errors.
- Live evidence: [320 px entry](../redesigned-live-entry-320.png), [320 px walkthrough](../redesigned-live-walkthrough-320.png), [390 px walkthrough](../redesigned-live-mobile.png), [desktop walkthrough](../redesigned-live-desktop.png).

Use **Save & update** when an installed app offers the new version. The update action retains the private draft. Device acceptance remains open; these browser checks do not establish physical iPhone camera, microphone or Bluetooth behavior.

### Update delivery correction — October 6, 2026

After release `ui-20261006-3`, the user reported the design still looked unchanged. The live dedicated site served the redesigned HTML, but both `/` and `/index.html` returned `Cache-Control: max-age=3600`. A browser could therefore reuse the old app shell for up to an hour, even after a refresh. The old open app also checked for a new service worker only at initial registration.

Release **`ui-20261006-4`** sets `Cache-Control: no-store` for both entry URLs, the manifest and worker; checks for worker updates when the app regains focus or visibility and every five minutes while open; and shows the app version under Account. The versioned direct link `https://alert-disaster-field-2026.web.app/?v=ui-20261006-4` bypasses an already-cached older entry URL. The user may also be viewing `alertdisaster.com`, which is the separate public marketing site; the viewing address has been requested and is not yet confirmed.

The live hosting check was red before this correction with `The app shell can stay stale in a browser: /`. After deployment to the dedicated hosting target only, it passed exact asset checks, `no-store` on both entry URLs, mobile layout and OAuth initialization. The installed-worker update test passed in Chromium and WebKit and retained the draft. Physical iPhone behavior remains open pending a device test.

### Pricing correction to the reviewed UI — October 6, 2026

After the UI release, the user supplied the actual water/mold estimating sheet and confirmed that ADR does not use the package tiers shown in the initial review. Release `ui-20261006-5` removes that selector. Review now shows the workbook's low–high customer estimate and itemized base-rate charges; the range cards stack on narrow mobile screens. Optional workbook charges sit under the Property form's sheet-charge disclosure. Legacy signed jobs retain their original presentation. The user confirmed the sheet's $47.46/hr added-labor formula for after-hours estimates. The pricing evidence, exact source cells, test results and dedicated deployment are recorded in [pricing source notes](../../docs/pricing-source.md) and [repair status](../../docs/review-repairs.md).
