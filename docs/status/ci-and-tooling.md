# Status: CI, tests and agent tooling

Part of [Status](../STATUS.md). These changes affect how the project is built and checked, not what users see, so On and Phone-checked do not apply.

| Change | Built | Notes |
|---|---|---|
| Pipeline test step runs the emulator suite; CI-covered scenarios count as covered | yes (#316, #438) | |
| Runtime settings held to the Cloud Run Terraform | yes (#318) | |
| Emulator and browser test runs on a shared host: lock, own ports, no leaked emulators | yes (#319, #394, #401, #405) | `EMU_PORTS=auto` |
| CodeQL: no results artifact; master pushes and weekly only, not pull requests | yes (#324, #452) | |
| Modern Web Guidance skill; Google Stitch skills (hidden in #454) | yes (#328, #410, #454) | |
| Browser tests against a production build, routes compiled first | yes (#331, #332, #366) | #366 made the second-step tests wait for the `/api/me` responses |
| Database tests in parallel on one shared Postgres | yes (#347) | |
| Web app workflow on every pull request; the five scoped jobs skip work when nothing changed | yes (#357, #450) | On a pull request the database, emulators, company-isolation, e2e and image jobs skip their steps and still report success when nothing changed under `web/`, `live-relay-placeholder/` or `.github/workflows/web.yml`; the `check` job always runs in full |
| Browser tests as parallel shards (D-032) | yes (#384, #420) | Four shards with two workers |
| Old app's CI checks removed (D-033) | yes (#395) | Old app files stay until S8-23 |
| Route-rules access test split per route file | yes (#408) | |
| Tests and test configs protected from pipeline fixes; automatic review fix rounds off | yes (#412, #445) | |
| `docs/DESIGN.md` rewritten from the web app and its colours checked against the stylesheet | yes (#411, #419) | |
| Agent stop checks; force-push, master-push and secret command guards | yes (#422, #436, #453) | |
| `verify-dryscope` and `dryscope-gotchas` skills | yes (#426, #441) | |
| Test guard covers `web/` tests, configs and Terraform tests; gaps F10 and F11 closed | yes (#443, #467) | |
| Audit check skips only the approved picomatch advisory | yes (#437, #448) | #437 bumped ESLint, which cleared the minimatch advisory; #448 holds the picomatch waiver, which expires 2026-12-18 |
| Web CI job time limits raised for the self-hosted runners | yes (#449) | |
| Dependency updates | yes (#368, #415, #431, #432, #433) | OpenTelemetry bumps held (#431) |
| Test-only fixes: the CSP field test answers the trusted-device prompt (#414); the email check's timing bound raised from 50 ms to 500 ms (#465) | yes (#414, #465) | No runtime change |
