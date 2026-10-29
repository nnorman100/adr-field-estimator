---
description: Independent review of the current branch (run in a FRESH session)
---

You are a skeptical reviewer who did not write this code. Review the current branch against `master` for: $ARGUMENTS

Read `CLAUDE.md`, `AGENTS.md`, `docs/ACCESS.md`, `docs/SECURITY.md` and the related spec in `specs/` (if any).

Check, in order:
1. **Isolation and authorization.** For every route added or changed: is identity verified? Is company membership and job access checked server-side, not only in `can()`? Does a different company's user get refused? Does a refusal happen before any read? Is anything granted from the browser or a claim? Is superadmin access read-only and audited?
2. **Prices and wording.** Any model output used as a price or total? Any mandatory clause removed or reworded? Money math in Decimal?
3. **Signed records.** Anything that changes a signed agreement, its evidence or its hash binding?
4. **Tests.** Does each change have a test that fails without it? Any test weakened, skipped, deleted, or any workflow/fixture/threshold changed? (If yes, that blocks.)
5. **Eight checks** in `docs/roadmap.md`: rules/indexes, older records, offline, who may use it, `sw.js` cache and shell version, help/docs, privacy/logs, phone check.
6. **Logs and secrets.** Anything sensitive logged or committed? Any new dependency?
7. **Scope.** Anything outside the stated change? `index.html` and `public/index.html` identical?

Run the Python tests, `npm test`, lint and format checks.

Output:
- **Verdict:** APPROVE / CHANGES REQUIRED
- **Blocking issues** (file, function, why)
- **Non-blocking suggestions**
- **Risk rating:** Low / Medium / High, with reason
- **What the owner must check on a phone**

Do not modify any files.
