---
description: Draft a spec for the next piece of work
---

Draft a spec for: $ARGUMENTS

1. Read `AGENTS.md`, `VISION.md`, `docs/roadmap.md` (the eight checks), `docs/STATUS.md` (what is built and switched on), `docs/ACCESS.md`, `docs/GLOSSARY.md` and `docs/spec.md` (current behaviour, roles in section 1).
2. Find the stage plan the work belongs to in `docs/plans/README.md`, and read its steps and its section 9, which says what the eight checks mean for that stage. If no stage plan covers the work, say so and ask where it belongs before going on.
3. Write the spec in your reply. Do not create or edit files: stage plans in `docs/plans/` are the reviewed record, and the owner or the stage author adds an approved step there. Cover:
   - Goal: what a person can do afterwards that they could not do before.
   - Who it is for: the roles in `docs/spec.md` section 1.
   - Out of scope.
   - Behaviour: screens and steps. Quote the exact customer-facing wording that needs the owner's approval.
   - Backend and data: the routes, the Postgres tables and the migration (add first, switch over, remove later), and whether each record is signed (signed records never change) or a sidecar.
   - The eight checks from `docs/roadmap.md`, each answered in one line.
   - Acceptance criteria, each with a test that fails without the change.
   - Tests: Vitest in `web/tests/unit/`, database tests in `web/tests/db/`, emulator tests for `firestore.rules`, and Playwright end-to-end tests in `web/tests/e2e/` for screens.
   - Rollback: whether rolling back loses data or features. Prefer fixing forward.
   - Risk rating: Low, Medium or High, using the list in `AGENTS.md`.
4. Keep it small enough for one PR. If it is not, split it into named slices and say what each one contains.
5. Do not write code. Do not guess product decisions. End with a numbered list of open questions and stop.
