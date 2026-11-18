# Architecture: Testing layers

Part of [Architecture](../ARCHITECTURE.md).

## Testing layers

The rebuilt app's tests live in `web/tests/`, one folder per layer, each run by a `web/` npm script. CI runs the first five in `.github/workflows/web.yml`; the AI evaluations run only by hand, from `.github/workflows/ai-evals.yml`:

- **Unit** (`npm test`, `web/tests/unit/`): Vitest in Node with no services; the pricing engine, documents, Zod schemas, the role matrix and route handlers with fakes.
- **Database** (`npm run test:db`, `web/tests/db/`): Vitest against a local PostgreSQL 16 server; migrations, row-level security as the runtime role, and the business routes on real SQL.
- **Emulator** (`npm run test:emu`, `web/tests/emu/`): Vitest against the Firebase Auth and Firestore emulators (a `demo-` project only, Java 21+); `firestore.rules`, sign-in and the field database.
- **Company isolation** (`npm run test:isolation`): the isolation gate, picked from the database and emulator layers; two companies call every route and rule with each other's ids. CI runs it as its own required job.
- **Browser** (`npm run test:e2e`, `web/tests/e2e/`): Playwright on phone-sized Chromium and WebKit against the built app, its emulators and a throwaway database; CI runs it as four shards.
- **AI evaluations** (`npm run eval:ai`, `web/tests/ai-evals/`): datasets and pass marks for each AI feature, run against the real models on `test` before a feature's switch goes on.

The repository root keeps its own `npm run format:check`, `npm run lint` and `npx vitest run` (the repository guards, docs checks and Terraform plan checks). The retired app's Python and root browser suites no longer run in CI (`docs/runbook/ci.md`). Device behavior (iPhone camera, mic, Bluetooth, latency) stays open until observed on a device.

The accepted rebuild's future authority boundaries and submit fence are in [Data ownership](../data-ownership.md); the code-derived current collection and object manifest is in [Legacy data inventory](../legacy-data-inventory.md). These documents describe the planned rebuild, not current runtime authority. They are a partial rebuild-stage S1 slice (ownership map, submit protocol and legacy inventory); the S1 spec, AI prompt and model pinning, and golden parity baseline arrive in separate S1 pull requests.
