# AGENTS.md - Agent Operating Guidelines & Domain Knowledge

This document specifies the operational protocols, business rules, architectural patterns, and safety constraints for AI agents working in this repository.

---

## 1. Project Mission & Identity

- **Product**: **DryScope**, serving **Alert Disaster Restoration** first and other restoration companies as isolated company workspaces.
- **ADR Location**: Bakersfield, CA (Serving Kern County and surrounding areas)
- **ADR License**: California State License Board (CSLB) **#950983**
- **ADR Estimator Sign-off**: Matthew Myers
- **Core Purpose**: Provide field technicians with a multimodal AI assistant that conducts real-time video/voice walkthroughs on iPhones and instantly synthesizes complete, adjuster-ready claims and client-facing proposals.

---

## 2. Dual-Engine Architecture Guidelines

### Engine 1: Real-Time Field Walkthrough (`gemini-3.8-live`)
- **Transport**: Authenticated Cloud Run WebSocket relay using server ADC, Vertex AI in `us-central1`. Authenticate the first message and check origin and authorized inspection access before connecting.
- **Payloads**:
  - Outbound Audio: 16kHz PCM (single channel, little-endian).
  - Outbound Video: one 640 px JPEG frame every 2 s. Frames wait behind queued microphone audio and pause automatically, with a visible weak-signal status, while acknowledged audio is more than 0.6 s behind.
- **Latency Target**: Sub-second conversational turnaround in technician's Bluetooth earpiece.
- **HUD Integration**:
  - Live Extech MO290 moisture meter HUD overlay.
  - FLIR thermal camera gradient emulation.
  - Asynchronous background photo capture with silent OCR tagger.

### Engine 2: Post-Walk Claims & Compliance Engine (`gemini-3.8-flash`)
- **Transport**: Cloud Run REST microservice (`POST /api/audit`).
- **Input**: Walkthrough transcript, timestamped photos, property address, year built, and equipment counts.
- **Output**: Structured JSON strictly conforming to the 4-document claims hub schema:
  1. Official proposal, headed "[Company] · Official proposal" ("Proposal" tab; sheet-derived low–high estimate + e-signature).
  2. Itemized claim (ADR scope codes, not Xactimate codes) with waste factors.
  3. Formal IICRC S500 / S520 insurance claim defense letter.
  4. Photo Moisture Audit Log.
- Configure models with `AUDIT_MODEL`, `OCR_MODEL` and `LIVE_MODEL`; verify them in the dedicated project before enabling a different model. Pricing and mandatory wording are server calculations, never model output.
- Bind audits and signatures to a saved revision and proposal hash. Pending/failed OCR is unverified; unpriced work blocks signing. Show the customer estimate range alongside the itemized base-rate calculation. Use ADR internal scope codes and JSON export without ESX compatibility claims.

---

## 3. Pricing

Each company sets its own prices, there is no default, and a company without published prices cannot price an estimate; ADR's rates, source notes and estimate rules live in `docs/adr-pricing-source.md`.

---

## 4. California Regulatory & Compliance Rules

### A. The 1978 Pre-Test Rule (Title 8 & EPA RRP)
- **If Year Built < 1978**:
  - The proposal **must** include the explicit notice: *(this does not include the pretest for lead/asbestos)*.
  - Findings must state: *"Due to property age ({yearBuilt}), California State Law requires third-party lead and asbestos testing prior to destructive demolition."*
- **If Year Built >= 1978**:
  - Findings state no pre-testing is required.

### B. Standard ADR Scoping Disclaimers
Agents must preserve the exact standard estimate clauses in `backend/claims.py`, taken from ADR's real estimates: the pre-1978 testing paragraph, the IICRC/EPA protective-equipment and containment sentence, the additional-materials sentence, the reconstruction/collateral-damage/testing exclusions, insurance repricing and 30-day validity. Clauses that name the company use the issuing company's name. Crawl spaces, countertops and water heaters have no fixed wording or form flag; technicians describe them in notes or the walkthrough. Documents describe the work as proposed.

---

## 5. Deployment & Infrastructure Guardrails

### A. Dedicated Firebase Project
- This app uses the dedicated GCP/Firebase project `alert-disaster-field-2026`.
- Hosting target `alert-disaster` maps to site `alert-disaster-field-2026`.
- The historical `mitigation-project` deployment contains other apps. The old `alert-disaster-live` site was retired as of 2026-10-12 and has no redirect; keep peer sites and shared databases untouched.
- **NEVER** run a blanket `firebase deploy`.
- **ALWAYS** deploy with target isolation:
  ```bash
  firebase deploy --only hosting:alert-disaster --project alert-disaster-field-2026
  ```
