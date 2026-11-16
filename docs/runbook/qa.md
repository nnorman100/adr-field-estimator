# QA pass before the phone check

Automated tests check the code against what its author expected. A QA pass checks the running app
against what the change was meant to do, the way a person uses it. Every pull request that changes a
screen gets one before the owner's phone check (`docs/roadmap.md`, check 8), so the phone check only
covers what a computer cannot: camera and microphone, Bluetooth audio, iPhone screen behavior,
network handoffs and real signal (`docs/phone-acceptance.md`).

## Start the app: `npm run qa:hold`

In `web/`, with `npm ci` done, Java 21+ (Firestore emulator) and PostgreSQL 16 or Docker (the jobs
server), and the Playwright browsers installed (`npx playwright install chromium webkit`):

```bash
npm run qa:hold        # long-running: start it in the background (tmux), not in the foreground
```

It starts exactly what the browser tests start (`playwright.qa.config.ts` reuses
`playwright.config.ts`): a production build, the Auth, Firestore and Storage emulators under a
`demo-` project, the jobs server with a throwaway PostgreSQL, and the seeded companies and accounts.
Then `tests/qa/hold.spec.ts` keeps it all running. It takes a few minutes (mostly the build). When it
is ready it writes `web/test-results/sign-in-state/qa-info.json`: the app's address, the jobs app's
address and the seeded accounts (company A's owner and estimators, a team company and a prices
company). Their shared password is `PASSWORD` in `web/tests/e2e/sign-in/seed.ts`. The accounts exist
only in the local emulators.

Stop it with `touch web/test-results/sign-in-state/qa-stop` (or Ctrl-C), then check no emulator Java
process is left holding its port.

## Run the pass: `/qa-screen`

`.claude/commands/qa-screen.md` runs the `qa` skill in a fresh session that did not write the change:
it writes scenarios from the request and the diff, drives the app in a browser, confirms each write
where it is stored, and reports each scenario as pass, fail or blocked with evidence.

- Use only the seeded synthetic accounts and data. Never a real company, customer or address
  (AGENTS.md rule 6).
- Evidence (screenshots, logs) stays local, outside the repository; it is never committed.
- Put the report in the pull request description under **QA**: one line per scenario, every fail in
  full, what was blocked and why, and the verdict.
- A fail is fixed test-first in the same pull request, then the pass is run again.
- What QA cannot reach (camera, microphone, Bluetooth, a real iPhone, real signal) is listed as
  blocked and becomes the owner's phone-check list for this pull request.
