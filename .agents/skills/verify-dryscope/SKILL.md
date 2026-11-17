---
name: verify-dryscope
description: Start the DryScope web app (web/) locally with its emulators and a throwaway PostgreSQL, check it is healthy, drive it like a technician or office user in a phone-sized browser, and capture proof. Use before claiming a screen, route or flow works, when asked to "verify", "QA", "run the app" or "run the browser tests", or when a heavy suite needs the shared test slot.
---

# Verify DryScope

Read cold, mid-task. Everything here is a command this repo already has. The app is `web/` (Next.js). Nothing in this skill touches a real project, secret or cloud resource: the emulators run under a `demo-` project on loopback, and the database is a throwaway PostgreSQL 16.

Modelled on pstack's `create-verification-skill` (https://github.com/cursor/plugins/tree/main/pstack/skills/create-verification-skill, MIT licence, Lauren Tan).

All commands use absolute paths or a `( cd ... && ... )` subshell. Set once:

```bash
ROOT=$(git rev-parse --show-toplevel)          # your worktree
WEB=$ROOT/web
EVIDENCE=/tmp/verify-dryscope-$(git -C "$ROOT" rev-parse --short HEAD)   # outside the repo; use your task's data dir if you have one
mkdir -p "$EVIDENCE"
```

## Launch

There is no "start the app and leave it" command. The browser-test config (`web/playwright.config.ts`) starts the whole stack and stops it again. Driving the app means running Playwright. What it starts, in order:

1. Auth and Firestore emulators (Firebase CLI pinned to `firebase-tools@15.31.0`, project `demo-...`).
2. `npm run build`, then `next start` on the main test server (default port 3100), with a local file standing in for the database (sign-in screens).
3. The App Check copy of that server (3103).
4. The Storage emulator.
5. `tests/e2e/jobs/server.ts`: a throwaway PostgreSQL 16 with the real migrations and roles, then the jobs server (3101, and its App Check copy 3104). The job, field and office screens run here.

Once, per worktree:

```bash
( cd "$ROOT" && npm ci )
( cd "$WEB" && npm ci && npx playwright install chromium webkit )
```

Needs: Node 22+, Java 21+ (Firestore emulator), PostgreSQL 16 binaries in `/usr/lib/postgresql/16/bin` or a Docker daemon. The first run fetches `firebase-tools` through `npx --yes`, so it needs the network once.

Always run with `EMU_PORTS=auto` (free ports per run, so two runs never collide) and through the shared slot wrapper (see Isolation). A start from an empty state is the normal case: global setup (`tests/e2e/sign-in/global-setup.ts`) wipes `web/test-results/` and seeds two companies, "Company A Restoration" (`/sign-in/company-a`) and "Company B Restoration", with accounts per browser project. Job-screen specs seed their own company with `seedCompany()` (`tests/e2e/jobs/seed.ts`).

Ready means Playwright has started running tests. Its `webServer` entries wait on these (the ports are the defaults; with `EMU_PORTS=auto` Playwright picks others, so there is nothing to poll by hand):

| Piece | Ready signal |
| --- | --- |
| Firestore emulator (8399) | `GET http://127.0.0.1:8399/` answers |
| Main server (3100) | `GET /api/health` → `{"status":"ok","env":"local"}` |
| Jobs server (3101) | `GET /api/health` → `ok` with the database check passing (503 if Postgres is unreachable) |
| Storage emulator (9499) | the port is open (its root answers 501, which is fine) |

Teardown is automatic when Playwright exits normally. See Cleanup if it was killed.

## Doctor

Read-only. Run it first, and again whenever something looks off. It starts nothing.

```bash
node -v                                              # >= 22
java -version 2>&1 | head -1                         # >= 21
ls /usr/lib/postgresql/16/bin/initdb || docker ps    # PG16 binaries, or a Docker daemon
ls ~/.cache/ms-playwright | grep -E 'chromium|webkit'
ls -d "$ROOT/node_modules" "$WEB/node_modules"       # npm ci was run in both
git -C "$ROOT" rev-parse HEAD; git -C "$ROOT" status --short
uptime                                               # load; see Isolation
ss -ltn | grep -E ':(3100|3101|3103|3104|8399|9399|9499)\b' || echo "default ports free"
( cd "$WEB" && npx playwright test --list | tail -1 )   # "Total: N tests in M files" (538 in 35 on 2026-11-17): config loads, specs compile
```

Worth driving only if: versions are met, both `node_modules` exist, the worktree is the commit you mean to prove, and load is not high. A held default port is another run's: use `EMU_PORTS=auto`, do not kill it.

