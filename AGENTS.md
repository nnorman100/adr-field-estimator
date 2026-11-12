# DryScope (repo: adr-field-estimator)

A phone web app: a restoration technician walks a water or mold loss once and leaves with a priced, signable estimate. Serves Alert Disaster Restoration (ADR) first, then other companies as isolated workspaces. Read `VISION.md`, then `docs/STATUS.md`. Product, engine and California wording rules: `docs/ARCHITECTURE.md` ("Product rules"). Pricing: `docs/pricing-source.md`. Access: `docs/ACCESS.md`.

## Stack (owner approval to change)
The app is `web/`: TypeScript, Next.js, Zod at every route boundary; Cloud SQL Postgres with row-level security and Drizzle migrations, a Firestore field database, Cloud Run `us-central1`, project `dryscope` (Terraform in `infra/dryscope/`). The old app (`backend/`, `public/`, project `alert-disaster-field-2026`) is retired; change it only through S8 (`docs/runbook/ci.md`). Details: `docs/ARCHITECTURE.md`.

## Commands (what CI runs)
- Set up: `npm ci` at the root and in `web/`; `npx playwright install chromium webkit` in `web/`.
- Root: `npm run format:check`, `npm run lint`, `npx vitest run`.
- In `web/`: `npm run typecheck`, `lint`, `test`, `build`, `test:db` (local PostgreSQL 16), `test:emu` (Java 21+, `demo-` project only), `test:e2e` (Playwright, for UI changes).

## Hard rules
1. Never weaken, skip, delete or loosen a test, eval fixture, threshold or workflow to get green; fix the code. The Test guard blocks it. Never add or request `test-change-approved`.
2. Never run a blanket `firebase deploy`. Releases go through `.github/workflows/web-release.yml` (`docs/runbook/test-release.md`). You never deploy, promote, or change IAM, secrets or Firebase Auth settings.
3. Prices and mandatory wording come from the server (`web/src/engine/`); a model never supplies a price or removes wording. Each company sets its own prices; no price, no estimate.
4. Company isolation on every business endpoint: check identity, membership and job access server-side. New actions go in the role matrix (`web/src/lib/access/`) and `docs/ACCESS.md`.
5. Signed records are immutable; later coordination goes in sidecars.
6. No secrets, keys, tokens, prompts, transcripts, emails, addresses or coordinates in logs or git. Never read or print secrets; never touch other projects or peer sites.
7. Water and mold losses only; web app only. ADR identity (CSLB #950983, sign-off Matthew Myers) and the California pre-1978 and estimate clauses are exact: keep them as in `docs/ARCHITECTURE.md`.

## Every change
One small PR with a test that fails without it; the eight checks in `docs/roadmap.md`; no edits to `docs/status/` in feature PRs (updated in a batch after merges). Report what changed, what you were unsure of, and what the owner must check on a phone. Search functions by name; write the failing test first.

## Technology Standard 2.6 (build and agent rules)
Profile and exceptions: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (D-013 to D-016); stage plans: `docs/plans/`.
- Migrations: add first, switch over, remove later; never rename or drop in one step. Drops or row deletions need a fresh backup and the owner. Test-copy migrations run from the release workflow's job; live ones need the owner. One database-changing job at a time.
- CI runs on the self-hosted pool. Never set or delete `CI_RUNNER` or move a job to GitHub-hosted runners ($0 Actions hard stop).
- New dependency: reason in the PR, check the package is genuine, reviewer approval.
- UI work: consult the Modern Web Guidance skill (`.agents/skills/modern-web-guidance`).

## Risk and merging (D-009, standing approval 2026-11-12)
Rate each PR Low, Medium or High in its description; auth, workspaces/isolation, pricing, signing, email, `firestore.rules`, IAM, secrets, workflows or unsure means High. Worker agents never merge. The supervising agent may merge Low and Medium PRs once green, waive only known infrastructure check failures (reason on the PR), and do housekeeping. High-risk PRs need the owner's approval. Deletions, money, permissions, cloud, live and anything irreversible stay with the owner.
