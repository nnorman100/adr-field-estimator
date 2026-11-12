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

## 2. Claims engine and live walkthrough

- The old engines (the Python Cloud Run `POST /api/audit` service and WebSocket Live relay, configured by `AUDIT_MODEL`, `OCR_MODEL` and `LIVE_MODEL`) belong to the retired old app. The rebuild's claims engine is TypeScript in `web/src/engine/` (`makeDocuments` in `documents.ts`). The real-time walkthrough relay is not built in `web/` yet (S7; see `docs/ARCHITECTURE.md`).
- Output is the 4-document claims hub:
  1. Official proposal, headed "[Company] · Official proposal" ("Proposal" tab; sheet-derived low–high estimate + e-signature).
  2. Itemized claim (ADR scope codes, not Xactimate codes) with waste factors.
  3. Formal IICRC S500 / S520 insurance claim defense letter.
  4. Photo Moisture Audit Log.
- Pricing and mandatory wording are server calculations, never model output.
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
Agents must preserve the exact standard estimate clauses in `web/src/engine/documents.ts` (checked by `web/tests/unit/estimate-documents.test.ts`), taken from ADR's real estimates: the pre-1978 testing paragraph, the IICRC/EPA protective-equipment and containment sentence, the additional-materials sentence, the reconstruction/collateral-damage/testing exclusions, insurance repricing and 30-day validity. Clauses that name the company use the issuing company's name. Crawl spaces, countertops and water heaters have no fixed wording or form flag; technicians describe them in notes or the walkthrough. Documents describe the work as proposed.

---

## 5. Deployment & Infrastructure Guardrails

### A. Google Cloud project and releases
- The rebuilt app runs in Google Cloud project `dryscope` (project number `570228742694`), region `us-central1`, with separate `test` and `live` resources defined in `infra/dryscope/`. Details: `docs/ARCHITECTURE.md` (Environments).
- Releases go through `.github/workflows/web-release.yml` (test only today; see `docs/runbook/test-release.md`). Cloud steps the owner runs are listed in `docs/runbook/owner-cloud-steps.md`. Do not deploy by hand.
- **NEVER** run a blanket `firebase deploy`.
- The old app's project `alert-disaster-field-2026` (Hosting target `alert-disaster`, Cloud Run `alert-disaster-field-estimator` in `us-west2`) is retired and switched off. Do not deploy to it or change it, and keep peer sites and shared databases (including the historical `mitigation-project`) untouched.

### B. Cloud Run
- The web app is the Cloud Run service `dryscope-api-<env>` (`dryscope-api-test` today), with the migration job `dryscope-migrate-<env>`, in `us-central1`. Terraform in `infra/dryscope/` owns their settings and identities; the release workflow changes only the image.

### C. Security & Credentials
- Do not commit Google Cloud service account keys or raw API keys into git.
- Cloud Run services use Google Cloud Application Default Credentials (ADC) with the per-environment runtime accounts defined in `infra/dryscope/` (`infra/dryscope/README.md`). Database rules do not constrain server SDK access through IAM.

### D. Private Database
- The official records are in Cloud SQL Postgres with row-level security (project `dryscope`); drafts live in the named Firestore field database, whose browser access is limited to what `web/firestore.rules` allows. Evidence and signed records are written only server-side after identity, company membership and job-access checks.
- Field-database rules are released by the release workflow's deploy job (`docs/runbook/test-release.md`), not by hand. Read `docs/runbook/` and `infra/dryscope/README.md` before cloud changes. Never enable demo fallbacks in production.

## 6. Company workspaces

- For authorization, invitations, company documents, offline queues or workspace rollout, read `docs/ACCESS.md` and the stage plan in `docs/plans/` (`S3.md`) before changing the implementation or cloud state.
- Preserve company isolation on every business endpoint, evidence download and Live recheck. Superadmin privileges alone grant account management plus audited read-only support access to any company and its listed support actions; editing customer jobs requires an active company membership.
- Archiving is a soft, audited status change, never a delete: owners archive unsigned drafts (the source record stays, and its photos stay until the company's record-retention period for them has passed once that deletion is switched on; the job leaves lists and returns 410) and restore them from Archived drafts; superadmin support can archive or restore an unsigned draft in any company, suspended ones included, as an audited support action; and a superadmin archives a suspended company. Signed jobs cannot be archived. A phone holding unsynced work for an archived draft keeps it and offers Save as new draft or Discard.
- Keep signed source records and evidence paths immutable. Migration and mutable assignment/coordination use private sidecars. ADR's exact notices remain the ADR defaults; other California companies use their own identity and their own published prices.

## 7. Acceptance checks

- **Never weaken tests, evaluations or checks to make work pass.** Do not delete, skip or loosen a test, lower a scoring threshold, edit expected answers in eval fixtures, or change workflow files to get a green result. If a test looks wrong, stop and explain why in the pull request so the owner can decide. The Test guard check (`scripts/test-guard.mjs`) blocks these changes until the owner adds the `test-change-approved` label. Never add, remove or request that label yourself.
- **Fix the code, not the test.** When a test fails, assume the code is wrong first. Adding new tests is always welcome.
- Run the checks listed under Commands in `CLAUDE.md`, including `npm run test:e2e` in `web/` for UI and lifecycle changes.
- Record synthetic real-service checks separately from mock tests. Physical iPhone camera, microphone, Bluetooth, reconnect, interruption, Finish cleanup and sub-second latency remain open until observed on the device. See `docs/review-repairs.md` for the guided test and current evidence.

## 8. Where to look

- `docs/STATUS.md` (index) and `docs/status/`: each feature, whether it is built, switched on, and checked on a phone. Do not edit `docs/status/` in feature PRs; status is updated in a batch after merges.
- `docs/ACCESS.md`: the role and capability table (code source: `CAPABILITIES` in `web/src/lib/access/roles.ts`).
- `docs/SECURITY.md`, `docs/RUNBOOK.md` (index; one file per topic in `docs/runbook/`), `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`: security rules, operations and rollback, decisions (including open ones), and structure.
- `specs/_TEMPLATE.md`: the spec template for a new piece of work.
