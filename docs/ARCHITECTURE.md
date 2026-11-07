# Architecture

## Overview
```
Phone browser (static app, public/*.js, installable PWA, offline queue in IndexedDB)
   │  Firebase ID token                          ┌─► Vertex AI (Gemini Live relay, audit/OCR models)
   ▼                                             │
Firebase Hosting (alert-disaster) ── /api/** ──► Cloud Run: alert-disaster-field-estimator (Python, us-west2)
                                                 ├─► Firestore (default) — private, deny-all to browsers
                                                 ├─► Private evidence bucket (photos, signed evidence)
                                                 ├─► Secret Manager (Maps key, SMTP, etc.)
                                                 └─► Email (Gmail SMTP today; see docs/roadmap.md risks)
```
Everything lives in Google Cloud / Firebase project `alert-disaster-field-2026`. Peer sites and shared databases are never touched.

## Two engines
1. **Live walkthrough** — authenticated WebSocket relay; 16 kHz audio and a 640 px frame every 2 s; coaching and meter-photo reading.
2. **Claims engine** — `POST /api/audit`: transcript + photos + facts → four documents. The server applies prices and mandatory wording; the model drafts only.
Models are set by `AUDIT_MODEL`, `OCR_MODEL`, `LIVE_MODEL`.

## Where things are
| Area | Files |
|---|---|
| App shell, lifecycle, camera/audio, offline | `public/app.js`, `core.js`, `audio-worklet.js`, `sw.js` |
| Documents (4) rendering | `public/documents.js` |
| Homeowner signing and read-only document page | `public/sign.html`, `sign.js` |
| Workspaces, roles, jobs list | `public/workspaces.js`, `backend/workspaces.py`, `workspace_api.py` |
| Pricing, documents, mandatory wording | `backend/claims.py`, `contracts.py`, `price_books.py`, `docs/pricing-source.md` |
| Revisions, evidence, quotas | `backend/inspection_store.py`, `job_store.py` |
| Signing and document links | `backend/signing_links.py`, `document_links.py` |
| Drying log / watch | `psychrometrics.py`, `drying_watch.py`, `public/drying*.js` |
| Delivery (email) | `backend/delivery.py`, `workspaces.py` |
| Price books (off by default) | `price_book_*.py`, `price_books.py`, `price_table.py` (v2 tables), `pricing.py` (calculation dispatch), `pricing_v2.py` (v2 calculation), `public/scope-items.js` (v2 Check Scope item list) |
| Job close, estimate accuracy | `backend/outcomes.py`, `public/job-close.js`, `public/estimate-accuracy.js`, `docs/estimate-assist.md` |
| Warnings while estimating | `backend/estimate_warnings.py`, `public/app.js` (the readiness dialog), `docs/estimate-assist.md` |
| Readiness, insights, AI usage | `readiness.py`, `insights.py`, `ai_usage.py` |
| Funded AI generation and cooldowns | `backend/ai_generation.py`, `ai_spending.py`, `live_spending.py`, `public/ai-spending-ui.js` |
| Feature flags | `AI_FEATURES`, `PRICE_BOOKS_ENABLED`, `RETENTION_ENABLED`, `WORKSPACES_ENABLED` (set by `scripts/deploy_backend.py`) |
| Release scripts | `scripts/deploy_backend.py`, `stamp_hosting.py`, `verify_*`, `auto_deploy.py` (automatic deploys) |

## Data model (high level)
- Signed agreements and evidence are **immutable**. Mutable coordination (assignment, claim details, delivery, readings) lives in **sidecars** beside the job.
- Private collections: `_companies`, `_memberships`, `_platform_admins`, `_invitations`, `_invite_keys`, `_admin_events` (also the support audit log), `_company_retention`, `_retention_state`, `_company_limits`, `_workspace_jobs`, `_workspace_authorizations`, plus others listed in `docs/company-workspaces.md`.
- Drafts autosave to a per-user IndexedDB queue and sync when online; conflicts return 409 and keep local work.

## Environments
There is **one** production project and no separate dev project documented. Releases are staged on a tagged Cloud Run revision at 0% traffic, checked, then promoted, then Hosting is deployed. See `docs/RUNBOOK.md`. Test resources (databases, identities and release targets) are to be isolated inside `alert-disaster-field-2026`; D-006's separate test project is superseded (`docs/DECISIONS.md`).

## Destination (accepted, not built yet)
Source: the rebuild plan (`dry-standard-replan` report, sections 3, 7 and 8) under the Technology
Standard Stack. Everything stays in `alert-disaster-field-2026`; test and live get separate
resources there. Every row is a **Gap** today; the stage is the one that closes it. Service and
database names are proposals.

| Area | Today | Destination | Status | Closes in |
|---|---|---|---|---|
| Frontend | static JavaScript in `public/`, no build | TypeScript Next.js with React, Tailwind and shadcn/ui, on Cloud Run (`dryscope-api`) | Gap | S2 shell, S5 workflows, S6 offline |
| Business backend | Python on Cloud Run | Next.js TypeScript server routes with Zod at every boundary | Gap | S2 skeleton, S5 |
| Live relay | Python WebSocket route in the main service | separate Node Cloud Run relay (`dryscope-live`) using the Google Gen AI TypeScript SDK | Gap | S7 |
| Region | service, `(default)` Firestore and evidence in `us-west2`; Live in `us-central1` | active app and data in `us-central1`; `(default)` stays in `us-west2` as the legacy source | Gap | S2 provisioning, S8 cutover |
| Official data | Firestore `(default)` | Cloud SQL Postgres with row-level security; drafts in a named central Firestore field database; submission is one-way Firestore to Postgres | Gap | S3 schema, S5 submit and sign, S8 cutover |
| Schema changes | none; one-off scripts | numbered Drizzle migrations, additive, run before traffic | Gap | S2 |
| Identity | Firebase Auth plus private memberships | Identity Platform with a tenant per company and TOTP for privileged users | Gap | S3, S8 identity mapping |
| Pricing and documents | Python Decimal (`claims.py`, `pricing_v2.py`) | TypeScript calculator with zero byte or hash differences, proved by an A/B harness | Gap | S4 |
| Infrastructure and release | scripts and `.github/workflows/deploy.yml` | Terraform (separate data and app roots) through Actions OIDC, test then live; App Lifecycle Manager after launch | Gap | S2, S11 |
| Tests | pytest, `node:test`, Playwright | new tests in Vitest (the required-docs test is the first); old suites convert by area without weakening | Gap | S1 onward |

Still **[open]** (owner gates in the rebuild plan, section 10): the Google Cloud organization (R1),
the Live and voice-note screening exception (R2), image screening location and Preview status
(R3), Cloud SQL tier and recovery targets (R4), per-company AI ceilings (R5), classification and
retention of existing data (R6), and identity enrollment and recovery timing (R7).

## Testing layers
Python (`tests/`), JS (`npm test`), Playwright browser suite with fake cloud adapters, Firestore emulator job, and real-service checks recorded separately. Device behavior (iPhone camera, mic, Bluetooth, latency) stays open until observed on a device.

The accepted rebuild's future authority boundaries and submit fence are in [Data ownership](data-ownership.md); the code-derived current collection and object manifest is in [Legacy data inventory](legacy-data-inventory.md). These documents describe a planned cutover, not current runtime authority. They are a partial rebuild-stage S1 slice (ownership map, submit protocol and legacy inventory); the S1 spec, AI prompt and model pinning, and golden parity baseline arrive in separate S1 pull requests.
