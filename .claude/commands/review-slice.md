---
description: Independent review of the current branch against master (run in a FRESH session)
---

You are a skeptical reviewer who did not write this code. Review the current branch against `master` for: $ARGUMENTS

Read `AGENTS.md`, `docs/ACCESS.md`, `docs/architecture/product-rules.md` (the product and California rules) and `docs/roadmap.md` (the eight checks). If the change belongs to a stage, read its plan in `docs/plans/` (see `docs/plans/README.md`) and the step file it names.

Check, in order:
1. **Isolation and authorization.** Every business route checks identity, company membership and job access on the server. Job routes go through `jobAccess` in `web/src/lib/jobs/access.ts`, and new actions are in the role matrix (`web/src/lib/access/`) and `docs/ACCESS.md`. A user of a different company is refused, and the refusal happens before any read. Nothing is granted from the browser or a claim. Superadmin access is read-only and audited. Each new route is in `web/tests/db/isolation-matrix.ts`.
2. **Prices and wording.** No model output is used as a price or total. Prices come from the company's own price book through the engine in `web/src/engine/`, and no price means no estimate. No mandatory clause is removed or reworded; compare the California pre-1978 and estimate clauses with `docs/architecture/product-rules.md`. Money is never computed with floating-point numbers.
3. **Signed records.** Nothing changes a signed agreement, its evidence or its hash binding. Later coordination goes in sidecar records.
4. **Tests.** Each change has a test that fails without it. No test, eval fixture, threshold or workflow was weakened, skipped, deleted or loosened (AGENTS.md hard rule 1). If any was, that blocks the review.
5. **The eight checks** in `docs/roadmap.md`: rules and indexes, older records, offline, who may use it, app update and cache (`web/sw/sw.js`), help and docs, privacy and logs, and the owner's phone check.
6. **Logs and secrets.** Server logs go through `web/src/lib/log.ts` and write only allowlisted fields. Nothing sensitive is logged or committed. Any new dependency has a stated reason.
7. **Scope.** Nothing outside the stated change. The change is one slice; if it is more than one, say how to split it.

Run the checks that the change touches, as listed in `AGENTS.md` under "Commands": at the root, `npm run format:check`, `npm run lint` and `npx vitest run`; in `web/`, `npm run typecheck`, `npm run lint`, `npm run test` and `npm run build`. Leave the slow browser and database suites to CI unless the person asks for them.

Output:
- **Verdict:** APPROVE / CHANGES REQUIRED
- **Blocking issues** (file, function, why)
- **Non-blocking suggestions**
- **Risk rating:** Low / Medium / High, with reason. Per `AGENTS.md`, anything touching auth, workspaces or isolation, pricing, signing, email, `firestore.rules`, IAM, secrets or workflows is High, and so is anything you are unsure about.
- **What the owner must check on a phone** (see `docs/phone-acceptance.md`)

Do not modify any files.
