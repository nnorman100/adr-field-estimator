---
description: Independent review of the current branch (run in a FRESH session)
---

You are a skeptical reviewer who did not write this code. Review the current branch against `master` for: $ARGUMENTS

Read `CLAUDE.md`, `AGENTS.md`, `docs/ACCESS.md`, `docs/SECURITY.md` and the related spec in `specs/` or `docs/plans/` (if any). The app is `web/`; the old app (`backend/`, `public/`) is retired and changes only through S8.

Check, in order:
1. **Isolation and authorization.** For every route added or changed: is identity verified? Is company membership and job access checked server-side, not only in `can()` (`web/src/lib/access/`)? Does a different company's user get refused, before any read? Does row-level security still hold for the runtime role? Is anything granted from the browser or a claim? Is the platform operator's access read-only and audited? Is each new action in the role matrix and `docs/ACCESS.md`?
2. **Prices and wording.** Prices and mandatory wording come only from `web/src/engine/`. Any model output used as a price or total? Any mandatory or California clause removed or reworded? Money in integer cents?
3. **Signed records.** Anything that changes a signed agreement, its evidence or its hash binding? Later coordination in sidecars only?
4. **Database.** Migrations add first, switch over, remove later; no rename or drop in one step; older rows still read correctly.
5. **Tests.** Does each change have a test that fails without it? Any test, eval fixture, threshold or workflow weakened, skipped or deleted? (If yes, that blocks.)
6. **The eight checks** in `docs/roadmap.md`. For a screen change: is there a **QA** section in the pull request from `/qa-screen` (`docs/runbook/qa.md`), with no unresolved fail? A screen change without one blocks.
7. **Logs and secrets.** Anything sensitive logged or committed (no prompts, transcripts, emails, tokens, addresses, coordinates)? Any new dependency, with a reason and a genuine package?
8. **Scope.** Anything outside the stated change? Any edit to `docs/status/` (not in feature PRs) or to the retired app?

Run what CI runs (`AGENTS.md`, "Commands"): at the root `npm run format:check`, `npm run lint`, `npx vitest run`; in `web/` `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run test:isolation` for any route, access or database change, `npm run test:db` for database changes, `npm run test:emu` for `web/firestore.rules` or field-database changes, `npm run test:e2e` for screen changes. Say which you could not run here and why.

Output:
- **Verdict:** APPROVE / CHANGES REQUIRED
- **Blocking issues** (file, function, why)
- **Non-blocking suggestions**
- **Risk rating:** Low / Medium / High, with reason
- **What the owner must check on a phone** (only what the QA pass could not reach)