- Keep `public/index.html` and `index.html` synchronized at all times.
- Before hosting deployment, verify the backend is deployed in the dedicated project; `/api/**` uses a same-project Cloud Run rewrite.

### B. Google Cloud Run Microservice
- Service Name: `alert-disaster-field-estimator`
- Region: `us-west2`
- Project: `alert-disaster-field-2026`
- Command:
  ```bash
  # Use the full command in docs/firebase-isolation.md, preserving runtime/build identities,
  # staff access, model configuration, bounded REST deadlines and the 3600-second Live timeout.
  ```

### C. Security & Credentials
- Do not commit Google Cloud service account keys or raw API keys into git.
- The Cloud Run service leverages Google Cloud Application Default Credentials (ADC) to authenticate with Vertex AI / Google Gen AI SDK.
- Use runtime account `adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com` and build account `adr-builder@alert-disaster-field-2026.iam.gserviceaccount.com`. Preserve the environment and limits in `docs/firebase-isolation.md`. Database rules do not constrain server SDK access through IAM.

### D. Private Database
- Firestore `(default)` belongs only to `alert-disaster-field-2026`, in `us-west2`.
- Direct client reads/writes are denied by `firestore.rules`. Signed jobs use server-side access checks and private bucket `alert-disaster-field-2026-evidence`; business APIs require a verified Firebase email, except the health check, the homeowner signing-link routes (`/api/sign*`), which accept only a single-use link token and act as the technician who created it, and the read-only document-link routes (`/api/documents*`), which accept only a revocable 30-day link token. With company workspaces enabled, Google or verified email/password sign-in is accepted and private membership and job-access records authorize each operation; the legacy staff allowlist applies only to the disabled-workspace rollback mode.
- Deploy database rules separately: `firebase deploy --only firestore:rules --project alert-disaster-field-2026`.
- Read `docs/firebase-isolation.md` before cloud changes. Never enable demo fallbacks in production.

## 6. Company workspaces

- For authorization, invitations, company documents, offline queues or workspace rollout, read `docs/company-workspaces.md` before changing the implementation or cloud state.
- Preserve company isolation on every business endpoint, evidence download and Live recheck. Superadmin privileges alone grant account management plus audited read-only support access to any company and its listed support actions; editing customer jobs requires an active company membership.
- Archiving is a soft, audited status change, never a delete: owners archive unsigned drafts (the source record stays, and its photos stay until the company's record-retention period for them has passed once that deletion is switched on; the job leaves lists and returns 410) and restore them from Archived drafts; superadmin support can archive or restore an unsigned draft in any company, suspended ones included, as an audited support action; and a superadmin archives a suspended company. Signed jobs cannot be archived. A phone holding unsynced work for an archived draft keeps it and offers Save as new draft or Discard.
- Keep signed source records and evidence paths immutable. Migration and mutable assignment/coordination use private sidecars. ADR's exact notices remain the ADR defaults; other California companies use their own identity and their own published prices.

## 7. Acceptance checks

- **Never weaken tests, evaluations or checks to make work pass.** Do not delete, skip or loosen a test, lower a scoring threshold, edit expected answers in eval fixtures, or change workflow files to get a green result. If a test looks wrong, stop and explain why in the pull request so the owner can decide. The Test guard check (`scripts/test-guard.mjs`) blocks these changes until the owner adds the `test-change-approved` label. Never add, remove or request that label yourself.
- **Fix the code, not the test.** When a test fails, assume the code is wrong first. Adding new tests is always welcome.
- Run `python -m pytest tests -q -p no:cacheprovider`, `npm test` and `npm run test:browser` for lifecycle changes. Keep the HTML copies identical.
- Record synthetic real-service checks separately from mock tests. Physical iPhone camera, microphone, Bluetooth, reconnect, interruption, Finish cleanup and sub-second latency remain open until observed on the device. See `docs/review-repairs.md` for the guided test and current evidence.

## 8. Where to look

- `docs/STATUS.md` (index) and `docs/status/`: each feature, whether it is built, switched on, and checked on a phone. Do not edit `docs/status/` in feature PRs; status is updated in a batch after merges.
- `docs/ACCESS.md`: the role and capability table (code source: `CAPABILITIES` in `backend/workspaces.py`).
- `docs/SECURITY.md`, `docs/RUNBOOK.md` (index; one file per topic in `docs/runbook/`), `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`: security rules, operations and rollback, decisions (including open ones), and structure.
- `specs/_TEMPLATE.md`: the spec template for a new piece of work.
