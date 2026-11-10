# CI and the pipeline gate

## Pipeline gate settings

`.no-mistakes.yaml` sets the repo-level no-mistakes gate rules: protected paths (workflow files, `CLAUDE.md`, `AGENTS.md`, `scripts/test-guard.mjs` and `.github/test-guard.json`, which automatic fixes must leave for a person) and two review auto-fix rounds. The reviewer agent is a global-only setting. Protected paths take effect once this file is on `master`.

## CI runners

Every job in `.github/workflows/` (CI, Web app, Test guard, CodeQL and Deploy) runs on `${{ vars.CI_RUNNER || 'dryscope-linux' }}`. With the repository variable `CI_RUNNER` unset, jobs go to the self-hosted pool `dryscope-linux`: [runner-up](https://github.com/kunchenguid/runner-up) on the build server, as systemd service `runner-up` (setup in `/root/.config/runner-up/config.json`). It has two Docker places (2 cores, 6 GB each), starts one fresh container per job from the image `dryscope-ci-runner:1` (GitHub's `actions-runner` image plus `libatomic1`, `xz-utils`, build tools, Java 21 and Playwright's system libraries for Chromium and WebKit), and refuses jobs from fork pull requests. `runner-up status` shows each place and the waiting jobs.

The job container is leaner than GitHub's Ubuntu image: it has no Docker daemon (so no `services:` containers) and no Node, PostgreSQL or `gh`. Each job installs what it needs (setup-node, including in CodeQL for the JavaScript extractor, setup-java, Playwright's `install-deps` through `sudo apt-get`, a pinned `gh` in Deploy), and each install step is skipped or harmless on GitHub's image. In the web `database` job the test harness (`web/tests/db/postgres-harness.ts`) starts the throwaway PostgreSQL 16 itself: the `postgres:16` image where a Docker daemon answers (GitHub's image), otherwise `initdb`/`pg_ctl`. Only when there is no Docker daemon and no PostgreSQL 16 (the self-hosted container) does the job first install the Ubuntu `postgresql-16` package from apt, without creating or starting a cluster.

**GitHub-hosted runners are an owner-only fallback.** The owner has a $0 Actions hard stop, so agents never set or delete the repository variable `CI_RUNNER`, and no agent switches a job to a GitHub-hosted label such as `ubuntu-latest` (those jobs fail to start while the budget stop is on, or spend paid Actions minutes). Only the owner uses it, and only after raising the GitHub Actions budget above $0: set `CI_RUNNER` to `ubuntu-latest` (Settings > Secrets and variables > Actions > Variables, or `gh variable set CI_RUNNER --body ubuntu-latest --repo nnorman100/adr-field-estimator`). Only runs that start afterwards use it; re-run any job still waiting for `dryscope-linux`. The owner deletes it afterwards (`gh variable delete CI_RUNNER --repo nnorman100/adr-field-estimator`), which puts jobs back on `dryscope-linux`. If `CI_RUNNER` is ever found set and the owner did not set it, tell the owner.

**Stop runner-up** (on the build server): `sudo systemctl stop runner-up` stops the coordinator; jobs already running finish in their containers, and new jobs wait on GitHub for a `dryscope-linux` runner until it starts again; if CI must keep running meanwhile, the owner can use the owner-only fallback above. `sudo systemctl disable --now runner-up` keeps it off after a reboot. To end running jobs as well, `docker ps --filter label=runner-up.place` lists their containers; remove them with `docker rm -f <name>`. **Start it again:** `sudo systemctl enable --now runner-up`, then check `runner-up status`.

## Legacy CI scope

The old Python app (`backend/`, `public/`, `tests/` and their tooling) is frozen reference code for the TypeScript rebuild in `web/` and `infra/dryscope/`, and its checks are slow (the browser suite alone takes 45 to 60 minutes of a runner slot). Every legacy job stays in `.github/workflows/ci.yml` or `codeql.yml` and still reports on every pull request and push to `master`, so required checks never wait for a status that is not coming. Each one runs a scope step first and, when no legacy file changed, skips its real steps and logs `Skipping <suite>: no legacy app, test or tooling files changed against <sha>`:

| Job | Runs its real work when | Always runs |
| --- | --- | --- |
| `browser` | a file on the browser list changed (its own inline step) | nothing |
| `python` (pytest, ruff) | a legacy file changed | nothing |
| `firestore-emulator` | a legacy file changed | nothing |
| `node` | a legacy file changed: the legacy unit tests in `npm test` | `npm ci`, Prettier, `npm run lint` (ESLint, file length, required docs) and the vitest suite, which holds the Terraform plan check |
| `Analyze (python)` in CodeQL | a legacy file changed, or on the weekly schedule | nothing |
| `Analyze (javascript-typescript)`, `audit`, `Test guard`, all of `web.yml` | never scoped | everything |

The path list lives in two places that must agree: the browser job's inline step in `ci.yml` (added in #264, which the existing tests run) and `scripts/ci_legacy_scope.sh`, used by every other job. The script's list starts with the browser job's list, verbatim, then adds the files only the other suites read: all of `.github/`, `tests/` (except `tests/fixtures/terraform/`), `scripts/`, `ops/`, three docs the tests read (`docs/ai-inventory.md`, `docs/adr-pricing-source.md`, `docs/pricing-source.md`), the lint and format configs, and any `.py` file anywhere. `tests/test_ci_legacy_scope.py` fails if the two lists drift. Editing a workflow therefore runs the Python, emulator, node and CodeQL Python jobs but not the browser job, unless the workflow is `ci.yml`.

The scope step runs the full job instead when it cannot tell what changed: no base commit (new branch, force push, scheduled CodeQL run), a push whose base is not an ancestor, or a failed diff. When a rebuild change needs a legacy check (for example a new test that reads `web/`), add its path to both lists and a case to the tests.
