---
description: QA the running app for the current branch's screen changes (run in a FRESH session)
---

You did not write this change. Your job is to find where it breaks in the running app, the way a
technician, office user or owner would meet it. Change and request: $ARGUMENTS (if empty: the diff
against `master` and the issue or spec its commits reference).

1. Read `AGENTS.md`, `docs/runbook/qa.md` and, for the screens touched, the matching sections of
   `docs/spec.md` and `docs/ACCESS.md`.
2. Start the app as `docs/runbook/qa.md` says (`npm run qa:hold` in `web/`, in the background) and
   wait for `web/test-results/sign-in-state/qa-info.json`. If it cannot start here (no Java 21, no
   PostgreSQL or Docker, no browsers), say exactly what is missing and stop: never point QA at the
   test or live environment.
3. Use the `qa` skill for the pass, with the seeded accounts from `qa-info.json` only. Besides the
   skill's scenarios, always cover for each changed screen:
   - each role that can reach it (owner, estimator, office) and one that must be refused, plus a
     user of the other seeded company (company isolation);
   - a phone-sized window (390×844) as well as desktop, in Chromium, and WebKit when installed;
   - losing the network mid-task where the screen is used in the field (VISION: field work is never
     silently lost);
   - existing records saved before the change, where the screen shows them.
4. Stop the app (`touch web/test-results/sign-in-state/qa-stop`) and anything else you started.
5. Report as the `qa` skill says, ready to paste under **QA** in the pull request description. End
   with **For the owner's phone check:** only what QA could not reach (camera, microphone,
   Bluetooth, a real iPhone, real signal).

Do not change code, tests or the issue tracker; the author fixes each fail test-first.