## Drive

### A. Run the specs that already drive the journey (preferred)

Run one test, not the suite. Specs are in `web/tests/e2e/`; each runs in Chromium and WebKit at 390x844 (a phone). `jobs.spec.ts` covers the field app (jobs, rooms, scope, photos) and the office read-only view; `field-shell.spec.ts` the field shell; `sign-in.spec.ts` and `team.spec.ts` sign-in and team; `prices.spec.ts` prices; `review.spec.ts`/`finish.spec.ts` estimate review.

```bash
SLOT=/root/firstmate/data/test-slots/with-test-slot.sh
# one file
( cd "$WEB" && EMU_PORTS=auto "$SLOT" npx playwright test tests/e2e/jobs.spec.ts --project=chromium --workers=2 --trace on )
# one test, by title text
( cd "$WEB" && EMU_PORTS=auto "$SLOT" npx playwright test tests/e2e/jobs.spec.ts -g "office sees the job read-only" --project=chromium --workers=2 --trace on )
```

`--project=webkit` is the iPhone engine. Run both for a UI change. List what exists before choosing: `npx playwright test tests/e2e/jobs.spec.ts --list`.

### B. A throwaway script of your own (a flow no spec covers)

Write it in `web/tests/e2e/zz-verify-scratch.spec.ts` (untracked; delete it in Cleanup, never commit it). It reuses the same seeded stack and the same sign-in steps the specs use:

