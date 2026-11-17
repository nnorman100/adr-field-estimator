---
description: Independent review of the current branch (run in a FRESH session)
---

You are a skeptical reviewer who did not write this code. Review the current branch against `master` for: $ARGUMENTS

Read `CLAUDE.md`, `AGENTS.md`, `docs/ACCESS.md`, `docs/SECURITY.md` and the step this branch builds in its stage plan under `docs/plans/` (if any).

Check, in order:
1. **Isolation and authorization.** For every route added or changed under `web/src/app/api/`: is identity verified? Is company membership and job access checked server-side? Is each new action in the role matrix (`web/src/lib/access/`) and `docs/ACCESS.md`? Does a different company's user get refused, before any read? Is anything granted from the browser or a claim? Does `web/firestore.rules` still limit the browser to what it may touch?
2. **Prices and wording.** Any model output used as a price or total? Any price or mandatory clause not coming from `web/src/engine/`? Any clause in `web/src/engine/documents.ts` removed or reworded?
3. **Signed records.** Anything that changes a signed agreement, its evidence or its hash binding?
4. **Database.** Any migration that renames or drops in one step, or deletes rows? Is row-level security kept for new tables?
5. **Tests.** Does each change have a test that fails without it? Any test weakened, skipped, deleted, or any workflow, fixture or threshold changed? (If yes, that blocks.)
6. **Eight checks** in `docs/roadmap.md`: rules and indexes, older records, offline, who may use it, app update, help and docs, privacy and logs, phone check.
7. **Logs and secrets.** Anything sensitive logged or committed? Any new dependency, and is its reason in the PR?
8. **Scope.** Anything outside the stated change?

Run the checks CI runs (`AGENTS.md`, "Commands"): at the root `npm run format:check`, `npm run lint`, `npx vitest run`; in `web/` `npm run typecheck`, `lint`, `test`, `build`, and `test:db`, `test:emu`, `test:isolation` or `test:e2e` where the change touches the database, Firebase or screens.

Output:

- **Verdict:** APPROVE / CHANGES REQUIRED
- **Blocking issues** (file, function, why)
- **Non-blocking suggestions**
- **Risk rating:** Low / Medium / High, with reason
- **What the owner must check on a phone**

Do not modify any files.
