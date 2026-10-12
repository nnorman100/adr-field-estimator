# App Check — step one: monitor only

[Firebase App Check](https://firebase.google.com/docs/app-check) lets the backend and sign-in accept requests only from the real field app in a real browser. Production uses the [reCAPTCHA Enterprise provider](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider), which is invisible and never shows a puzzle. The debug provider (`FIREBASE_APPCHECK_DEBUG_TOKEN`) is only for local testing.

The rollout has two steps:

1. **Monitor (this release).** The app sends an App Check token with every `/api/**` request and in the Live walkthrough's first message. The Cloud Run backend verifies it and records the result, but it never rejects a request because the token is missing or invalid.
2. **Enforce (a separate, later change).** After a few days of clean results from technicians' real phones, a later change turns on enforcement, separately for the backend and for Firebase Authentication. This release contains no enforcement code. Do not select **Enforce** for any API in the Firebase console during step one.

## How it works

| Part | Behaviour |
| --- | --- |
| Client, `public/app.js` | When `APP_CHECK_SITE_KEY` is set, the app loads the vendored App Check compat build (`public/vendor/`, Firebase JS SDK 12.4.0; see its [README](../public/vendor/README.md)). It activates `ReCaptchaEnterpriseProvider` with automatic token refresh. Each `/api/**` request carries the token as `X-Firebase-AppCheck`, and the Live `authenticate` message carries it as `app_check`. If no token arrives within 3 seconds, or attestation fails, the request is sent without the token. After one attestation outlasts that wait, later requests use only a token that is already available and otherwise go out at once without one, until a token request succeeds. A slow attestation can therefore show up as a burst of `missing` entries in the backend log. With an empty key, the script is not loaded and the app behaves as it did before App Check. |
| Debug token | `self.FIREBASE_APPCHECK_DEBUG_TOKEN` is honoured only on `localhost` and `127.0.0.1`. On every other origin the app clears it before activating App Check, so production can never use the debug provider. |
| Backend, `backend/main.py` | `APPCHECK_MODE` is `monitor` (the default when unset) or `off`. Any other value, including `enforce`, stops the service at startup. In monitor mode, each `/api/**` request and each Live authentication is checked with `firebase_admin.app_check.verify_token`. The Admin SDK verifies locally against signing keys that it caches for six hours. An unknown key ID can force at most one key refetch every 30 seconds. Verification uses two dedicated threads and stops waiting after 2 seconds. |
| Authentication | Once App Check is active, the Firebase Auth SDK attaches tokens to sign-in requests by itself. The Firebase console's App Check page then shows Authentication's request metrics. Enforcement for Authentication is part of step two. |

### Content Security Policy

`firebase.json` adds only the origins that reCAPTCHA documents in its [CSP guidance](https://cloud.google.com/recaptcha/docs/faq) (the answer to "I'm using Content-Security-Policy (CSP) on my website"):

| Directive | Added origins |
| --- | --- |
| `script-src` | `https://www.google.com/recaptcha/`, `https://www.gstatic.com/recaptcha/` |
| `frame-src` | `https://www.google.com/recaptcha/`, `https://recaptcha.google.com/recaptcha/` |
| `connect-src` | `https://www.google.com/recaptcha/` |

The SDK exchanges tokens with `https://content-firebaseappcheck.googleapis.com`, which the existing `https://*.googleapis.com` entry already allows.

## Owner setup

All steps take place in project `alert-disaster-field-2026`.

1. **Create the reCAPTCHA Enterprise key.** In the Google Cloud console, open **Security → reCAPTCHA** and enable the reCAPTCHA Enterprise API if prompted. Create a key for the **Website** platform. Add the domains `alert-disaster-field-2026.web.app` and `alert-disaster-field-2026.firebaseapp.com`. Choose score-based verification with no checkbox challenge. Follow [Firebase's reCAPTCHA Enterprise guide](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider).
2. **Register it in Firebase App Check.** In the Firebase console, open **App Check → Apps** and select the web app `1:545776254070:web:c380c2ee35398689143357`. Choose **reCAPTCHA Enterprise**, paste the site key and save. Leave every API (including Authentication) unenforced.
3. **Paste the site key.** Set `APP_CHECK_SITE_KEY` near the top of the App Check section in `public/app.js`. The site key is public; it is not a secret. Release Hosting through the normal process in [firebase-isolation.md](firebase-isolation.md#deployment).
4. **Backend.** No configuration is needed. `scripts/deploy_backend.py` keeps existing environment variables, so an unset `APPCHECK_MODE` means `monitor`. Setting it to `off` stops verification and logging.

Before the key is pasted, every request records `missing`. This is the expected baseline.

## Local testing with a debug token

Debug tokens work only on `localhost` and `127.0.0.1`, and only when `APP_CHECK_SITE_KEY` is set.

1. Set `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;` before the app activates App Check. Use Playwright's `page.addInitScript`, or, in Chrome DevTools, pause on the first line of `app.js` and run it in the console. The SDK prints a generated debug token in the browser console.
2. In the Firebase console, open **App Check → Apps**, open the web app's overflow menu and choose **Manage debug tokens**. Register the printed token.
3. For automated runs, set the registered value instead: `self.FIREBASE_APPCHECK_DEBUG_TOKEN = '<token>'`. Read the value from an environment variable.

Never commit a debug token. A registered debug token passes App Check from anywhere, so delete leaked or unused tokens from the console. The browser test harness (`tests/browser_server.py`) serves synthetic Firebase SDK stubs and does not exercise real App Check.

## Reading the monitor results

Each check writes one structured line to Cloud Logging with the message `App Check`. The line holds only these fields:

| Field | Values |
| --- | --- |
| `outcome` | `valid`; `missing` (no token sent); `invalid` (expired, forged, for another project or malformed); `unverified` (verification did not finish within 2 seconds, for example while signing keys were being fetched) |
| `method`, `route` | The HTTP method and the route template, such as `GET /api/inspections/{inspection_id}`; Live connections record `WEBSOCKET /api/live` |
| `status` | The HTTP response status for REST requests, so you can separate the app's own traffic from rejected anonymous calls |

The line never contains token values, user identifiers, paths with record IDs, or request bodies.

In **Logs Explorer**, use this query:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="alert-disaster-field-estimator"
jsonPayload.message="App Check"
```

Add `jsonPayload.outcome` as a summary field, or count outcomes from a terminal:

```powershell
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="alert-disaster-field-estimator" AND jsonPayload.message="App Check"' --project=alert-disaster-field-2026 --freshness=1d --format="value(jsonPayload.outcome)" | Group-Object | Select-Object Count,Name
```

After the key is live, expect mostly `valid`. `missing` from technicians' phones usually means an older cached app version (it clears after **Save & update**) or a device where reCAPTCHA could not produce a token. Investigate any `invalid` or `unverified` entries, and any authenticated (`status` 200) `missing` entries, before planning step two.
