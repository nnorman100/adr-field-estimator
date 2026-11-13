# Synthetic probe (TC-10)

The code behind the test copy's Cloud Monitoring synthetic monitor (`docs/plans/TC.md`, TC-10, C4
option A). Every run it:

1. signs in as the synthetic technician of test company A through Identity Platform's REST API
   (`accounts:signInWithPassword` with `tenantId`), sending the test app's origin as a browser
   would;
2. calls `GET /api/me` and checks it says the technician is signed in to that company;
3. calls `GET /api/jobs/{id}` and checks the fixed job opens with its fixed customer name.

The whole probe has a 30-second limit. It logs only step names and HTTP status codes, and a failure
names its step and a fixed reason (`refused`, `timeout`, `wrong_job`, ...). No email, password, key,
token, id, name or response body is ever written, thrown or logged.

| File             | What it is                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `probe.ts`       | The probe: pure `fetch`, no packages. The web app's CI tests it (`tests/unit/synthetic-probe.test.ts`). |
| `index.ts`       | The function entry (`DryscopeSynthetic`), using `runSyntheticHandler` from `@google-cloud/synthetics-sdk-api`. |
| `package.json`, `package-lock.json`, `tsconfig.json` | The function's own build. Not part of the web app's `npm ci`; `web/tsconfig.json` leaves `index.ts` out. |

## Settings (function environment)

Plain variables (set by Terraform in TC-11, not secret): `SYNTHETIC_APP_URL` (the test app's https
origin), `SYNTHETIC_API_KEY` (the test app's Identity Platform web API key), `SYNTHETIC_TENANT_ID`,
`SYNTHETIC_EMAIL`, `SYNTHETIC_COMPANY_ID`, `SYNTHETIC_JOB_ID`, `SYNTHETIC_JOB_NAME`.

Secret variable (from Secret Manager `dryscope-<env>-synthetic-password`): `SYNTHETIC_PASSWORD`.

Local runs only: `SYNTHETIC_AUTH_URL`, a loopback address that replaces Identity Platform (for the
Auth emulator, `http://127.0.0.1:<port>/identitytoolkit.googleapis.com`). Any other address is
refused. A missing or malformed setting fails the run naming the variable, never its value.

The fixed job must be one the synthetic technician created or owns: an estimator sees only their
own jobs, and any other job answers 404.

## Build

```
cd web/synthetic
npm ci
npm run build      # tsc -> dist/ (the same command is `gcp-build` for Cloud Run functions)
```

`instantiateAutoInstrumentation()` is deliberately not called: it traces and logs every outbound
request, and these carry a sign-in. `runSyntheticHandler` copies a thrown error's name, message and
stack into the check result, which is why `probe.ts` throws only fixed text.

Deploying it is TC-11 (owner-applied Terraform); nothing here deploys anything.
