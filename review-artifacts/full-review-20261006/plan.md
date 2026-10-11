# Full application review plan

**Status:** Approved review completed; six findings subsequently repaired and deployed October 7, 2026 at the user?s instruction. The following is the historical review plan. This is a report-only review: no application code, configuration, tests, or deployed resources will be changed. Review the current working tree, including its uncommitted migration and repair work, at commit `9724b97`. Browser testing will use only a local development address and synthetic identities; it will not access production or customer records.

## Design sources and precedence

| Source | Intent it supplies |
| --- | --- |
| `AGENTS.md` | Product mission, field workflow, Live media formats, document and regulatory wording, pricing rules, dedicated-project guardrails, acceptance expectations. |
| `README.md` | Current staff-facing workflow, setup and operation, low–high estimate, four documents, local drafts, saved agreements, exports, deployment. |
| `docs/pricing-source.md` and the supplied `1 - Water . Mold - Estimating Sheet (2).xlsx` | Current authoritative estimating formulas and cell references. The user confirmed workbook low–high output and its $47.46/hour added-labor formula for after-hours jobs. There are no ADR package tiers in this sheet. |
| `docs/firebase-isolation.md` | Dedicated Firebase/Google Cloud project, owner-private records, Firestore/Storage design, revision/audit behavior, rate limits and historical record compatibility. |
| `docs/review-repairs.md` | Prior 18-finding repair claims, deployment and verification history, remaining physical-device acceptance. Historical test results will be rechecked where possible. |
| `review-artifacts/ui-review-20261006/report.md` | Previous six UI findings, redesign claims, screenshots and current pricing correction. |
| `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `.firebaserc`, `playwright.config.js`, `package.json`, `backend/requirements.txt`, `backend/Dockerfile` | Deployment target, browser database rules/indexes, local browser harness, test commands and runtime stack. These are configuration/design evidence, not proof of runtime behavior. |
| `deployment/legacy-redirect/firebase.json` | Redirect intent for the former hosting origin; production redirect behavior is outside local browser testing. |

No separate PRD, `DESIGN.md`, SQL migration or schema document appeared in the repository file inventory. Before application-code tracing, I will finish reading all listed design sources and any intent-bearing comments/schema definitions encountered. Current pricing and dedicated-project decisions take precedence over historical package-tier and `mitigation-project` wording. I will record any remaining contradiction as a design gap rather than silently choosing an interpretation.

## Stack and product boundary

The app is a mobile-first, installable static HTML/CSS/JavaScript PWA on Firebase Hosting, backed by a Python/FastAPI Cloud Run service. It uses Firebase Google sign-in, Firestore for private inspection/job records, private Cloud Storage for evidence, IndexedDB for offline drafts, Vertex AI/Gemini for OCR, audit and Live coaching, and a Cloud Run WebSocket relay. Existing Node tests and Playwright Chromium/WebKit browser tests run against a local synthetic server; Python tests cover backend logic. The public `alertdisaster.com` marketing website is a separate property and is not the inspection app under review.

The documented users are approved staff; inspection ownership is tied to a Firebase UID. There is one Alert organization in a dedicated project, with no documented paid plans or customer self-service role. These role and tenancy assumptions will be checked against the implementation before testing.

## Journeys to trace and test

For each journey, trace screen → API/service → Firestore/Storage/IndexedDB → restored screen, including bad input, empty/loading/error states, expired login, network failure and duplicate requests where relevant.

1. Staff sign-in, route/API access, session expiry and logout cleanup.
2. Start an inspection, edit property/rooms/scope, autosave a private draft, recover it offline, sync it and resolve revision conflicts.
3. Start/interrupt/reconnect/finish a Live walkthrough; handle permissions, media formats, transcripts and resource teardown.
4. Capture/upload a photo, attach room/time/dimensions, run OCR, display pending/failed/verified evidence and enforce owner access.
5. Confirm quantities and sheet charges, calculate the low–high estimate and itemized base-rate total, and preserve those values through save/reopen.
6. Run an audit, handle malformed/failed AI output, render all four validated documents and conditional notices, and prevent unresolved scope/evidence from being presented as verified.
7. Sign the current proposal revision, retry safely, invalidate signatures after edits and reopen an immutable signed job.
8. List/retrieve saved jobs for later office use; download/copy JSON and print all documents with useful failure feedback.
9. Update/install the PWA while preserving drafts; check offline asset behavior and authenticated API exclusion from caches.

## High-risk check applicability

| Step 3 check | Applicability and focus |
| --- | --- |
| 1. Data separation | Applicable: UID ownership on every record, photo, job and Live route; Firestore/Storage privacy; admin SDK bypass of browser rules; dedicated-project references. |
| 2. Roles and permissions | Applicable: approved-staff gate and owner access must be server-enforced. Check for any additional role in code. |
| 3. Paid plans | Not applicable unless implementation reveals billing: no paid plans, subscription service or tiered staff access are documented. Estimate price ranges are job prices, not subscription tiers. |
| 4. Login and sessions | Applicable: protected APIs, token validity, expired session behavior, logout and local data clearing. |
| 5. Secrets | Applicable: repository/browser bundles, Firebase public configuration versus private keys, Cloud Run ADC and environment handling. |
| 6. Outside services and AI | Applicable: Gemini/Vertex calls, timeouts, bad output, retries, rate/cost limits, Live reconnect and user-visible failure. |
| 7. Uploads | Applicable: image/signature content, size/type/quantity limits, private storage and owner checks. |
| 8. Database | Applicable: Firestore record versions, required fields, indexes, owner references, conflict transactions and historical jobs. No SQL migration is documented. |
| 9. Input handling | Applicable: server schemas and numeric validation, safe document rendering, HTML injection, JSON export and signatures. |

## Work split after approval

Three independent subagents will review (1) auth, ownership, sessions, secrets and storage/API isolation; (2) Live walkthrough, capture, OCR, offline drafts and PWA; and (3) pricing, audit, documents, signatures, saved jobs and exports. I will own the intended-behavior synthesis, test/build/lint inventory, local browser journey matrix and screenshots, then consolidate findings. Each reviewer will return Step 6-style findings with severity, exact file:line, design expectation, proof/reproduction and proposed fix. I will remove duplicates and independently confirm every Critical or High issue before reporting it.

## Verification and deliverables

Run available build, type, lint and test commands; explicitly mark commands that the project does not define. Start only the local test server, use synthetic staff/owner identities from the existing harness, and attempt cross-owner record/photo access by ID and replayed request. Exercise mobile and desktop key screens in Chromium and WebKit, recording screenshots for browser-confirmed issues and any test limitation. Do not create real customer accounts or use live credentials.

The final commentable artifact will be `review-artifacts/full-review-20261006/report.md`, with linked screenshots. It will contain a one-paragraph Ready/Needs work/Blocked verdict, concrete issue table, design gaps, test outcomes, code-versus-browser differences and risk-ordered untested journeys. Every finding will cite an exact file and line; anything suspected but not reproduced will be labeled **Unconfirmed**. Physical iPhone/Bluetooth behavior and real-service claims will remain unverified unless separately tested with the user's device and authorization.

**Gate:** Per the supplied review instructions, wait for approval of this plan before application-code review, subagent work, test runs or browser sessions.
