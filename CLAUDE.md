# DryScope (repo: adr-field-estimator) — Claude Code Instructions

A phone web app where a restoration technician walks a water or mold loss once, and leaves with a priced, signable estimate. Serves Alert Disaster Restoration (ADR) first and other restoration companies as isolated company workspaces.

**Read these first, in order:** `AGENTS.md` (rules, pricing, compliance, deployment guardrails — authoritative) → `VISION.md` (what the product is and is not) → `docs/roadmap.md` "Handoff" section → `docs/STATUS.md` (index of `docs/status/`: what is built, on, and checked on a phone).
`AGENTS.md` wins any conflict with this file. It is imported here so it loads every session:

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
  `npx firebase-tools emulators:exec --only firestore --project demo-adr-emulator "python -m pytest tests/test_firestore_emulator*.py -q -p no:cacheprovider"`
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
- Do not edit `docs/status/` in feature PRs; status is updated in a batch after merges.

## Technology Standard 2.2 (rules agents need)
Profile: `docs/ARCHITECTURE.md` (top). Recorded exceptions: `docs/DECISIONS.md` D-013 to D-015. D-016 (owner- or operator-run company sign-in tenants for the pilot) is a decision now written into the standard, not an exception. Stage plans and corrections live in `docs/plans/`.
- **Migrations:** add first, switch over, remove later. Never rename or drop in one step. Drops or row deletions need a fresh backup and owner approval. Additive migrations apply automatically on the test copy: today from the release workflow's `migrate` job (`.github/workflows/web-release.yml`), moving to a Cloud Run job inside Google (PR #297). Live migrations need the owner until three clean releases. One database-changing job at a time.
- **Release path** (the rebuilt app in `web/`): every merge to `master` releases to test with smoke tests; live comes later; the urgent-fix workflow and the release manifest are planned, not present yet. See `docs/RUNBOOK.md` (index of `docs/runbook/`), mainly `docs/runbook/releases.md` and `docs/runbook/test-release.md`.
- **CI** runs on the self-hosted runner pool. Agents never set or delete `CI_RUNNER` or switch a job to GitHub-hosted runners (the owner has a $0 Actions hard stop); the owner uses that switch only as a fallback after raising the Actions budget above $0, and deletes it afterwards. See `docs/runbook/ci.md` (CI runners).
- **New dependency:** give the reason in the PR, check the package is genuine (publisher, downloads, repository), and get reviewer approval.

## Risk and merging
The owner approves every merge: agents ask before merging any PR and nothing merges automatically (D-009, kept on Nov 9, 2026; D-012). High-risk work needs two separate independent reviews on top of the pipeline review, from models that did not write the code. Deploys run to test first, then live. Still owner-only: anything that deletes data, cannot be undone, or changes security or permissions (IAM, secrets, Firebase Auth settings); turning on deletion or new pricing; and production steps the owner runs. Still rate each PR's risk in its description. Anything touching auth, workspaces/isolation, pricing, signing, email sending, `firestore.rules`, IAM, secrets or workflows is High. When unsure, treat it as High.

## How to work
1. Read the relevant doc first (`docs/company-workspaces.md` for auth/workspaces, `docs/firebase-isolation.md` for cloud, `docs/pricing-source.md` for prices).
2. Search for functions by name; line numbers drift.
3. Write the failing test first, then the smallest change.
4. Run the Python, JS and (for UI) browser tests.
5. Report: what changed, what you were unsure of, what the owner must check on a phone.
6. Work on a branch; open a PR; it merges only as allowed above.

## Commands for this repo (in `.claude/commands/`)
`/new-slice` drafts a spec; `/review-slice` is an independent review (run in a fresh session).
