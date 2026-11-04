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
| Readiness, insights, AI usage | `readiness.py`, `insights.py`, `ai_usage.py` |
| Feature flags | `AI_FEATURES`, `PRICE_BOOKS_ENABLED`, `WORKSPACES_ENABLED` (set by `scripts/deploy_backend.py`) |
| Release scripts | `scripts/deploy_backend.py`, `stamp_hosting.py`, `verify_*`, `auto_deploy.py` (automatic deploys) |

## Data model (high level)
- Signed agreements and evidence are **immutable**. Mutable coordination (assignment, claim details, delivery, readings) lives in **sidecars** beside the job.
- Private collections: `_companies`, `_memberships`, `_platform_admins`, `_invitations`, `_invite_keys`, `_admin_events` (also the support audit log), `_company_limits`, `_workspace_jobs`, `_workspace_authorizations`, plus others listed in `docs/company-workspaces.md`.
- Drafts autosave to a per-user IndexedDB queue and sync when online; conflicts return 409 and keep local work.

## Environments
There is **one** production project and no separate dev project documented. Releases are staged on a tagged Cloud Run revision at 0% traffic, checked, then promoted, then Hosting is deployed. See `docs/RUNBOOK.md`. [Decision needed: a separate dev project — see `docs/DECISIONS.md` D-006.]

## Testing layers
Python (`tests/`), JS (`npm test`), Playwright browser suite with fake cloud adapters, Firestore emulator job, and real-service checks recorded separately. Device behavior (iPhone camera, mic, Bluetooth, latency) stays open until observed on a device.
