# Intended behavior before code tracing

This summary is based on `AGENTS.md`, `README.md`, `docs/pricing-source.md`, `docs/firebase-isolation.md`, `docs/review-repairs.md`, the prior UI report, and deployment/test configuration. It was written before this review's application-code trace.

## Design gaps and source precedence

- The `AGENTS.md` excerpt pasted earlier in the conversation and historical review text describe ADR package tiers and a shared `mitigation-project`; the current repository `AGENTS.md`, the user's supplied workbook and the isolation docs replace those decisions. The active app should show the workbook's low–high estimate, have no tier selector, and use only `alert-disaster-field-2026` resources.
- `AGENTS.md` calls the itemized document “Xactimate Line Items,” while current operating notes say these are ADR internal estimates with no ESX import claim. The review will check actual labels and exports against the more specific current notes.
- The source sheet exposes an $83.45 after-hours rate but references $47.46 in its estimate formula. The user chose the formula's $47.46/hour for added labor; the review will test that behavior.
- Physical iPhone camera, Bluetooth audio and interruption acceptance remains open in the repair notes. Desktop emulation cannot establish device acceptance.
- No paid subscription plans or separate customer/administrator account role is documented. I will note any roles found in implementation rather than inventing expected permissions.

## Users, data boundary and pricing

Approved Alert staff sign in with Google. Each technician may create, revise and retrieve only inspections and jobs owned by their Firebase UID. The app serves one Alert organization; its Firebase Auth, Firestore, private evidence bucket, Cloud Run service and Hosting target belong to the dedicated `alert-disaster-field-2026` project. Browser database access is denied and server routes enforce ownership. An office user needs an approved staff account and, under the documented owner-private model, cannot browse another technician's job without that technician's access or a future sharing feature.

There are no paid feature plans. Prices are per remediation job. A technician confirms measured scope and sheet charges; the customer proposal shows the workbook's low–high range and the itemized document shows separately calculated base-rate charges. AI output must not set prices or assert unverified evidence.

## Core journeys

1. An approved staff member signs in; unapproved/expired sessions cannot access private routes. Logout clears local private draft data and stops media.
2. A technician creates an inspection, records property age, rooms, measurements and scope, and retains a private draft locally and in Firestore with revisions and conflict protection.
3. A technician starts a room walkthrough with microphone/video, sees separate speech transcripts and recoverable media errors, and can interrupt, reconnect and finish with resources released.
4. Photos carry room, timestamp and dimensions, upload individually to private storage, and show pending/failed/verified OCR honestly.
5. Confirmed scope and sheet inputs calculate the low–high estimate and itemized base-rate total using authoritative server arithmetic.
6. Audit reads the saved revision and evidence, returns four validated documents with deterministic conditional wording and a visible failure state for invalid AI output or unresolved scope.
7. Signing binds to the immutable audited revision and proposal hash; edits invalidate it. Retries return an identical receipt and reopening restores agreement, documents and evidence.
8. Staff can find their saved jobs for later use, copy/download JSON and print all four documents with clear errors.
9. Offline draft recovery and PWA updates preserve unsynced work while AI and signing remain unavailable offline.