```ts
import { expect, test } from '@playwright/test';
import { JOBS_BASE_URL } from './jobs/backend';
import { seedCompany } from './jobs/seed';
import { PASSWORD } from './sign-in/seed';

test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 } });

test('verify: estimator opens My jobs', async ({ page }) => {
  const company = await seedCompany('verify', { estimator: 'estimator' }); // roles: owner | estimator | office
  await page.goto(`/sign-in/${company.address}`);
  await page.getByLabel('Email').fill(company.people.estimator!.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${company.name}` })).toBeVisible({ timeout: 30_000 }); // the first request after start-up is slow
  await page.getByRole('link', { name: 'Open the field app' }).click();
  await expect(page.getByRole('heading', { name: company.name, level: 1 })).toBeVisible();
  // First time on this phone the shell asks "Keep jobs on this phone?". Answer Online only,
  // as tests/e2e/csp-field.spec.ts does; the answer is asked once per company.
  await page.getByRole('button', { name: 'Online only', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible();
  await expect(page.getByRole('main').getByText('No jobs yet.')).toBeVisible(); // loaded, not still "Needs a connection"
  await page.screenshot({ path: process.env.EVIDENCE + '/my-jobs.png', fullPage: true });
});
```

Run it like A, with `EVIDENCE="$EVIDENCE"` in the environment and `-g "verify:"`.

Handles that exist in the app (prefer them over coordinates):

- Sign in: `/sign-in/<address>`, labels `Email`, `Password`, button `Sign in` (exact). After it, heading `Signed in to <company>`, link `Open the field app`.
- Keep jobs prompt: title "Keep jobs on this phone?". Buttons `Keep jobs on this phone` (kept offline; the text is `KEEP_YES` in `src/app/field/field-store-text.ts`) and `Online only`. Always answer `Online only` in a scratch script: it keeps nothing on the browser, so runs do not affect each other. Click it only when visible, since it is not asked again for the same company.
- Field home: heading `My jobs`; link `New job`; field `Property address`; button `Start job`; `New room name` + `Add room`; `Year built`; `Save scope`.
- Office user (role `office`) and owner need the authenticator-app second step, which the Auth emulator cannot do. Use the same fake as `jobs.spec.ts`: `fakeSecondStep(page, { factors: ['Authenticator app'] })` from `tests/e2e/second-step/fake-totp.ts`, then fill `6-digit code` with `APP_CODE`. After sign-in the office view is heading `Company jobs`; jobs open read-only (`Read only.`).
- Another company's user must be refused: assert it as the spec does, do not skip it.

## Evidence

A proof contains: (1) the exact command, (2) its output (pass/fail line and counts, not a paraphrase), (3) the head SHA it ran on (`git rev-parse HEAD`), (4) for any UI change, a screenshot or trace of the real screen at phone width. Save them in `$EVIDENCE`:

```bash
git -C "$ROOT" rev-parse HEAD > "$EVIDENCE/sha.txt"
# pipe the run through tee so the output is kept:  ... 2>&1 | tee "$EVIDENCE/run.log"
cp -r "$WEB/test-results" "$EVIDENCE/test-results"   # traces (trace.zip), failure screenshots; copy BEFORE the next run, it empties this folder
( cd "$WEB" && npx playwright show-trace "$EVIDENCE/test-results/<test-dir>/trace.zip" )   # open one by hand if needed
```

Standards:

- Exercise the real user path through the screens. Never call an internal setter, seed a result into the database to make a screen pass, or use a test-only endpoint to skip a step the user does.
- Capture the action and the resulting state, not only the last screen. Check side effects as well as what shows: `storedJobs()` / `storedPhotos()` in `tests/e2e/jobs/seed.ts` read what the app saved.
- A failing run is a result. Report its output. Never weaken, skip or delete a test, loosen a threshold or add a retry to turn it green (AGENTS.md hard rule 1). Rerun a timeout unchanged only when load is below about 12; never raise a timeout.
- Say what you did not verify: a real camera, microphone, iPhone or signal is the owner's phone check.
- Playwright runs a local production build, not Cloud Run. State that when you quote a result.

## Isolation

- Heavy suites go through the slot wrapper: `/root/firstmate/data/test-slots/with-test-slot.sh <command>` (waits for a free slot). That is every full or multi-file Playwright run, `npm run test:db` and `npm run test:emu`. One heavy suite at a time on this shared host; a single spec file or `-g` test may skip it.
- `EMU_PORTS=auto` on every run that starts emulators or servers. Fixed ports (3100, 3101, 3103, 3104, 8399, 9399, 9499) are taken by anyone else's default run.
- `--workers=2`, as CI uses. More workers on this host push single tests toward their 60-second timeout.
- Do not run two verification runs from one worktree: `web/test-results/` is emptied at each start.
- Stop what you started, nothing else.

## Other checks (what CI runs)

```bash
( cd "$ROOT" && npm run format:check && npm run lint && npx vitest run )
( cd "$WEB" && npm run typecheck && npm run lint && npm test && npm run build )
( cd "$WEB" && "$SLOT" npm run test:db )                        # local PostgreSQL 16, row-level security tests
( cd "$WEB" && EMU_PORTS=auto "$SLOT" npm run test:emu )        # Auth/Firestore emulator tests (demo- project only)
```

CI-equivalent browser run is four shards, two workers each. One shard locally (a whole shard is long, so use the slot):

```bash
( cd "$WEB" && E2E_SHARD=1/4 EMU_PORTS=auto "$SLOT" npm run test:e2e -- --workers=2 )   # then 2/4, 3/4, 4/4, one after another
```

To prove a whole change, run all four shards one after another, not at once. For a one-slice change run the specs that cover it in both projects, and say plainly that the other shards were left to CI.

## Cleanup

Playwright stops its servers and emulators itself (SIGINT for the emulators, SIGTERM for the jobs server, which removes its database). After a normal exit there is nothing to do except:

```bash
rm -f "$WEB/tests/e2e/zz-verify-scratch.spec.ts"      # if you made one; git status must be clean
git -C "$ROOT" status --short
```

After a killed or timed-out run, look for what is still listening on the ports your run used and stop only those processes:

```bash
ss -ltnp | grep -E ':(3100|3101|3103|3104|8399|9399|9499)\b'   # default ports; with EMU_PORTS=auto the ports are in 20000-30000
```

Stop a process only if its working directory or command line is your `$WEB` (`ls -l /proc/<pid>/cwd`). Never kill by name (`pkill java`, `pkill node`): other lanes' runs use the same binaries. Stale emulator lock files release themselves when their holder is gone. Evidence in `$EVIDENCE` stays.

## Gotchas

- `web/test-results/` is emptied by Playwright at the start of each run. Copy evidence out first.
- A server started by hand has none of the emulator settings the specs expect; do not point a spec at one (`reuseExistingServer` is false).
- Playwright's WebKit cannot route a page a service worker controls, so the suite blocks service workers unless a spec asks for them. A scratch script that depends on the field worker needs `test.use({ serviceWorkers: 'allow' })`, as `field-shell.spec.ts` does.
- The first sign-in after start-up can show "Checking your sign-in…" for longer than Playwright's 5-second default on a loaded host. Give that first wait `{ timeout: 30_000 }` in a scratch script. Do not change a repo spec's timeout.
- `npm run build` runs inside the browser run, so a first run is slow (up to 300 seconds is allowed). If build fails, that is the finding.
- Never read, print or log secrets, emails, addresses or tokens beyond the synthetic `example.com` accounts the seed makes.
