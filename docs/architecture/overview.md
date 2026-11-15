# Architecture: Overview, two engines and where things are

Part of [Architecture](../ARCHITECTURE.md).

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

The diagram shows the current Python app, which lives in Google Cloud / Firebase project `alert-disaster-field-2026`; the rebuild's test environment is in project `dryscope` (see Environments). Peer sites and shared databases are never touched.

## Two engines

1. **Live walkthrough** — authenticated WebSocket relay; 16 kHz audio and a 640 px frame every 2 s; coaching and meter-photo reading.
2. **Claims engine** — `POST /api/audit`: transcript + photos + facts → four documents. The server applies prices and mandatory wording; the model drafts only.
   Models are set by `AUDIT_MODEL`, `OCR_MODEL`, `LIVE_MODEL`.

## Where things are

| Area                                          | Files                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell, lifecycle, camera/audio, offline   | `public/app.js`, `core.js`, `audio-worklet.js`, `sw.js`                                                                                                                                                                                                                                                              |
| Documents (4) rendering                       | `public/documents.js`                                                                                                                                                                                                                                                                                                |
| Homeowner signing and read-only document page | `public/sign.html`, `sign.js`                                                                                                                                                                                                                                                                                        |
| Workspaces, roles, jobs list                  | `public/workspaces.js`, `backend/workspaces.py`, `workspace_api.py`                                                                                                                                                                                                                                                  |
| Pricing, documents, mandatory wording         | `backend/claims.py`, `contracts.py`, `price_books.py`, `docs/pricing-source.md`                                                                                                                                                                                                                                      |
| Revisions, evidence, quotas                   | `backend/inspection_store.py`, `job_store.py`                                                                                                                                                                                                                                                                        |
| Signing and document links                    | `backend/signing_links.py`, `document_links.py`                                                                                                                                                                                                                                                                      |
| Drying log / watch                            | `psychrometrics.py`, `drying_watch.py`, `public/drying*.js`                                                                                                                                                                                                                                                          |
| Delivery (email)                              | `backend/delivery.py`, `workspaces.py`                                                                                                                                                                                                                                                                               |
| Price books (off by default)                  | `price_book_*.py`, `price_books.py`, `price_table.py` (v2 tables; starter catalog rows in `price_table_starter.py`, presentation, v1 conversion and diffs in `price_table_comparison.py`), `pricing.py` (calculation dispatch), `pricing_v2.py` (v2 calculation), `public/scope-items.js` (v2 Check Scope item list) |
| Job close, estimate accuracy                  | `backend/outcomes.py`, `public/job-close.js`, `public/estimate-accuracy.js`, `docs/estimate-assist.md`                                                                                                                                                                                                               |
| Warnings while estimating                     | `backend/estimate_warnings.py`, `public/app.js` (the readiness dialog), `docs/estimate-assist.md`                                                                                                                                                                                                                    |
| Readiness, insights, AI usage                 | `readiness.py`, `insights.py`, `ai_usage.py`                                                                                                                                                                                                                                                                         |
| Funded AI generation and cooldowns            | `backend/ai_generation.py`, `ai_spending.py`, `live_spending.py`, `public/ai-spending-ui.js`                                                                                                                                                                                                                         |
| Feature flags                                 | `AI_FEATURES`, `PRICE_BOOKS_ENABLED`, `RETENTION_ENABLED`, `WORKSPACES_ENABLED` (set by `scripts/deploy_backend.py`)                                                                                                                                                                                                 |
| Release scripts                               | `scripts/deploy_backend.py`, `stamp_hosting.py`, `verify_*`, `auto_deploy.py` (automatic deploys; shared helpers in `auto_deploy_helpers.py`)                                                                                                                                                                        |
