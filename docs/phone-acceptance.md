# Phone & Device Acceptance Guide

This document defines the physical device acceptance criteria and provides an owner-executable phone-check script for **DryScope**.

Physical phone observations are non-negotiable acceptance gates: automated unit tests, Playwright browser runs, and synthetic service checks cannot prove microphone/camera hardware release, Bluetooth earpiece routing, WebKit viewport behaviors, cellular-to-Wi-Fi handoffs, or sub-second conversational latency.

---

## 1. Device Matrix

Every release milestone must be verified on physical hardware across the following target matrix before being marked phone-checked.

| Target Class | Hardware Specification | OS / Runtime | Primary Browser / Shell | Purpose & Minimum Requirements |
|---|---|---|---|---|
| **Oldest Supported iPhone** | iPhone 8, iPhone 8 Plus, iPhone X, or iPhone SE (2nd gen) / XR in actual company use | **iOS 16.4** or newer (iOS 16.7.x for iPhone 8/X) | Mobile Safari & Home Screen PWA | **Baseline Web Standards Floor.** iOS 16.4+ is required for Tailwind v4 CSS compatibility, Web Push API, and modern WebKit service-worker cache boundaries. Must handle Web Audio resampling and camera streams without thermal crashing. |
| **Current Modern iPhone** | iPhone 14, 15, or 16 series | **iOS 17.x / 18.x** | Mobile Safari & Home Screen PWA | **Primary Field Target.** Validates dynamic island / notch viewports, WebKit full-screen camera handling, Bluetooth 5.3 audio route handoffs, and fastest-case Live conversational latency. |
| **Android Reference** | Google Pixel (6 or newer) or Samsung Galaxy (S22 or newer) | **Android 13** or newer | Google Chrome Mobile (Chromium 120+) | **Cross-Platform Baseline.** Verifies native Chromium PWA lifecycle, Wi-Fi detection for automatic original photo background upload, and cross-platform responsive layout. |

---

## 2. Tested Browsers & Shells

1. **Mobile Safari (iOS WebKit)**:
   - Primary browser for link openers (homeowner remote signing `/sign` and document viewer `/documents`).
   - Handles OAuth popups without third-party cookie restrictions or storage access blocking.
2. **Standalone iOS PWA ("Add to Home Screen")**:
   - The primary daily driver for field estimators.
   - Must run in `standalone` display mode without Safari navigation bars or toolbars.
   - Service worker caches the application shell for cold launches without signal.
3. **Chrome Mobile (Android Chromium)**:
   - Standalone installed Web App and standard browser tab.
   - Supports `navigator.connection.type === 'wifi'` for silent photo original queue drainage.

---

## 3. Network Conditions

Physical checks must test four distinct connectivity states:

1. **Nominal Online (High-Speed Wi-Fi / 5G)**:
   - Standard low-latency network (<50 ms round trip).
   - Baseline for Live audio/video streaming, instant draft synchronization, and REST document generation.
2. **Weak Signal / Shielded Environment (Packet Lag > 0.6s)**:
   - Real-world loss environments: basements, metal buildings, remote or congested cellular cells.
   - Live relay throttles video frames when client audio acknowledgement is >0.6 s behind.
   - Application displays: `"Weak signal: video paused, voice may be delayed"`.
   - After 25 seconds of continuous weak signal, prompts: `"Switch to offline notes"`.
3. **Fully Offline (Airplane Mode / Dead Zone)**:
   - Radio disabled. Service worker serves the cached application shell.
   - Draft edits and observations save locally to IndexedDB with status `"Saved on phone · sync pending"`.
   - Photos and audio notes queue in IndexedDB.
   - Remote AI operations (Live walkthrough, audit, scope fill, signing link) are cleanly disabled with plain-English notices.
4. **Network Transitions & Reconnection**:
   - Toggling Airplane mode off or walking out of a basement into Wi-Fi/cellular coverage.
   - Automatic background drain of queued photos and draft revisions without duplicate uploads.
   - Re-established Live connections resume via server lease without replaying historical audio.

---

## 4. How to Run & Report These Checks

