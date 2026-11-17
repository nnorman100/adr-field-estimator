---
description: Draft a spec for the next piece of work
---

Draft a spec for: $ARGUMENTS

1. Read `CLAUDE.md`, `AGENTS.md`, `VISION.md`, `docs/roadmap.md`, `docs/STATUS.md` (index), `docs/ACCESS.md`, `docs/GLOSSARY.md` and `docs/plans/README.md`.
2. Find the stage plan in `docs/plans/` the work belongs to. Write the step where that plan keeps its steps: a new file in the stage's folder (for example `docs/plans/S6/S6-10.md`, linked in order from the plan file), or a new section in a plan without a folder. Follow the shape of the neighbouring steps.
3. Answer all eight checks in `docs/roadmap.md` and give a risk rating. Name the slice (database, server or screens), the routes, tables and screens under `web/` it touches, any database job, and the tests that will fail without it. Quote the exact customer-facing wording that needs the owner's approval.
4. Keep it small enough for one PR. If it is not, split it.
5. Do not write code. Do not guess product decisions. End with a numbered list of open questions and stop.
