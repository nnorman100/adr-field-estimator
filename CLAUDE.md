# DryScope (repo: adr-field-estimator) — Claude Code Instructions

A phone web app where a restoration technician walks a water or mold loss once, and leaves with a priced, signable estimate. Serves Alert Disaster Restoration (ADR) first and other restoration companies as isolated company workspaces.

**Read these first, in order:** `AGENTS.md` (rules, pricing, compliance, deployment guardrails — authoritative) → `VISION.md` (what the product is and is not) → `docs/roadmap.md` "Handoff" section → `docs/STATUS.md` (what is built, on, and checked on a phone).
`AGENTS.md` wins any conflict with this file.

## Stack (do not change without the owner's approval)
- Frontend: static web app, **no build step**, plain JavaScript in `public/`, same-origin vendored dependencies only.
- Backend: Python on Google Cloud Run (`backend/`, entry `backend/main.py`), region `us-west2`.
- Data: Firestore (deny-all browser rules) + private evidence bucket. AI: Vertex AI (Gemini).
- Hosting: Firebase Hosting target `alert-disaster`, project `alert-disaster-field-2026`.
- Details: `docs/ARCHITECTURE.md`.

## Commands
- Python tests: `python -m pytest tests -q -p no:cacheprovider`
- JS tests: `npm test`
- Browser tests: `npm run test:browser` (Playwright; run for lifecycle/UI changes)
- Python format/lint: `python -m ruff format . ; python -m ruff check .`
- JS format/lint: `npm run format ; npm run lint`
- Keep `index.html` and `public/index.html` identical.

## Hard rules
1. **Never weaken, skip, delete or loosen a test, eval fixture, threshold or workflow** to get green. Fix the code. The Test guard check blocks it. Never add or request the `test-change-approved` label.
2. **Never run a blanket `firebase deploy`.** Only `firebase deploy --only hosting:alert-disaster --project alert-disaster-field-2026`, after the backend is deployed. You do not deploy, promote, change IAM, secrets, or Firebase Auth settings unless the owner says go for that specific release.
3. **Prices and mandatory wording come from the server** (Decimal math in `backend/claims.py`). A model never supplies a price, overrides a total, or removes required wording.
4. **Company isolation on every business endpoint** — check identity, company membership and job access server-side. Browser capability checks are convenience only. See `docs/ACCESS.md`.
5. **Signed records are immutable.** Later coordination goes in sidecars.
6. No secrets, keys, tokens, prompts, transcripts, emails, addresses or coordinates in logs or in git.
7. Water and mold losses only. Web app only (no native app).
8. Do not read or print secrets; do not touch other Firebase projects or peer sites.

## Every change must
- Be one small PR with a test that fails without it.
- Pass the "eight checks" in `docs/roadmap.md` (rules/indexes, older records, offline, who may use it, app cache/`sw.js`, help/docs, privacy/logs, phone check).
- Add new actions to the role matrix (`can()` in `public/workspaces.js` plus the server check) and update `docs/ACCESS.md`.
- Update `docs/STATUS.md` if a feature's state changes.

## Risk and merging
Low/Medium-risk PRs may be merged by an agent only with green CI and only if the owner has allowed it. High-risk PRs and every production release need the owner's explicit go. When unsure of risk, treat it as High.

## How to work
1. Read the relevant doc first (`docs/company-workspaces.md` for auth/workspaces, `docs/firebase-isolation.md` for cloud, `docs/pricing-source.md` for prices).
2. Search for functions by name; line numbers drift.
3. Write the failing test first, then the smallest change.
4. Run the Python, JS and (for UI) browser tests.
5. Report: what changed, what you were unsure of, what the owner must check on a phone.
6. Work on a branch; open a PR; do not merge unless allowed above.

## Commands for this repo (in `.claude/commands/`)
`/new-slice` drafts a spec; `/review-slice` is an independent review (run in a fresh session).