- **Owner Execution**: Matthew Myers (or designated company lead) executes these scripts on physical hardware.
- **Strictly Synthetic Data**: Never run phone checks on active customer claims or real homeowner addresses. Use addresses like `123 Synthetic Lane, Bakersfield, CA 93308` and customer name `Synthetic Homeowner`.
- **Stop-and-Report Rule**: If any numbered step fails or displays an unexpected error, **STOP immediately**. Record:
  1. Phone model and exact OS version (e.g., *iPhone 11, iOS 16.6.1*).
  2. Browser mode (*Safari tab* vs *Installed Home Screen PWA*).
  3. Network condition (*Wi-Fi*, *5G*, *Basement cellular*, *Airplane mode*).
  4. Bluetooth device (*AirPods Pro*, *Plantronics Voyager*, *None*).
  5. The exact visible error message or unexpected behavior.
- **Applicability Markers**:
  - `[Today's App]`: Applies to the current serving production application (Python backend, classic DOM frontend).
  - `[Rebuilt App]`: Applies to the all-TypeScript Next.js / Cloud Run rebuilt application.
  - `[Both]`: Core business or regulatory rule that applies identically across both versions.

---

## 5. Numbered Owner Phone-Check Script

### Group 1: Sign-in & Authentication

#### Check 1.1: Signed-out Landing & Sign-in Screen
- **Applies to**: `[Both]`
- **Setup**: Open the app URL (`https://alert-disaster-field-2026.web.app/`) in a private/incognito Safari tab while signed out.
- **Steps**:
  1. Navigate to `/`.
  2. Verify the landing screen displays marketing text (`"Water & mold loss estimates, signed on site."`), Log in link, and no internal draft forms or workspace headers.
  3. Tap **Log in** to reach the sign-in form at `/app`.
  4. Verify the card presents **Email**, **Password**, **Sign in**, **Forgot password**, and **Sign in with Google**.
- **Expected Result**: Clean mobile login layout with no horizontal overflow, no exposed customer data, and clear input fields.
- **Report**: Any visual clipping, misaligned buttons, or console errors.

#### Check 1.2: Password Reset Confirmation
- **Applies to**: `[Both]`
- **Setup**: On the sign-in screen at `/app`.
- **Steps**:
  1. Enter `synthetic-reset@example.invalid` into the **Email** field.
  2. Tap **Forgot password**.
  3. Verify a confirmation dialog appears: `"Send a password reset link to synthetic-reset@example.invalid?"` with **Cancel** focused.
  4. Tap **Cancel**; verify no reset message is shown.
  5. Tap **Forgot password** again and tap **Send reset link**.
- **Expected Result**: Status text appears: `"If an account uses synthetic-reset@example.invalid, a password reset email is on its way."`
- **Report**: Exact status text shown; confirm no user enumeration error occurs.

#### Check 1.3: Google Sign-in OAuth Popup
- **Applies to**: `[Both]`
- **Setup**: On the sign-in screen on an iPhone in Safari.
- **Steps**:
  1. Tap **Sign in with Google**.
  2. Observe the Google authentication popup.
- **Expected Result**: The popup opens directly under `alert-disaster-field-2026.web.app/__/auth/handler` without third-party storage partitioning errors, cross-site tracking warnings, or stuck blank screens. Completes sign-in and redirects to `/app`.
- **Report**: Any blocked popups, cross-origin warnings, or redirect loops.

#### Check 1.4: PWA Installation ("Add to Home Screen")
- **Applies to**: `[Both]`
- **Setup**: Safari on iPhone signed into an active estimator account.
- **Steps**:
  1. In Safari, tap the **Share** button (box with upward arrow).
  2. Tap **Add to Home Screen**.
  3. Inspect the suggested name and app icon.
  4. Tap **Add** and open the app from the iOS Home Screen.
- **Expected Result**:
  - The suggested app name is exactly **DryScope**.
  - The icon displays the official red/navy DryScope logo.
  - The launched PWA runs standalone (no Safari URL bar at top, no bottom browser navigation bar).
- **Report**: Icon clarity, exact app label on home screen, and whether browser chrome is completely hidden.

#### Check 1.5: Multi-Tenant / Company Isolation Enforcement
- **Applies to**: `[Rebuilt App]` (Company Workspaces / Stage S3)
- **Setup**: Two separate test companies created in the system (Company A and Company B).
- **Steps**:
  1. Sign in as an estimator belonging only to Company B.
  2. Attempt to view the URL of a known draft belonging to Company A.
- **Expected Result**: The app returns an explicit `403 Forbidden` or `404 Not Found`. Company A's customer names, job addresses, and photos never leak into Company B's job lists or memory.
- **Report**: Confirm zero data leakage between distinct company workspaces.

