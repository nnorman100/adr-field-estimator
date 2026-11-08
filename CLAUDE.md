# DryScope (repo: adr-field-estimator) — Claude Code Instructions

A phone web app where a restoration technician walks a water or mold loss once, and leaves with a priced, signable estimate. Serves Alert Disaster Restoration (ADR) first and other restoration companies as isolated company workspaces.

**Read these first, in order:** `AGENTS.md` (rules, pricing, compliance, deployment guardrails — authoritative) → `VISION.md` (what the product is and is not) → `docs/roadmap.md` "Handoff" section → `docs/STATUS.md` (what is built, on, and checked on a phone).
`AGENTS.md` wins any conflict with this file, except the loop rules in "Merging and releases" below, which come from the owner's standard page. It is imported here so it loads every session:

@AGENTS.md

## Stack (do not change without the owner's approval)
- Frontend: static web app, **no build step**, plain JavaScript in `public/`, same-origin vendored dependencies only.
- Backend: Python on Google Cloud Run (`backend/`, entry `backend/main.py`), region `us-west2`.
- Data: Firestore (deny-all browser rules) + private evidence bucket. AI: Vertex AI (Gemini).
- Hosting: Firebase Hosting target `alert-disaster`, project `alert-disaster-field-2026`.
- Details: `docs/ARCHITECTURE.md`.

## Commands
- Set up (fresh machine or cloud session):
  `python -m pip install --require-hashes -r backend/requirements.txt -r backend/requirements-dev.txt` · `npm ci` · `npx playwright install chromium webkit`
- Firestore emulator tests (needs Java 21+; `demo-` project only, never a real one):
  `npx firebase-tools emulators:exec --only firestore --project demo-adr-emulator "python -m pytest tests/test_firestore_emulator.py -q -p no:cacheprovider"`
- Python tests: `python -m pytest tests -q -p no:cacheprovider`
- JS tests: `npm test`
- Browser tests: `npm run test:browser` (Playwright; run for lifecycle/UI changes)
- Python format/lint: `python -m ruff format . ; python -m ruff check .`
- JS format/lint: `npm run format ; npm run lint`
- Keep `index.html` and `public/index.html` identical.

## Hard rules
1. **Never weaken, skip, delete or loosen a test, eval fixture, threshold or workflow** to get green. Fix the code. The Test guard check blocks it. Never add or request the `test-change-approved` label.
2. **Never run a blanket `firebase deploy`.** Releases run from `.github/workflows/deploy.yml` after each merge (see "Merging and releases"). A hand release uses only `firebase deploy --only hosting:alert-disaster --project alert-disaster-field-2026`, after the backend is deployed. You do not run a hand deploy or promotion, change IAM, secrets, or Firebase Auth settings unless the owner says go for that specific release.
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

## Merging and releases
These loop rules come from the owner's [Technology Standard Stack](https://app.notion.com/p/40f0b80d5e268136aeaedd2044f2eb75) page and supersede decision D-009 (owner, Nov 6, 2026). If that page and this file disagree, the page wins.
- Pull requests merge automatically once every check passes and the independent review approves.
- These still go to the owner: changes that delete data, cannot be undone, or touch security or permissions (`firestore.rules`, IAM, secrets, Firebase Auth settings, workflows), and turning on deletion (such as record retention) or new pricing.
- High-risk pull requests need two separate independent reviews, both approving. High risk means the database (rules, indexes, migrations), sign-in and workspaces/isolation, payments, permissions and pricing, plus signing and email sending. When unsure, treat it as High. Rate each PR's risk in its description.
- No preview sites: every merge deploys test then live. `.github/workflows/deploy.yml` stages a tagged 0% revision and runs the staged checks, then promotes, verifies and rolls back on failure. A production release that changes data or access (rules or indexes, a data migration, a switch that deletes data or changes prices) still needs the owner's go for that release.
- Migrations add first, switch the app over, and remove in a later release. Any removal step (dropping fields, records, files or collections) needs a fresh backup and the owner's approval before it runs.

## How to work
1. Read the relevant doc first (`docs/company-workspaces.md` for auth/workspaces, `docs/firebase-isolation.md` for cloud, `docs/pricing-source.md` for prices).
2. Search for functions by name; line numbers drift.
3. Write the failing test first, then the smallest change.
4. Run the Python, JS and (for UI) browser tests.
5. Report: what changed, what you were unsure of, what the owner must check on a phone.
6. Work on a branch; open a PR; merging follows "Merging and releases" above.

## Commands for this repo (in `.claude/commands/`)
`/new-slice` drafts a spec; `/review-slice` is an independent review (run in a fresh session).
