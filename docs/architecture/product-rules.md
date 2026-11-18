# Architecture: Product rules

Part of [Architecture](../ARCHITECTURE.md).

## Product rules (moved from AGENTS.md)

Moved here on Nov 12, 2026 when `AGENTS.md` was rewritten as the short agent instructions (`CLAUDE.md` imports it). `AGENTS.md` points here. Section numbers are the old `AGENTS.md` numbers.

### 1. Project Mission & Identity

- **Product**: **DryScope**, for water and mold restoration companies, each in its own isolated company workspace.
- **Company identity**: each company's name, address, licence number and estimator sign-off come only from its own company profile (Company settings) and print exactly as entered. They are never hard-coded in the rebuilt app (`web/`, `infra/dryscope/`) or in the project's rules and docs; the retired legacy app's test fixtures go away with it in S8.
- **Core Purpose**: A phone web app: a restoration technician walks a water or mold loss once and leaves with a priced, signable estimate. A live video and voice walkthrough is planned (S7) but not built in `web/` yet; see section 2.

### 2. Claims engine and live walkthrough

- The old engines (the Python Cloud Run `POST /api/audit` service and WebSocket Live relay, configured by `AUDIT_MODEL`, `OCR_MODEL` and `LIVE_MODEL`) belong to the retired old app. The rebuild's claims engine is TypeScript in `web/src/engine/` (`makeDocuments` in `documents.ts`). The real-time walkthrough relay is not built in `web/` yet (S7; see `docs/ARCHITECTURE.md`).
- Output is the 4-document claims hub:
  1. Official proposal, headed "[Company] · Official proposal" ("Proposal" tab; sheet-derived low–high estimate + e-signature).
  2. Itemized claim (the company's own scope codes, not Xactimate codes) with waste factors.
  3. Formal IICRC S500 / S520 insurance claim defense letter.
  4. Photo Moisture Audit Log.
- Pricing and mandatory wording are server calculations, never model output.
- Bind audits and signatures to a saved revision and proposal hash. Pending/failed OCR is unverified; unpriced work blocks signing. Show the customer estimate range alongside the itemized base-rate calculation. Use the company's own scope codes and JSON export without ESX compatibility claims.

### 4. California Regulatory & Compliance Rules

#### A. The 1978 Pre-Test Rule (Title 8 & EPA RRP)
- **If Year Built < 1978**:
  - The proposal **must** include the explicit notice: *(this does not include the pretest for lead/asbestos)*.
  - Findings must state: *"Due to property age ({yearBuilt}), California State Law requires third-party lead and asbestos testing prior to destructive demolition."*
- **If Year Built >= 1978**:
  - Findings state no pre-testing is required.

#### B. Standard Scoping Disclaimers
Agents must preserve the exact standard estimate clauses in `web/src/engine/documents.ts` (checked by `web/tests/unit/estimate-documents.test.ts`). They are DryScope's product defaults, taken from a restoration company's real estimates: the pre-1978 testing paragraph, the IICRC/EPA protective-equipment and containment sentence, the additional-materials sentence, the reconstruction/collateral-damage/testing exclusions, insurance repricing and 30-day validity. Clauses that name the company use the issuing company's name. A company's own clauses are its document settings (Company settings); they print as entered, alongside the product defaults. Crawl spaces, countertops and water heaters have no fixed wording or form flag; technicians describe them in notes or the walkthrough. Documents describe the work as proposed.

#### C. Wording held for lawyer review
The owner takes these questions to a lawyer. Until the owner records an answer, the text in A and B above and in `web/src/engine/documents.ts` stays exactly as it is, and DryScope ships no wording of its own for items 3 and 4 (a company may enter its own in its start-work authorization text, `docs/plans/S5.md` S5a-11). Added 2026-11-13 from a review of a restoration company's real estimates (`docs/plans/S5.md`, section 12).
1. **Pre-1978 Findings sentence (W1).** The reviewed estimates print "The home was built in {year}. Before any disturbance to building materials, lead and asbestos testing must be conducted prior to the start of work." instead of the mandated sentence in A. Does either satisfy the rule, and which should DryScope print? Only the owner changes A.
2. **Licence label (W4).** The engine prints "CSLB #{licence}"; company letterheads also use "CA License #{licence}". Which label is required or allowed on a proposal and a signed agreement?
3. **California right to cancel.** A customer who signs at home, on the technician's phone or through a signing link, may be signing a home solicitation or home improvement contract with a right to cancel (three business days, longer for senior citizens and for repairs after a declared disaster): Civil Code §1689.6 and §1689.7, Business and Professions Code §7159. Bills in the 2025–26 session (SB 784, AB 1327) change these periods, so the lawyer checks current law. Questions: does the notice apply to mitigation and remediation work, what text and form, where on the signed page, and does a remote link signing change it.
4. **Emergency-repair waiver.** Civil Code §1689.13 lifts the right to cancel for emergency or immediately necessary repairs when the buyer (or the buyer's agent or insurance representative) started the contract and the buyer gives a separate dated, signed statement that describes the emergency and waives the right. Questions: the waiver wording, whether a signature on a phone or a link satisfies it, and whether work may start before the cancellation period ends.
5. Also with the lawyer, listed in `docs/plans/S7.md` (owner step J): the terms lines on AI processing, the AI notice wording (V11) and any future recording (V8 B).

### 5. Deployment & Infrastructure Guardrails

#### A. Google Cloud project and releases
- The rebuilt app's `test` environment runs in Google Cloud project `dryscope` (project number `570228742694`), region `us-central1`; `live` gets its own project before S8 (D-018). `infra/dryscope/` defines separate `test` and `live` resources. Details: `docs/ARCHITECTURE.md` (Environments).
- Releases go through `.github/workflows/web-release.yml` (test only today; see `docs/runbook/test-release.md`). Cloud steps the owner runs are listed in `docs/runbook/owner-cloud-steps.md`. Do not deploy by hand.
- **NEVER** run a blanket `firebase deploy`.
- The old app's project `alert-disaster-field-2026` (Hosting target `alert-disaster`, Cloud Run `alert-disaster-field-estimator` in `us-west2`) is retired and switched off. Do not deploy to it or change it, and keep peer sites and shared databases (including the historical `mitigation-project`) untouched.

#### B. Cloud Run
- The web app is the Cloud Run service `dryscope-api-<env>` (`dryscope-api-test` today), with the migration job `dryscope-migrate-<env>`, in `us-central1`. Terraform in `infra/dryscope/` owns their settings and identities; the release workflow changes only the image.

#### C. Security & Credentials
- Do not commit Google Cloud service account keys or raw API keys into git.
- Cloud Run services use Google Cloud Application Default Credentials (ADC) with the per-environment runtime accounts defined in `infra/dryscope/` (`infra/dryscope/README.md`). Database rules do not constrain server SDK access through IAM.

#### D. Private Database
- The official records are in Cloud SQL Postgres with row-level security (project `dryscope`); drafts live in the named Firestore field database, whose browser access is limited to what `web/firestore.rules` allows. Evidence and signed records are written only server-side after identity, company membership and job-access checks.
- Field-database rules are released by the release workflow's deploy job (`docs/runbook/test-release.md`), not by hand. Read `docs/runbook/` and `infra/dryscope/README.md` before cloud changes. Never enable demo fallbacks in production.

### 6. Company workspaces

- For authorization, invitations, company documents, offline queues or workspace rollout, read `docs/ACCESS.md` and the stage plan in `docs/plans/` (`S3.md`) before changing the implementation or cloud state.
- Preserve company isolation on every business endpoint, evidence download and Live recheck. Superadmin privileges alone grant account management plus audited read-only support access to any company and its listed support actions; editing customer jobs requires an active company membership.
- Archiving is a soft, audited status change, never a delete: owners archive unsigned drafts (the source record stays, and its photos stay until the company's record-retention period for them has passed once that deletion is switched on; the job leaves lists and returns 410) and restore them from Archived drafts; superadmin support can archive or restore an unsigned draft in any company, suspended ones included, as an audited support action; and a superadmin archives a suspended company. Signed jobs cannot be archived. A phone holding unsynced work for an archived draft keeps it and offers Save as new draft or Discard.
- Keep signed source records and evidence paths immutable. Migration and mutable assignment/coordination use private sidecars. The exact standard notices (section 4) remain the product defaults for every company; each company uses its own identity, its own document settings and its own published prices.

### 7. Device checks

- Record synthetic real-service checks separately from mock tests. Physical iPhone camera, microphone, Bluetooth, reconnect, interruption, Finish cleanup and sub-second latency remain open until observed on the device. See `docs/review-repairs.md` for the guided test and current evidence.