---

### Group 2: New Job & Coordination

#### Check 2.1: Start New Job & Fixed-Height Header
- **Applies to**: `[Both]`
- **Setup**: Signed in on iPhone as an estimator.
- **Steps**:
  1. On the dashboard, tap **+ New job** (or open the menu and tap **New inspection**).
  2. Observe the top navy header.
  3. Type characters into the address field, delete them, and watch the save status badge.
- **Expected Result**:
  - A new inspection opens immediately on **1. Walk & Photo**.
  - The header save status cycles cleanly: `"Saved on phone · sync pending"` → `"Saving…"` → `"Saved"`.
  - The one-row navy header maintains a **strictly fixed height**; the page does not jump or shudder vertically when status text changes.
- **Report**: Any vertical header jumping, layout shift, or lag during auto-save cycling.

#### Check 2.2: Job Coordination & Customer Details
- **Applies to**: `[Both]`
- **Setup**: Open the newly created draft.
- **Steps**:
  1. Navigate to **Job coordination** (under **More** or top tabs).
  2. Enter:
     - Customer Name: `Synthetic Homeowner`
     - Phone: `(661) 555-0199`
     - Email: `synthetic@example.invalid`
  3. Tap **Save coordination**.
- **Expected Result**: Green/navy confirmation badge: `"Coordination saved."`. The customer name updates in the header and reflects across all subsequent document views.
- **Report**: Exact confirmation message and responsiveness of the save action.

#### Check 2.3: Year Built & California 1978 Pre-Test Rule
- **Applies to**: `[Both]`
- **Setup**: In the draft's **Property & Scope** / **Check Scope** section.
- **Steps**:
  1. Set **Year built** to `1972` (pre-1978). Save scope.
  2. Generate or preview the documents. Observe the proposal and findings.
  3. Change **Year built** to `1985` (post-1978). Save scope.
  4. Preview the documents again.
- **Expected Result**:
  - For `1972`: Proposal findings must explicitly include: `"(this does not include the pretest for lead/asbestos)"` and state: *"Due to property age (1972), California State Law requires third-party lead and asbestos testing prior to destructive demolition."*
  - For `1985`: Pre-testing requirement is omitted; states no pre-testing is required.
- **Report**: Verify exact California compliance text appears verbatim for pre-1978 structures.

#### Check 2.4: Office-Created Job Handoff to Field Estimator
- **Applies to**: `[Rebuilt App]` (S1 R8 Field Ownership Rule)
- **Setup**: Job initiated by an Office user with empty scope, assigned to Field Estimator.
- **Steps**:
  1. Open the job on the Field Estimator's phone.
  2. Field Estimator adds the first room or captures the first walkthrough photo.
- **Expected Result**:
  - Field Estimator is automatically stamped as the exclusive **Field Owner** for that draft.
  - Office retains edit rights for customer details/coordination, but cannot overwrite field measurements or room findings.
- **Report**: Confirmation that field ownership transfers cleanly on first physical capture.

---

### Group 3: Rooms & Photos Offline then Reconnect

#### Check 3.1: Room Setup & Dimension Entry
- **Applies to**: `[Both]`
- **Setup**: On the draft's **Property & Scope** / **Walk & Photo** view.
- **Steps**:
  1. Tap the default room chip and rename it to `Bathroom`.
  2. Set Water Category to `Category 1`.
  3. Tap **Finished Drywall Demolition SF** input.
- **Expected Result**:
  - Tapping the numeric field automatically highlights existing `0` and displays the iOS numeric keypad.
  - Typing `10` sets `10`, not `010`.
- **Report**: Confirm numeric keypad appears immediately without requiring manual backspacing of `0`.

#### Check 3.2: Native Camera Capture & Room Tagging
- **Applies to**: `[Both]`
- **Setup**: On iPhone with camera permissions granted.
- **Steps**:
  1. Tap **Capture photo** to launch the native camera.
  2. Capture a portrait-orientation photo of a wall/floor area.
  3. Tap **Use Photo**.
  4. In the photo strip below, tap **+ Room**, name it `Hallway`, and reassign the photo to `Hallway`.
- **Expected Result**:
  - Photo preview renders in crisp native portrait ratio (not stretched, squashed, or rotated).
  - Shows capture timestamp, room tag (`Hallway`), and GPS recognition badge if location is enabled.
