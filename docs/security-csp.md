# Browser CSP observation (F7)

Risk: **High** (security headers and sign-in). The full policy is sent as
`Content-Security-Policy-Report-Only`, alongside the existing enforced policy of
exactly `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`.
Photo downloads keep only their own enforced `default-src 'none'; sandbox` policy.
Nothing in this change switches the full policy to enforcement.

`web/src/proxy.ts` attaches the report-only header at runtime: the same build moves
between environments, and `FIREBASE_AUTH_DOMAIN` is a runtime setting. The API
sign-in backstop still denies every unlisted API path. The static field shell's
cached response keeps its policy when it opens offline. `web/src/lib/csp.ts` owns
the sources; `web/src/lib/security-headers.ts` still owns the enforced fixed headers.

## Sources checked against the browser code and Google documentation

The Firebase libraries are bundled into this site's scripts. `firebase-client.ts`
uses Firebase Auth's Google popup provider, not the separate Google Identity
Services button library. `field-db.ts` connects directly to Firestore, and
`app-check-client.ts` uses `ReCaptchaEnterpriseProvider`. No browser connection to
Cloud SQL, Storage or a model is needed: those calls go through this site's API.

| Source | Directive and use | Evidence |
| --- | --- | --- |
| This site | Default resources, bundled scripts, API requests, fonts, manifest and service worker; blob/data images and blob media for local captures | `web/src/lib/firebase-client.ts`, `field-db.ts`, `app-check-client.ts`, `field/photo.ts`; `web/scripts/build-sw.ts` |
| `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com` | Connect: Identity Platform sign-in, authenticator-app requests and refreshed tokens | [Identity Platform REST](https://docs.cloud.google.com/identity-platform/docs/use-rest-api), [Firebase API list](https://firebase.google.com/docs/projects/api-keys#faq-required-apis-for-restricted-firebase-api-key) |
| `https://firestore.googleapis.com` | Connect: field draft reads, listeners and writes | [Firebase API list](https://firebase.google.com/docs/projects/api-keys#faq-required-apis-for-restricted-firebase-api-key) |
| `https://firebaseappcheck.googleapis.com` | Connect: exchange reCAPTCHA Enterprise attestation for an App Check token | [App Check REST endpoint](https://firebase.google.com/docs/reference/appcheck/rest), [Enterprise provider](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider) |
| `https://apis.google.com` | Script: Firebase Auth's `gapiScript` (`/js/api.js`) and iframe helper loader | Installed `@firebase/auth` browser bundle's `gapiScript`; [Google's api.js example](https://developers.google.com/apps-script/api/quickstart/js) confirms the origin |
| `https://` + configured `FIREBASE_AUTH_DOMAIN` | Frame: Firebase Auth's helper iframe, including a configured custom domain. No wildcard Firebase project allowance | [Firebase auth domain/iframe guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices). Google account choice happens in the popup's own document, not an app iframe |
| `https://www.google.com/recaptcha/`, `https://www.gstatic.com/recaptcha/`, `https://recaptcha.google.com/recaptcha/` | Script: first two; connect: first; frame: first and third. App Check and Identity Platform load Enterprise reCAPTCHA | [Google's CSP source list](https://developers.google.com/recaptcha/docs/faq#im-using-content-security-policy-csp-on-my-website-how-can-i-configure-it-to-work-with-recaptcha), [Enterprise provider](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider) |

These Google pages were searched and retrieved through Developer Knowledge.
Only `APP_ENV=local` permits loopback HTTP emulator ports. Only the local Next
development server permits eval and loopback WebSockets; deployed builds do not.

## Why this rollout has script sources rather than nonces

[Next's App Router CSP guide](https://nextjs.org/docs/app/guides/content-security-policy)
requires dynamic rendering for fresh per-request nonces. DryScope deliberately
pre-renders `/field` and precaches that exact HTML with its build's scripts for
offline reloads (`web/scripts/build-sw.ts`). A nonce added to a response header
would not match the already-built inline bootstrap scripts; a fixed build nonce
would be reused and would not provide the intended protection. Converting the
shell to per-request HTML would change its offline/build contract.

For this observation rollout, scripts allow this site, the specific Google
loaders above and inline Next bootstrap scripts. Inline event attributes are
still observed as violations (`script-src-attr 'none'`); production eval is not
allowed. This is not a strict nonce/hash XSS policy. Before enforcement, consider
build-specific bootstrap hashes (and their streamed navigation/error variants)
or a separate rendering change that preserves the shell contract. Do not add
`strict-dynamic` without authorizing the parser-inserted bootstrap scripts first.

The first Chromium run found Zod's optional `Function()` JIT probe in a bundled
script. `web/src/instrumentation-client.ts` sets `jitless: true` before application
schemas are constructed, using [Next's early client hook](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client).
The installed Zod API documents this setting for no-eval environments. Validation
still uses the same schemas and interpreter; the CSP keeps production eval out.

## Reports, caps and privacy

`report-uri /api/client-errors` works for native cross-browser CSP reports;
`report-to csp` and `Reporting-Endpoints: csp="/api/client-errors"` cover the
Reporting API. The endpoint is already public, write-only and in the App Check
route list. Native browser reports cannot attach an App Check token; the current
App Check monitor records a missing token without refusing the report.

The same intake handles `application/csp-report` and `application/reports+json`
through bounded Zod schemas, under the existing streamed 8 KB body limit, at most
20 reports per request, 20 per caller per minute and 60 per instance per minute.
These budgets are shared with JavaScript error reports. No database or identity
lookup is added. Error Reporting gets `CspViolation`, a fixed directive and blocked
resource category, a page route pattern, and the browser family. Unknown domains
become `external`; unknown directives become `other`. Document and blocked URLs,
paths, queries, referrers, source files, samples and original policies never reach
the log. The policy deliberately omits `report-sample`: inline bootstrap code can
contain private data.

This follows [Chrome's CSP reporting guidance](https://developer.chrome.com/docs/privacy-security/csp)
and Modern Web Guidance's staged rollout and report data hygiene. Reports can be
spoofed or caused by extensions; treat them as diagnostic evidence. Browser tests
listen before the first script and across reloads, so an offline or delayed
Reporting API delivery cannot make a violation look absent. A deliberately
forbidden fetch checks that the observer fires while report-only lets it proceed.

## Proof and remaining phone check

Unit tests check source content, environment boundaries, photo exclusion, both
native payload formats, privacy and shared caps. Chromium/WebKit tests exercise
emulator sign-in, the Google popup (real api.js loader; emulator account chooser),
Firestore field screens, and an offline shell reload/reconnect. These are
automated checks, not a physical-device or real-provider attestation.

Before any later enforcement, the owner must run the test environment on a phone
with real Google sign-in, the authenticator-app step, real App Check/reCAPTCHA,
photo capture and offline work followed by reconnect. Review the report-only
events over real traffic, investigate violations, and record that phone check
separately. Enforcement is a later owner-approved change.

Kun's input: research the actual SDK dependencies before choosing sources, reuse
the bounded intake instead of adding another public endpoint, and prove the
observer with a real browser violation before relying on an empty report list.
