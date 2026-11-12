# DryScope (repo: adr-field-estimator) — Claude Code Instructions

A phone web app where a restoration technician walks a water or mold loss once, and leaves with a priced, signable estimate. Serves Alert Disaster Restoration (ADR) first and other restoration companies as isolated company workspaces.

**Read these first, in order:** `AGENTS.md` (rules, pricing, compliance, deployment guardrails — authoritative) → `VISION.md` (what the product is and is not) → `docs/roadmap.md` "Handoff" section → `docs/STATUS.md` (index of `docs/status/`: what is built, on, and checked on a phone).
`AGENTS.md` wins any conflict with this file. It is imported here so it loads every session:

@AGENTS.md

## Stack (do not change without the owner's approval)
- The app is the rebuild in `web/`: TypeScript, Next.js (React, Tailwind) with Zod at every route boundary. Business logic (pricing, documents, mandatory wording) is in `web/src/engine/`, access rules in `web/src/lib/access/`.
- Hosting: Cloud Run in Google Cloud project `dryscope`, region `us-central1`; `test` and `live` resources are defined in `infra/dryscope/` (Terraform).
- Data: Cloud SQL Postgres with row-level security and numbered Drizzle migrations (`web/migrations`); drafts in a Firestore field database with deny-all browser rules (`web/firestore.rules`).
- The old app (`backend/`, `public/`, `tests/`, project `alert-disaster-field-2026`, `us-west2`) is retired and switched off. Its files are frozen reference code, deleted in S8; do not change them except through S8 (`docs/runbook/ci.md`, "Legacy CI retired"), and do not deploy or touch its project.
- Details: `docs/ARCHITECTURE.md`.

## Commands
Run from the repo root unless a line says `web/`. CI runs exactly these (`.github/workflows/ci.yml`, `.github/workflows/web.yml`).
- Set up (fresh machine or cloud session): `npm ci` at the root and in `web/`; for browser tests, `npx playwright install chromium webkit` in `web/`.
- Root checks (the `node` job): `npm run format:check`, `npm run lint` (ESLint, file-length limit, required docs), `npx vitest run` (Terraform plan check and the workflow guards).
- Web unit tests: `npm test`, type check `npm run typecheck`, lint `npm run lint`, build `npm run build` (all in `web/`).
- Web database tests: `npm run test:db` (in `web/`; starts a throwaway PostgreSQL 16 that must run locally).
- Firestore rules and Auth emulator tests: `npm run test:emu` (in `web/`; needs Java 21+; `demo-` project only, never a real one).
- Browser tests: `npm run test:e2e` (in `web/`, Playwright, Chromium and WebKit; run for UI changes).
- Format: `npm run format` at the root.

## Hard rules
1. **Never weaken, skip, delete or loosen a test, eval fixture, threshold or workflow** to get green. Fix the code. The Test guard check blocks it. Never add or request the `test-change-approved` label.
2. **Never run a blanket `firebase deploy`.** The rebuild releases through `.github/workflows/web-release.yml` (`docs/runbook/test-release.md`), never from a laptop. You do not deploy, promote, change IAM, secrets, or Firebase Auth settings unless the owner says go for that specific release.
3. **Prices and mandatory wording come from the server** (Decimal math in `web/src/engine/`). A model never supplies a price, overrides a total, or removes required wording.
4. **Company isolation on every business endpoint** — check identity, company membership and job access server-side. Browser capability checks are convenience only. See `docs/ACCESS.md`.
5. **Signed records are immutable.** Later coordination goes in sidecars.
6. No secrets, keys, tokens, prompts, transcripts, emails, addresses or coordinates in logs or in git.
7. Water and mold losses only. Web app only (no native app).
8. Do not read or print secrets; do not touch other Firebase projects or peer sites.

## Every change must
- Be one small PR with a test that fails without it.
- Pass the "eight checks" in `docs/roadmap.md` (rules/indexes, older records, offline, who may use it, app cache/`sw.js`, help/docs, privacy/logs, phone check).
- Add new actions to the role matrix (`web/src/lib/access/roles.ts` and `can.ts`, plus the server check) and update `docs/ACCESS.md`.
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
1. Read the relevant doc first (`docs/ACCESS.md` and the stage plan in `docs/plans/` for auth and workspaces, `infra/dryscope/README.md` and `docs/runbook/` for cloud, `docs/pricing-source.md` for prices).
2. Search for functions by name; line numbers drift.
3. Write the failing test first, then the smallest change.
4. Run the checks under Commands, and the browser tests for UI changes.
5. Report: what changed, what you were unsure of, what the owner must check on a phone.
6. Work on a branch; open a PR; it merges only as allowed above.

## Commands for this repo (in `.claude/commands/`)
`/new-slice` drafts a spec; `/review-slice` is an independent review (run in a fresh session).