- **Report**: Any image distortion, orientation flipping, or failed room reassignment.

#### Check 3.3: Offline Capture in Airplane Mode
- **Applies to**: `[Both]`
- **Setup**: In the active draft with photos captured.
- **Steps**:
  1. Swipe down iOS Control Center and enable **Airplane Mode** (disable Wi-Fi and Cellular).
  2. Return to the app. Add a new room `Kitchen`.
  3. Capture a photo using **Capture photo**.
  4. Enter 50 SF drywall demolition in Kitchen.
  5. Close the PWA completely (swipe up to kill from iOS App Switcher) and reopen it from the Home Screen while still in Airplane Mode.
- **Expected Result**:
  - App shell opens instantly from service worker cache.
  - `Kitchen`, the 50 SF measurement, and the offline photo remain intact in IndexedDB.
  - Header displays: `"Saved on phone · sync pending"`.
  - Remote AI actions (Live assistant, AI audit) show offline disabled state.
- **Report**: Confirm zero data loss after cold app restart with no signal.

#### Check 3.4: Reconnection & Dual-Payload Photo Upload
- **Applies to**: `[Both]` (Photo dual-payload #223 / S6)
- **Steps**:
  1. With the offline draft open, disable **Airplane Mode** (re-enable Wi-Fi).
  2. Watch the header status badge and the photo strip.
- **Expected Result**:
  - Header updates: `"Saving…"` → `"Saved"`.
  - The 2,560 px web-ready image uploads immediately.
  - On Wi-Fi, the uncompressed native camera original uploads in the background (or shows `"Upload originals now (use Wi-Fi)"`).
  - No duplicate photos appear in the inspection record or photo log.
- **Report**: Time to full synchronization; confirm each photo exists exactly once with its verified receipt.

#### Check 3.5: Offline Voice Notes & Mid-Recording Screen Lock
- **Applies to**: `[Both]`
- **Setup**: Airplane mode enabled on a job.
- **Steps**:
  1. Tap **Record voice note** (under offline walkthrough options).
  2. Begin speaking: *"Kitchen, Category two water loss. Baseboards removed, standing water under sink."*
  3. While recording at the 20-second mark, **press the iPhone Power button to lock the screen**.
  4. Wait 10 seconds. Unlock the phone via FaceID.
  5. Stop the recording.
  6. Re-enable Wi-Fi.
- **Expected Result**:
  - The voice note survives the screen lock without audio corruption or browser crash.
  - Upon reconnection, note is transcribed into the walkthrough transcript tagged as `transcribed later`.
  - Scope suggestions extract the Kitchen Category 2 observations.
- **Report**: Behavior during screen lock (did recording pause or continue?), audio playback quality, and transcription fidelity.

---

### Group 4: Live Voice with Bluetooth & Camera Walkthrough

#### Check 4.1: Audio Routing & Bluetooth Earpiece Integration
- **Applies to**: `[Both]`
- **Setup**: iPhone connected to a Bluetooth headset (e.g., AirPods, Plantronics) recognized by iOS as active audio output and input.
- **Steps**:
  1. Open a new draft and navigate to **1. Walk & Photo**.
  2. Tap **Start walkthrough**. Allow microphone and camera permissions.
  3. Confirm the connection status reads `"Live AI connected"`.
  4. Speak through the Bluetooth earpiece mic.
- **Expected Result**:
  - Assistant audio plays directly into the Bluetooth earpiece, not the iPhone speakerphone.
  - Technician voice is captured cleanly by the Bluetooth microphone at 16 kHz PCM mono.
- **Report**: Headset model used, audio routing stability, and absence of echo or screeching feedback.

#### Check 4.2: Assistant First-Turn Greeting & Two-Way Dialogue
- **Applies to**: `[Both]`
- **Steps**:
  1. Observe the assistant immediately upon `"Live AI connected"`.
  2. Confirm the assistant **speaks first** with a brief professional greeting without waiting for technician speech.
  3. Say: *"Bathroom, category one. I measured ten square feet of finished drywall demolition and zero square feet of unfinished demolition. Use three fans and one dehumidifier for three days."*
  4. Observe the on-screen live transcript.
- **Expected Result**:
  - The greeting plays clearly.
  - The assistant prompt text is kept out of **Technician observations**.
  - Technician speech and assistant responses render in distinct, separated transcript bubbles.
- **Report**: Wording of the opening greeting; confirm assistant asked for missing scope items.

#### Check 4.3: Real-Time Video Stream & Interruption Flush
- **Applies to**: `[Both]`
- **Steps**:
  1. Aim the camera around the room during conversation.
  2. While the assistant is actively speaking an answer, interrupt firmly: *"Stop, let's switch to the bedroom."*
- **Expected Result**:
  - Camera sends one 640 px JPEG frame every 2 seconds behind microphone audio.
  - Assistant instantly **stops audio playback** upon interruption (sub-200 ms cutoff).
  - Outdated unplayed audio buffer is completely flushed; assistant acknowledges the bedroom pivot.
- **Report**: Responsiveness of speech interruption; confirm no buffered leftover sentences played after speaking.

#### Check 4.4: Weak Signal Behavior & Throttling
- **Applies to**: `[Both]`
- **Setup**: Walk into a basement or partially shielded area where cellular signal drops to 1 bar, or throttle connection.
- **Steps**:
  1. Continue speaking to the assistant while network lag exceeds 0.6 seconds.
  2. Observe the HUD status indicator.
  3. Remain in the weak signal area for 30 seconds.
- **Expected Result**:
  - Status changes to: `"Weak signal: video paused, voice may be delayed"`.
  - Video stream pauses automatically to preserve critical voice bandwidth.
  - Two-way voice continues without socket disconnect.
  - At 25 seconds of continuous weak signal, button appears: **Switch to offline notes**.
- **Report**: Did video pause gracefully? Did voice drop or stutter? Did the offline notes prompt appear at ~25 seconds?

#### Check 4.5: Sub-Second Conversational Latency Benchmark
- **Applies to**: `[Both]`
- **Setup**: Good signal condition; Bluetooth connected.
- **Steps**:
  1. Ask 5 distinct, concise field questions (e.g., *"What is the minimum dehumidifier capacity for Category 1?"*, *"Did you record ten square feet?"*).
  2. For each question, record the exact elapsed time between the end of technician speech and the first audible sound of assistant reply.
- **Expected Result**: Target turnaround is **sub-second (<1.0 s)**; conversational turnaround should feel natural in the earpiece.
- **Report**: Record all 5 measured latencies in seconds (e.g., 0.85s, 0.92s, 1.10s, 0.78s, 0.88s) and the measurement method.

#### Check 4.6: Finish & Teardown Cleanliness
- **Applies to**: `[Both]`
- **Steps**:
  1. Tap **Finish & review**.
  2. Observe iOS hardware indicators (green camera dot and orange microphone dot at the top of the iPhone screen).
- **Expected Result**:
  - Live session closes immediately.
  - Both camera and microphone hardware indicators **disappear within 1 second**.
  - AudioContext is cleanly closed; sticky header height does not jump.
  - Cloud Run Live lease is released.
- **Report**: Confirm green/orange hardware indicator dots extinguish immediately upon tapping Finish.

---

### Group 5: Pricing, Price Books & Brackets with Pricing Switch States

#### Check 5.1: ADR Default Rate Book (`PRICE_BOOKS_ENABLED=false`)
- **Applies to**: `[Today's App]` (Current default production baseline)
- **Setup**: Standard ADR company account where `PRICE_BOOKS_ENABLED=false`.
- **Steps**:
  1. On the test job (10 SF Category 1 drywall demo, 3 air movers, 1 dehumidifier, 3 days), tap **Fill scope from walkthrough**.
  2. Tap **Finish & review**.
  3. Inspect the calculated figures.
- **Expected Result**:
  - Scope itemized base charges total exactly **$1,775.00**.
  - Customer estimate range displays **$1,775.00 – $1,788.90** (applying ADR standard sheet 20% labor/material adjustment and threshold cushion).
  - Rate-book calculations strictly match `docs/adr-pricing-source.md`.
- **Report**: Exact itemized base total and customer range amounts.

#### Check 5.2: Blocked Audit for Company Without Published Prices
- **Applies to**: `[Both]`
- **Setup**: Sign in as a user belonging to a brand-new company workspace with no price book published.
- **Steps**:
  1. Open a draft and attempt to generate an estimate.
- **Expected Result**:
  - Banner displayed: `"Prices not set"`.
  - Estimator cannot calculate an estimate or sign documents.
  - The app strictly refuses to generate random or AI-invented prices.
- **Report**: Confirm that missing prices hard-block document generation.

#### Check 5.3: Company Price Books Switch & Editor (`PRICE_BOOKS_ENABLED=true`)
- **Applies to**: `[Today's App]` (when flag enabled) & `[Rebuilt App]`
- **Setup**: Company with price book capabilities active.
- **Steps**:
  1. Owner navigates to **Company prices**.
  2. Review the company's published price table, working copy, and version history.
  3. Verify area basis options (Demolition area vs Floor area) display explanation tooltips.
- **Expected Result**:
  - Full catalog displays editable item rates and cushion configuration.
  - Publishing creates a newly versioned, immutable price snapshot.
  - Unsigned drafts offer **Review new prices for this job**; signed jobs remain pinned to their original revision.
- **Report**: Price version increment and responsiveness of working-copy preview.

#### Check 5.4: Square-Foot Price Brackets (Tiered vs Whole-Job)
- **Applies to**: `[Today's App]` (PR #228) & `[Rebuilt App]`
- **Setup**: Owner configures price brackets on drywall demolition:
  - Band 1: 0 to 500 SF @ $10.00/SF
  - Band 2: 501 to 1,000 SF @ $5.00/SF
  - Band 3: Over 1,000 SF @ $2.00/SF
- **Steps**:
  1. Create a job with 501 SF demolition in **Tiered** mode. Verify calculation.
  2. Switch company policy to **Whole-job** mode. Verify calculation on 501 SF.
- **Expected Result**:
  - **Tiered**: First 500 SF @ $10 ($5,000) + 1 SF @ $5 ($5) = **$5,005.00** (before waste).
  - **Whole-Job**: All 501 SF priced at the >500 band rate ($5.00) = **$2,505.00** (before waste).
  - In Tiered mode, split bracket lines render clearly in the itemized claim.
- **Report**: Verified mathematical amounts in both Tiered and Whole-job modes.

---

### Group 6: Signing & the Homeowner Link

#### Check 6.1: Four-Document Generation & Letterhead Verification
- **Applies to**: `[Both]`
- **Setup**: Complete scope on synthetic job. Confirm scope.
- **Steps**:
  1. Tap **Review before signing**.
  2. Inspect all 4 tabbed documents:
     - **1. Proposal**
     - **2. Itemized claim**
     - **3. Scope defense letter**
     - **4. Photo audit log**
  3. Check the letterhead on Proposal and Defense Letter.
- **Expected Result**:
  - Letterhead displays: `Alert Disaster Restoration`, `3300 Patton Way · Bakersfield, CA 93308`, `(661) 426-2151`, and CSLB `#950983`.
  - Customer name reads `Synthetic Homeowner`.
  - Defense letter includes formal IICRC S500 / S520 insurance citations.
  - Photo log lists each captured photo as `Photo N (Room)`.
- **Report**: Confirm all 4 documents render without blank tabs or undefined placeholders.

#### Check 6.2: Scope Edits Invalidate Existing Documents
- **Applies to**: `[Both]`
- **Setup**: Unsigned documents generated on screen.
- **Steps**:
  1. Return to **Property & scope**.
  2. Change drywall demolition from 10 SF to 15 SF.
  3. Return to **Review before signing**.
- **Expected Result**:
  - Prior generated documents and signatures are immediately wiped.
  - Scope confirmation box is unticked with status: `"Scope changed · confirm again."`.
  - Generating new documents requires explicit technician re-confirmation.
- **Report**: Confirm previous documents are purged and cannot be signed without re-audit.

#### Check 6.3: Sign on the Phone (Estimator In-Person Signature)
- **Applies to**: `[Both]`
- **Steps**:
  1. Reconfirm scope and generate fresh documents.
  2. In the signing canvas, draw a synthetic test signature stroke using a finger.
  3. Check the legal confirmation checkbox.
  4. Tap **Sign and complete estimate**.
- **Expected Result**:
  - Submits signature bound to the exact document revision and SHA-256 proposal hash.
  - Returns verified server receipt.
  - Job transitions to **Signed** state; scope fields and photo logs become permanently **read-only**.
- **Report**: Receipt display speed and confirmation that all edit controls are locked.

#### Check 6.4: Homeowner Remote Signing Link
- **Applies to**: `[Both]`
- **Setup**: On an unsigned, reviewed draft.
- **Steps**:
  1. Tap **Send to homeowner**.
  2. Display the generated QR code or tap **Copy link**.
  3. Open the link on a secondary device (e.g., another phone or laptop in incognito) without logging in.
  4. Open and scroll through all 4 document tabs on the remote device.
  5. Enter name `Synthetic Homeowner`, role `Property Owner`, check both consent boxes, draw finger signature, and tap **Sign agreement**.
- **Expected Result**:
  - Remote link at `/sign` opens without requiring account credentials.
  - Signing is disabled until all 4 document tabs have been viewed.
  - Upon submission, link shows confirmed signed receipt.
  - Within 10 seconds, the estimator's phone updates to show the completed agreement.
  - Attempting to sign with the same link a second time returns the existing receipt (idempotent).
  - Editing the scope before signing immediately voids the link with: `"This estimate was updated"`.
- **Report**: Remote signing turnaround time and link invalidation behavior upon scope change.

#### Check 6.5: Post-Signing Immutability & Neutral Change Orders
- **Applies to**: `[Rebuilt App]` (S5 Change Order Workflow)
- **Setup**: Fully signed customer job.
- **Steps**:
  1. Open the signed job. Verify that no scope items or customer details can be changed in place.
  2. Tap **Create change order**.
  3. Add 20 SF of additional demolition discovered during drying.
- **Expected Result**:
  - The original signed agreement and its proposal hash remain 100% byte-immutable.
  - A new, linked incremental Change Order draft is created for the added work only.
  - The Change Order requires its own owner approval and separate customer e-signature.
- **Report**: Integrity of original agreement; verify no retroactive price changes occur on signed jobs.

---

### Group 7: Retention & AI Cap Messages

#### Check 7.1: Owner Dashboard AI Spending Tracker
- **Applies to**: `[Both]`
- **Setup**: Sign in as the company Owner.
- **Steps**:
  1. View the main Owner Dashboard.
  2. Locate the AI spending line.
- **Expected Result**:
  - Shows read-only spending line: **"AI used this month: $X of $10.00"** (or configured company cap).
  - Calculated based on current UTC calendar month.
  - Offline, the line shows no spending claim and does not crash.
- **Report**: Exact spending figure displayed and UTC rollover consistency.

#### Check 7.2: AI Monthly Hard Cap Message (REST 429)
- **Applies to**: `[Both]`
- **Setup**: Company that has exhausted its monthly $10 AI allowance.
- **Steps**:
  1. Attempt to run an AI audit or voice-to-scope extraction.
- **Expected Result**:
  - Request fails gracefully with HTTP 429.
  - The phone displays the exact plain-English refusal message:
    > *"This AI request does not fit your company's remaining monthly AI spending limit. The allowance resets next month (UTC). Your field work, drafts and agreements are saved; you can keep working without AI."*
  - Draft data, room measurements, and photos remain completely safe and editable manually.
- **Report**: Confirm exact message appears and that manual estimate creation remains 100% operational.

#### Check 7.3: AI Held Allowance Message (In-Flight Concurrency 429)
- **Applies to**: `[Both]`
- **Setup**: Company near its spending limit where concurrent requests hold the remaining allowance.
- **Steps**:
  1. Trigger an AI request while other holds are active.
- **Expected Result**:
  - The phone displays the exact held-allowance message:
    > *"Your company's remaining AI allowance this month is held by AI requests in progress or awaiting confirmation. Retry in a minute. Your field work, drafts and agreements are saved; you can keep working without AI."*
  - Response carries `Retry-After: 60`. The phone pauses automated photo OCR retries until the cooldown expires.
- **Report**: Exact message wording and verification that the 60-second cooldown is honored.

#### Check 7.4: Live Session Spending Admission Margin & Shutdown
- **Applies to**: `[Both]`
- **Setup**: Company with less than $2.00 remaining in its monthly AI budget.
- **Steps**:
  1. Attempt to start a new Live walkthrough session.
- **Expected Result**:
  - Live session refuses upstream connection before streaming camera or audio.
  - Displays notice explaining that remaining allowance is below the $2.00 session admission margin.
  - Offline notes and manual photo capture remain fully available.
- **Report**: Confirmation that Live refuses gracefully before incurring unbudgeted usage.

#### Check 7.5: Record Retention Period Settings & Daily Sweep Status
- **Applies to**: `[Both]`
- **Setup**: Sign in as company Owner.
- **Steps**:
  1. Open **Company settings** → **How long records are kept**.
  2. Inspect the 4 retention classes:
     - Invitations
     - Company activity log
     - Drying-watch history
     - Photos on archived drafts
  3. Type `89` days into the Invitations box.
  4. Type `120` days into the Invitations box.
  5. Observe the sweep status line at the bottom.
- **Expected Result**:
  - Typing `89` shows validation warning: `Enter 90 to 3,650 days.` (90 is strict minimum).
  - Typing `120` updates the plain sentence in real time:
    > *"Invitations, with the email address they were sent to, are deleted 120 days after they expire. An invitation expires 7 days after it is sent, whether it was accepted or not. Pending invitations are kept."*
  - Sweep status reports:
    - If `RETENTION_ENABLED` is off: *"Automatic deletion is not switched on yet, so nothing is deleted. These settings apply once it is."*
    - If on: *"Deletion runs once a day. Last run [Date]: X records deleted."*
  - Signed agreements and their photos are never deleted.
- **Report**: Dynamic sentence updates, 90-day minimum enforcement, and displayed sweep status text.

---

## 6. Device Acceptance Log Sheet

Print or copy this table when conducting physical phone acceptance rounds:

| Check # | Description | Device & OS | Browser / PWA | Network | Pass / Fail | Measured Values / Observations |
|---|---|---|---|---|---|---|
| **1.1** | Landing & Sign-in | | | Wi-Fi | | |
| **1.2** | Password Reset | | | Wi-Fi | | |
| **1.3** | Google OAuth Popup | | | Wi-Fi | | |
| **1.4** | PWA Home Screen Icon | | | Wi-Fi | | |
| **1.5** | Multi-tenant Isolation | | | Wi-Fi | | |
| **2.1** | New Job Header Height | | | Wi-Fi | | |
| **2.2** | Coordination Save | | | Wi-Fi | | |
| **2.3** | 1978 Pre-Test Notice | | | Wi-Fi | | |
| **2.4** | Field Ownership Handoff | | | Wi-Fi | | |
| **3.1** | Room SF Keypad (no `0` bug)| | | Wi-Fi | | |
| **3.2** | Portrait Photo Quality | | | Wi-Fi | | |
| **3.3** | Offline Cold App Reboot | | | Airplane | | |
| **3.4** | Reconnect & Photo Sync | | | Airplane→Wi-Fi| | |
| **3.5** | Voice Note Screen Lock | | | Airplane | | |
| **4.1** | Bluetooth Earpiece Route| | | 5G | | |
| **4.2** | Assistant First Greeting| | | 5G | | |
| **4.3** | Interruption Flush | | | 5G | | |
| **4.4** | Weak Signal Video Pause | | | Basement | | |
| **4.5** | Latency Benchmark (5x) | | | 5G | | P50: ___s / Max: ___s |
| **4.6** | Hardware Dots Teardown | | | 5G | | |
| **5.1** | ADR Sheet Baseline | | | Wi-Fi | | $1,775.00 Base / Range: |
| **5.2** | Unpriced Company Block | | | Wi-Fi | | |
| **5.3** | Price Books Editor | | | Wi-Fi | | |
| **5.4** | Square-Foot Brackets | | | Wi-Fi | | Tiered: $ / Whole-Job: $|
| **6.1** | 4 Documents & Letterhead| | | Wi-Fi | | |
| **6.2** | Scope Invalidation | | | Wi-Fi | | |
| **6.3** | Phone E-Signature | | | Wi-Fi | | |
| **6.4** | Remote Homeowner Link | | | Wi-Fi | | |
| **6.5** | Immutable Change Order | | | Wi-Fi | | |
| **7.1** | Dashboard AI Spending | | | Wi-Fi | | |
| **7.2** | AI Hard Cap Message | | | Wi-Fi | | |
| **7.3** | AI Held Allowance Msg | | | Wi-Fi | | |
| **7.4** | Live $2 Margin Notice | | | Wi-Fi | | |
| **7.5** | Retention Settings Sentences| | | Wi-Fi | | |

---

## 7. Next Steps Upon Successful Phone-Check

When all checks in a testing round pass:
1. Record device models, OS builds, and Bluetooth hardware in `docs/STATUS.md`.
2. Update the `Phone-checked` column in `docs/STATUS.md` from `no` or `partial` to `yes`.
3. If any check fails, preserve the failure logs in `/root/firstmate/data/` and open an issue or repair task with the exact reproduction steps.
