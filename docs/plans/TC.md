# TC: Tier 1 catch-up (Technology Standard 2.5)

Stage plan for the Tier 1 items of Technology Standard 2.5 that DryScope does not yet meet (the Standard is now at 2.6; 2.6 changes only module C, voice). Written on `master` at `6a168ab7` on 2026-11-12, in the shape of [S5.md](S5.md) and [S6.md](S6.md). The owner approved this plan and answered decisions C1 to C13 on 2026-11-12, all as recommended (section 8).

## 1. Summary

- **TC is 12 pull requests (TC-1 to TC-6 and TC-8 to TC-13) plus one set of acceptance tests that land inside S6-3 and S6-5 (TC-7).** TC-13, enforcement, comes after the first test users by design ("monitoring mode first, then enforcement"). Each pull request carries a test that fails without it. **There is no database job.** Nothing here changes Postgres, so TC never waits for or blocks the database lane (next in that lane: S5a-7).
- **Two owner Terraform applies cover the whole stage.** All data-root changes (APIs, IAM, the reCAPTCHA key and App Check registration, container scanning, the synthetic monitor's account and secret) are one pull request, **TC-9**. All app-root changes (phone channels, the corrected error-rate rule, uptime on `test`, the failed-release, failed-backup and synthetic alerts, the budget fix, the synthetic function) are another, **TC-11**. TC-5's two new runtime settings ride in the same app-root apply. That apply is also the owner's long-pending first app-root apply (owner step 9), which the first test user needs anyway.
- **Agent code against owner cloud work.** Agents write TC-1 to TC-6, TC-8, TC-10 and TC-12 in `web/`, plus the Terraform in TC-9 and TC-11. The owner enables APIs, grants IAM, registers the web app and App Check, sets the Identity Platform reCAPTCHA mode, installs the Cloud console phone app, creates the synthetic user and secret value, turns on Gemini Cloud Assist in the console, and runs both applies and the alert drills (section 7).
- **What already stands.** These Tier 1 items are present and were spot-checked, not re-audited:
  - Second sign-in step: S3-14, https://github.com/nnorman100/adr-field-estimator/pull/321.
  - Company-isolation required job: https://github.com/nnorman100/adr-field-estimator/pull/337.
  - Backups, point-in-time recovery and deletion protection: `data/sql.tf:13-35`.
  - Route wrappers with a guard: `web/tests/unit/route-rules.test.ts`.
  - File-length and required-docs checks: `docs/runbook/ci.md`, the `node` job.
  - Release smoke checks: `web/scripts/smoke-release.ts`.
  - Model Armor and AI limits are not applicable yet, because no AI feature is on in `web/`.
- **Outside this plan (flagged, not planned).**
  - The agent spending cap is a Tier 1 item but lives in the runner and firstmate, not this repo.
  - The release smoke list is thinner than the Standard's ("sign-in works, a fake record is created and submitted, a file uploads, an AI feature answers"). Later, TC-10's probe can serve as the sign-in and open-record half of the smoke check (section 12, "Later").
  - The Standard's "runner down" alert is Core, not Tier 1.
- **Found while planning.**
  - **Budget double count.** `app/budget.tf` creates one budget per environment, and each one filters on the whole project (`budget_filter.projects`). Applying both `test` and `live` with a billing account would give two budgets that each count all spend. The default is also $300, while the Standard sets $200.
  - **Errors in route handlers reach Error Reporting only through Next.js's own default log.** The route wrappers do not catch them (`web/src/lib/auth/route.ts:65-77`). The wrappers' own failure lines are fixed text with `error.name` only (`route.ts:68`, `:143`): safe, but they carry no stack.
  - **The browser config has no Firebase `appId`.** App Check needs one: `web/src/lib/firebase-client.ts:42` initializes with `apiKey`, `authDomain` and `projectId` only.
  - **The release tag scheme collides with the old app's tags.** The Standard's `YYYY.MM.DD-N` is the scheme the old `deploy.yml` already used in this repo, so the next number must count the old tags too.
  - **Identity Platform's sign-in reCAPTCHA covers only part of sign-in.** It protects email and password sign-in, sign-up, email-link sign-in and password reset, but not Google sign-in. It also provisions its own keys ("Identity Platform SDKs cannot generate tokens from reCAPTCHA keys that you generate on your own"), so DryScope ends up with two reCAPTCHA keys: App Check's and Identity Platform's.
  - **The Google provider has no Identity Platform reCAPTCHA field.** Neither `google_identity_platform_config` nor `_tenant` has one in 7.46.2, so sign-in reCAPTCHA is set through the Admin SDK by an owner-run command (TC-6). `google_firebase_web_app` exists only in `google-beta`, so the web app stays a console registration (owner step 8 already says so).

## 2. What exists today (evidence)

**Tier 1, as approved** (Notion "Technology Standard (all projects)", section "Tiers: when each core item is required (2.5)"):

> sign-in with second step, company isolation and its required test, Zod at every route; release path to the test copy with smoke tests, release manifest and rollback command; backups, point-in-time recovery and deletion protection; request tracing (Cloud Trace) and Error Reporting; uptime, error-rate, failed-release and failed-backup alerts to the owner's phone; App Check on client calls with reCAPTCHA Enterprise on sign-in (monitoring mode first, then enforcement); Model Armor and AI limits on any AI feature switched on; axe checks on every main screen, file length and required-docs checks; budget alerts and the agent spending cap; Artifact Analysis container scanning on the app's image repository; Cloud SQL Query Insights; a Cloud Monitoring synthetic monitor that signs in and opens a record on the test copy; Gemini Cloud Assist in the Cloud Console.

The App Check offline rule (module B) reads: "Work queued offline is never discarded or blocked for a stale token: the phone gets a fresh token on reconnect, then syncs. App Check blocks nothing until enforcement is on." The Core monitoring line adds "error rate over 2% for 10 minutes", "each sent to the owner's phone and tested". The Core budget line is "$200 to start, with alerts at 50%, 90% and 100%".

**Each item in the brief, checked against the repo:**

| Item | Today | Evidence | Verdict |
| --- | --- | --- | --- |
| Request tracing, OpenTelemetry to Cloud Trace | Nothing. No `@opentelemetry` package, no exporter, no trace field in logs. The runtime accounts hold no trace-writer role, and the API list has neither `telemetry` nor `cloudtrace`. | `grep -rniE 'opentelemetry\|cloudtrace\|traceparent' web/src web/package.json infra/dryscope` (no hits); `web/package.json:24-57`; `infra/dryscope/data/main.tf:29-42`; roles in `data/identities.tf` | **Missing**: TC-3, TC-9 |
| Error Reporting, server | Partial at best. Uncaught route errors go to Next.js's default stderr log (the wrappers do not catch). The wrappers' own failures and `/api/health` log fixed text with no stack. There is no structured logger and no `ReportedErrorEvent`. | `web/src/lib/auth/route.ts:65-77,143`; `web/src/app/api/health/route.ts:19`; `web/src/instrumentation.ts` | **Missing** (not designed): TC-1 |
| Error Reporting, browser and phone through a server route | Nothing: no `window.onerror`, `unhandledrejection`, `global-error.tsx` or report route. S6 says "no client telemetry until S9". | `grep -rniE 'onerror\|unhandledrejection\|global-error' web/src` (no hits); `docs/plans/S6.md:57` | **Missing**: TC-2; correction to S6 (section 10) |
| App Check on client calls | Nothing in `web/`. The browser config lacks `appId`. The old app's monitor-mode design is in `docs/app-check.md`. | `grep -rniE 'app.?check\|recaptcha' web/src infra/dryscope` (no hits); `web/src/lib/firebase-client.ts:42`; `web/src/lib/config.ts:278` | **Missing**: TC-5, TC-9 |
| reCAPTCHA Enterprise on sign-in | Nothing. The tenant command creates tenants without `recaptchaConfig`. | `web/scripts/create-tenant.ts` (no recaptcha); provider schema (no field) | **Missing**: TC-6 |
| 2.5 offline rule | The S6 plan has a sync gate (`/api/me` answered and access record current) but no App Check token step. S6-5's failure classes do not cover a refused App Check token. S6-3 and S6-5 are not built yet. | `docs/plans/S6.md:55`, S6-5 failure classes | **Missing** (in a plan): TC-7, as tests inside S6-3 and S6-5 |
| Release manifest on each GitHub Release | Nothing. The workflow has `permissions: {}`, writes the step summary only, and creates no tag or Release. Health reports the commit, not a version. | `.github/workflows/web-release.yml:24`, steps `image`, `stage`, `promote`; `web/src/app/api/health/route.ts:13-14` | **Missing**: TC-8 |
| Rollback command | Partial. There is an automatic traffic rollback when a step after the move fails, and a generic hand command. Nothing records the previous revision per release. | `web-release.yml`, step "Roll back traffic"; `docs/runbook/test-release.md:9` | **Partial**: TC-8 |
| axe on every main screen | 6 of 7 page routes are checked (axe calls: `sign-in.spec.ts` 8, including the invitation page; `second-step.spec.ts` 6; `team.spec.ts` 7; `operator.spec.ts` 9). The start page `/` is not. No guard stops a new page from shipping without axe. | `grep -c 'expectAccessible(page' web/tests/e2e/*.spec.ts`; pages from `find web/src/app -name page.tsx` | **Partial**: TC-4 |
| Artifact Analysis container scanning | Off. `containerscanning.googleapis.com` is not in the API list, and the repository has no scanning setting (the provider supports `vulnerability_scanning_config.enablement_config`). | `data/main.tf:29-42`; `data/artifact_registry.tf:4-21`; provider schema | **Missing**: TC-9 |
| Cloud SQL Query Insights | **On in Terraform** since #239 (2026-11-08), and the test data root is applied. | `data/sql.tf:51-53`; `git log -S query_insights_enabled` | **Present: dropped** (owner confirms, section 7 K) |
| Synthetic monitor that signs in and opens a record | Nothing. | `app/monitoring.tf` (uptime only) | **Missing**: TC-10, TC-11 |
| Gemini Cloud Assist | Not recorded anywhere; the API is not in the list. | `data/main.tf:29-42`; docs search | **Missing**: owner console step (section 7 J) |
| Uptime alert to the phone | The uptime check and "fails from two regions" policy exist, but they are **off in `test`** (`uptime_check_enabled = false`) and email-only. | `app/monitoring.tf:96-148`; `app/envs/test.tfvars` | **Partial**: TC-11 |
| Error-rate alert | ">5 responses with a 5xx status in 10 minutes", a count, not the Standard's "over 2% for 10 minutes". Email only. | `app/monitoring.tf:12-41` | **Partial**: TC-11, C2 |
| Failed-release alert | Nothing. | `web-release.yml`; `app/monitoring.tf` | **Missing**: TC-8, TC-11 |
| Failed-backup alert | Nothing. | `app/monitoring.tf` | **Missing**: TC-11 |
| To the owner's phone | One email channel for every policy. The address is a sensitive variable. | `app/monitoring.tf:1-10`; `app/variables.tf:112-121` | **Missing**: TC-11, C1 |
| Budget alerts | A stub: no budget unless `billing_account_id` is passed. It defaults to $300 per environment, filters on the whole project, and goes to email only. `billingbudgets.googleapis.com` is not in the API list. | `app/budget.tf:1-32`; `app/variables.tf:123-133` | **Partial**: TC-11, C8 |
| Any of the monitoring above in the cloud | No: "app root not applied". | `docs/ARCHITECTURE.md` (destination table, infrastructure row); `docs/runbook/owner-cloud-steps.md` item 9 | Applied with TC-11 |

**Google facts the plan rests on** (Google Developer Knowledge corpus unless marked otherwise):

| Fact | Source | What TC does |
| --- | --- | --- |
| Google recommends exporting traces through the Telemetry (OTLP) API ("this export doesn't require a data transformation"). A collector is preferred where the environment supports one; otherwise use an in-process OTLP exporter to `https://telemetry.googleapis.com`. The role is `roles/telemetry.tracesWriter` (`roles/cloudtrace.agent` also carries `telemetry.traces.write`). | `documents/docs.cloud.google.com/trace/docs/migrate-to-otlp-endpoints`, `.../trace/docs/setup/nodejs-ot`, `.../iam/docs/roles-permissions/telemetry` | In-process OTLP exporter, no sidecar (the documented Cloud Run collector sample is annotated ALPHA): TC-3 |
| Cloud Run traces incoming requests itself and fills `traceparent`. It samples at most 0.1 requests per second per instance; ParentBased samplers honour that decision. Log correlation uses `logging.googleapis.com/trace` = `projects/PROJECT/traces/TRACE_ID`. | `documents/docs.cloud.google.com/run/docs/trace`, `.../trace/docs/trace-sampling`, `.../logging/docs/view/correlate-logs` | ParentBased sampler (cost bounded by Cloud Run's rate); the logger adds the trace field: TC-1, TC-3 |
| Cloud Trace: $0.20 per million spans after the first 2.5 million each month. | `documents/cloud.google.com/products/observability` | About $0 at test-copy volume |
| Error Reporting picks up stack traces written to stdout or stderr on Cloud Run. In JSON, the trace goes in `message`, `stack_trace` or `exception`; a text-only event uses `"@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"`. New-error notifications go to email, mobile, Slack or webhook, at most 20 per project per hour. | `documents/docs.cloud.google.com/error-reporting/docs/formatting-error-messages`, `.../setup/cloud-run`, `.../error-reporting/docs/notifications` | JSON log lines, no client library: TC-1, TC-2 |
| No Google guidance for calling Error Reporting from a browser. API keys "shouldn't be used as an authentication mechanism". | same corpus (not found) | Browser errors go through our own route (as Tier 1 says): TC-2 |
| Cloud Logging: $0.50 per GiB after the first 50 GiB per project each month. | `documents/cloud.google.com/products/observability` | About $0 at this scale; client reports are capped |
| Query Insights is supported on all Enterprise-edition machine types (so on `db-f1-micro`). Client address recording is off by default. | `documents/docs.cloud.google.com/sql/docs/postgres/using-query-insights` | Already on; keep `record_client_address` off |
| App Check web: `initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(key), isTokenAutoRefreshEnabled: true })`. The key is a score-based Website key listing each domain, with no checkbox. TTL defaults to 1 hour (range 30 minutes to 7 days) and refreshes at about half the TTL. The debug provider uses `self.FIREBASE_APPCHECK_DEBUG_TOKEN`; never add localhost to the key. | `documents/firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider`, `.../web/debug-provider` | TC-5 (TTL left at the 1-hour default) |
| Own backend: send `X-Firebase-AppCheck`, verify with `getAppCheck().verifyToken()`. Replay protection (`consume: true`) is beta and adds a round trip. Enforcement is per product; "all unverified requests to that product will be rejected", within about 15 minutes. Metrics: Verified, Outdated client, Unknown origin, Invalid. | `documents/firebase.google.com/docs/app-check/custom-resource-backend`, `.../enable-enforcement`, `.../monitor-metrics` | Monitor-mode verify, no replay protection: TC-5; enforcement: TC-13 |
| Whether the Firestore SDK refreshes the App Check token before replaying queued writes is **not documented**. | corpus (not found) | TC-7 tests it; the S6-3 gate fetches a fresh token itself |
| reCAPTCHA with billing attached: the first 10,000 assessments a month are free, 10,001 to 100,000 cost a flat $8, then $1 per 1,000. App Check creates an assessment at each token refresh. | `documents/docs.cloud.google.com/recaptcha/docs/billing-information`, `.../compare-tiers` | Staff scale stays under 10,000 (section 12) |
| Identity Platform bot protection covers email/password sign-in, sign-up, email-link sign-in and password reset. Modes are `OFF`, `AUDIT` and `ENFORCE`, set per project or **per tenant** through the Admin SDK (Node 11.7.0+); start in AUDIT. It needs the `identitytoolkit` service identity with `roles/identitytoolkit.serviceAgent`. "If reCAPTCHA key provisioning fails ... attempts still succeed normally." Metrics: `identitytoolkit.googleapis.com/recaptcha/verdict_count`, `token_count`, `risk_scores`. | `documents/docs.cloud.google.com/identity-platform/docs/recaptcha-enterprise` | TC-6 (AUDIT per tenant, owner-run) |
| Container scanning: enable `containerscanning.googleapis.com`; billing starts at once. Each image is scanned once on push (by digest), then re-analysed continuously while it was pulled in the last 30 days. Scanning can be set per repository. Price: **$0.26 per scan**; rescans of the same image are free. | `documents/docs.cloud.google.com/artifact-analysis/docs/container-scanning-overview`, `.../controlling-costs`; price from https://cloud.google.com/artifact-analysis/pricing (fetched 2026-11-12) | TC-9, C5 |
| Synthetic monitors run a single-purpose 2nd-gen Cloud Run function written in Node.js. Terraform: `google_monitoring_uptime_check_config` with `synthetic_monitor { cloud_function_v2 { name } }`. Price: $1.20 per 1,000 executions, 100 free per billing account. Uptime checks cost $0.30 per 1,000, with 1 million free per project. | `documents/docs.cloud.google.com/monitoring/synthetic-monitors/create`, `documents/cloud.google.com/products/observability` | TC-10, TC-11, C4 |
| Phone alerts: the Google Cloud console mobile app creates its own notification channel when the owner selects the project. Google advises pairing it with email or Pub/Sub, because mobile, PagerDuty, webhook and Slack share one internal service. SMS "isn't a fully reliable notification channel type". | `documents/docs.cloud.google.com/monitoring/support/notification-options` | C1 |
| Backup outcome is in the `system_event` audit log, method `cloudsql.instances.automatedBackup`, field `windowStatus` (`STATUS_FAILED`, `STATUS_ATTEMPT_FAILED`, `STATUS_SKIPPED`). Google recommends a log-based alert on it. | `documents/docs.cloud.google.com/sql/docs/postgres/backup-recovery/view-audit-logs-for-automated-backups` | TC-11, C12 |
| Log-based alert limits: one condition per policy, 20 notifications a day, 5 minutes between repeats, 7-day auto-close. | `documents/docs.cloud.google.com/logging/docs/alerting/log-based-alerts` | Notification rate limit set: TC-11 |
| Alerting policy pricing ($0.35 a month per metric reference, plus points returned) takes effect **2027-09-01**. | `documents/cloud.google.com/products/observability` | About $0 until then |
| Budgets alert but never cap spend; up to 5 Monitoring channels per budget; managing a budget needs Billing Account Administrator (or the project-level budget permissions). | `documents/docs.cloud.google.com/billing/docs/how-to/budgets` | TC-11, C8 |
| Gemini Cloud Assist: chat is enabled "at no cost" (`geminicloudassist.googleapis.com`, role `roles/geminicloudassist.user`). **Since 2026-04-10, investigations need a Premium Support contract.** It "can store data in any Google Cloud data center globally". Gemini does not train on prompts or replies. | `documents/docs.cloud.google.com/cloud-assist/set-up-gemini`, `.../cloud-assist/release-notes`, `.../cloud-assist/investigations`, `.../gemini/docs/discover/data-governance` | Owner console step: C9 |
| Provider 7.46.2 has `google_artifact_registry_repository.vulnerability_scanning_config.enablement_config`, `google_recaptcha_enterprise_key.web_settings`, `google_firebase_app_check_recaptcha_enterprise_config` (`app_id`, `site_key`, `token_ttl`), `google_monitoring_alert_policy` `condition_matched_log` / `condition_prometheus_query_language` / `alert_strategy.notification_rate_limit`, `google_cloudfunctions2_function.service_config.secret_environment_variables`. It has **no** reCAPTCHA field on `google_identity_platform_config` or `_tenant`, and **no** `google_firebase_web_app` (that is in `google-beta` only). | `terraform providers schema -json` on a scratch copy of `infra/dryscope/data` | TC-9, TC-11 |

## 3. Design rules every TC step follows

- **Nothing personal leaves the process.** Hard rule 6 applies to every new log line, span, error report and manifest:
  - No email, address, coordinates, token, password, prompt, transcript or request body.
  - Paths are logged as route patterns (`/api/jobs/{id}`), never as filled-in paths.
  - Library error messages are not copied as they are: they can quote SQL, tokens or emails.
  - Each step has a test that feeds a crafted email, token and coordinate pair through its path and fails if any of them comes out.
- **Allowlisted fields only.** One logger (`web/src/lib/log.ts`) writes JSON lines with a fixed field set. Spans carry route, method, status, table or collection name and duration, never values. Client reports carry the fields in C13.
- **Monitor first, then enforce.** App Check runs in `monitor` (the default) or `off`. The server refuses to start on `enforce` until TC-13. Sign-in reCAPTCHA starts in `AUDIT`. Nothing in TC-1 to TC-12 can refuse a request that works today.
- **Offline work is never lost to a token** (the 2.5 rule). A missing, slow or expired App Check token never deletes, locks or blocks queued work. The phone fetches a fresh token on reconnect, then syncs (TC-7). In monitor mode a token that will not come is logged and sync goes ahead.
- **One owner per layer.** Terraform owns resources, IAM, APIs and settings; the release workflow changes only the image, the tag and the GitHub Release; the app code owns what it logs and traces. The two Terraform bundles (TC-9 data root, TC-11 app root) keep the owner's applies to two.
- **Alerts go to the phone, with email as the backup** (C1), and **each one is tested** by a recorded drill (TC-12).
- **Every main screen carries an axe check**, enforced by a guard (TC-4), not by memory.
- **Same checks as S5 and S6:** phone width (390 px), Chromium and WebKit, the modern-web-guidance skill for UI work, real-service results recorded apart from mock results.
- **New dependencies:** each one gets a reason in the pull request, the publisher, download and repository check, reviewer approval, exact pinned versions and a release at least two weeks old.

## 4. How a problem reaches the owner's phone

```
 phone / browser ─ error ─► POST /api/client-errors ─┐   (TC-2)
 Next.js route ─ uncaught ─► onRequestError ─────────┤   (TC-1)
                                                     ▼
                            JSON line on stdout (trace id, route pattern, stack)
                                                     │
              Cloud Logging ──► Error Reporting (groups, new-error email)
                    │      └──► log-based alerts: release failed (TC-8 writes), backup failed (audit log)
 Cloud Run spans + app spans ─► Telemetry API ─► Cloud Trace   (TC-3; linked from the log line)
 uptime check (2 regions) / synthetic probe (signs in, opens a job) / 5xx ratio / budget
                    │
                    ▼
        Cloud Monitoring policies ─► phone (Cloud console app, C1) + email backup
```

## 5. Ordered steps

Format: **UI** screens, **FE** frontend, **BE** server routes and services, **DB** migration, **Infra** Terraform, **Tests**, **Needs**. **Kind:** agent code, owner cloud, or both. Size S, M or L. Risk follows `AGENTS.md`: auth, isolation, workflows, IAM, secrets, cloud or unsure means **High**. Each pull request states its own rating.

**TC-1 Server error reports and the structured logger (M, High: changes how every route's failures are reported).** Kind: agent code; one owner API enablement inside TC-9.
- UI, FE, DB: none.
- BE:
  - `web/src/lib/log.ts`, the one JSON-line logger: `severity`, `message`, a fixed field allowlist, and `logging.googleapis.com/trace` plus `spanId` taken from `traceparent` or `X-Cloud-Trace-Context`.
  - `onRequestError` in `web/src/instrumentation.ts` writes one Error Reporting event per uncaught server error: `stack_trace`, `serviceContext { service: "dryscope-api", version }`, and `context.httpRequest` with the method and route pattern. The message is the error class plus the app's own refusal code when it is one, never a library's message text.
  - The fixed-text `console.error` lines in `route.ts` and `health/route.ts` stay as they are; they already carry no data.
- Infra: `clouderrorreporting.googleapis.com` in the data-root API list (TC-9). No IAM: Cloud Run sends stdout to Logging itself.
- Tests (unit):
  - A route that throws produces exactly one line in the documented Error Reporting shape.
  - The line carries the trace field from a sample header.
  - An error whose message holds an email, a bearer token and a coordinate pair produces a line without any of them.
  - A non-Node runtime does not register the handler.
- Needs: nothing. Can start now.

**TC-2 Browser and phone errors through a server route (M, High: a new public write endpoint).** Kind: agent code.
- UI: none (no new screen; the existing error pages keep their text).
- FE:
  - `web/src/lib/client-errors.ts`, mounted once from the root layout. It hooks `window.onerror`, `unhandledrejection` and React's `global-error.tsx` / `error.tsx` boundaries, and builds the C13 report.
  - At most 10 reports per page load, batched, sent with `keepalive` on `pagehide`.
  - Offline: up to 20 reports wait **in memory only**, are sent on `online` or when the page becomes visible, and are dropped when the page closes. There is no new phone store, so the S6 store list does not change.
- BE: `POST /api/client-errors`:
  - A `publicRoute`, added to the public list in `web/src/lib/public-api.ts`, because sign-in pages fail before anyone is signed in.
  - Zod checks a body of at most 8 KB and at most 20 reports, each field bounded.
  - Each instance caps reports at 60 a minute; any excess is answered 202 and counted, not logged.
  - The server scrubs again with the same rules as the browser and writes each report as a `ReportedErrorEvent` with `serviceContext.service = "dryscope-web-client"`.
  - Once TC-5 has landed, it records the App Check outcome; it never refuses on it.
- `docs/ACCESS.md` lists it as a public action with its limits. No role-matrix capability, because it reads no company data.
- DB: none. Infra: none.
- Tests:
  - Unit: Zod refusals, each scrub rule, the cap, and that the route reads nothing from Postgres or Firestore.
  - E2e, Chromium and WebKit at 390 px: a test page throws and rejects, and the server's log sink receives exactly two scrubbed reports. With the network cut and restored, the reports arrive once.
- Needs: TC-1. Correction to S6 (section 10).

**TC-3 Request tracing with OpenTelemetry into Cloud Trace (M, High: touches `withCompany`'s timing wrapper and the server's start-up).** Kind: agent code and owner IAM (in TC-9).
- BE:
  - `instrumentation.ts` registers a tracer provider in the Node runtime only, with the C10 package set.
  - An OTLP exporter sends to `https://telemetry.googleapis.com`, with a Google access token from `google-auth-library` (already a dependency).
  - The sampler is `ParentBased(AlwaysOn)`: Cloud Run's own sampling decision bounds volume.
  - Resource: `service.name=dryscope-api`, `service.version`, `gcp.project_id`.
  - Next.js's built-in spans cover route handlers and rendering.
  - Manual spans, because `postgres` (postgres.js) has no OpenTelemetry instrumentation: one span per `withCompany` transaction and per query kind, named by statement type and table, with no parameters; one per Firestore Admin call (collection name only); and a `withAiSpan` helper for S7 recording model name, prompt version id and token counts, never text.
  - The logger (TC-1) links each line to its span.
  - Off switch: `OTEL_SDK_DISABLED=true`. No exporter in local runs or CI.
- Infra (TC-9): APIs `telemetry.googleapis.com` and `cloudtrace.googleapis.com`; `roles/telemetry.tracesWriter` for the `api` runtime account (and later the Live relay's).
- Tests:
  - Unit with an in-memory exporter: one member request yields a route span with a database child span.
  - No span attribute contains an email, token or parameter value (scanned).
  - A failing exporter never fails a request.
  - The standalone build contains the packages: `build-image.sh`'s container smoke starts with tracing on.
  - Start-up time measured before and after on `test`, recorded in the pull request.
- Needs: TC-1. New dependencies per C10.

**TC-4 axe on every main screen, with a guard (S, Low: tests only).** Kind: agent code.
- Tests:
  - `web/tests/e2e/screens.ts` lists every `page.tsx` route pattern with the spec that checks it with axe (WCAG 2.0, 2.1 A and AA tags, as today).
  - A vitest guard lists `web/src/app/**/page.tsx` and fails on a page with no entry, the way `route-rules.test.ts` does for route wrappers.
  - A new axe check for the start page `/`.
  - Existing specs are not refactored. Their four copies of `expectAccessible` stay, because merging them would remove assertion lines and trip the Test guard. New checks use one shared helper.
- Needs: nothing. Can start now. Correction for every later UI step (section 10).

**TC-5 App Check in monitoring mode (L, High: sign-in client, every route wrapper).** Kind: agent code and owner cloud (TC-9, owner step 8).
- UI: the reCAPTCHA notice line on the sign-in pages (Google's wording, so the badge can stay hidden).
- FE:
  - `firebase-client.ts` calls `initializeAppCheck` with `ReCaptchaEnterpriseProvider` and automatic refresh on each company's Firebase app instance, before Auth or Firestore is used. S6-3's `field-db.ts` reuses that instance.
  - `BrowserSignInConfig` gains `appId` and `appCheckSiteKey` (public values).
  - The one `/api` fetch helper adds `X-Firebase-AppCheck`. It waits at most 3 seconds for a token, then sends without one (the old app's rule), so attestation never blocks a call.
  - The debug provider runs only on `localhost` and `127.0.0.1`.
- BE:
  - `web/src/lib/app-check.ts`: `APP_CHECK_MODE` is `monitor` (default) or `off`; `enforce` stops the server at start-up until TC-13.
  - In monitor mode the route wrappers verify with `getAppCheck().verifyToken()` (2-second limit, no replay protection) and write one line: `outcome` (valid, missing, invalid, unverified), method, route pattern, status.
  - Never a refusal.
- Infra:
  - New settings in the app root's `common_env` and in `settings-contract.ts` together, since `settings-contract.test.ts` holds them in step. These ride in the TC-11 apply.
  - The key and App Check registration are in TC-9.
  - Firestore and Authentication stay unenforced in the Firebase console.
- Tests:
  - Unit: each outcome, the timeout giving `unverified`, monitor never changing the status, `enforce` refused at start.
  - E2e, Chromium and WebKit: the header is sent; a provider that never returns a token still lets every screen and call work.
  - An axe check of the sign-in page with the notice.
- Needs: TC-9 (key, app id) to run for real; it can merge first behind an empty site key, which turns App Check off. Coordinate with S6-2 and S6-3 (section 6).

**TC-6 reCAPTCHA Enterprise on sign-in, audit mode (S, High: sign-in settings).** Kind: agent code; the owner runs it.
- BE (scripts):
  - `npm run platform:create-tenant` sets `recaptchaConfig { emailPasswordEnforcementState: "AUDIT" }` on each new tenant.
  - A new owner-run command, `npm run platform:recaptcha -- --tenant <id> --mode audit|off`, for existing tenants. It refuses `enforce` until TC-13 and prints only the tenant id and the mode.
  - Run by the owner, because Firebase Auth settings are owner-only (`AGENTS.md` rule 2).
- FE: none. Firebase JS SDK 13.1.0 loads reCAPTCHA for email/password flows once the tenant has a config (web SDK 9.20.0 or later).
- Infra (TC-9): the reCAPTCHA Enterprise API and the `identitytoolkit` service identity with `roles/identitytoolkit.serviceAgent`.
- Tests: unit for the request body and the refusals. The Auth-emulator e2e suite is unaffected.
- Real check (TC-12): `identitytoolkit.googleapis.com/recaptcha/verdict_count` and `risk_scores` show staff sign-ins from the iPhone.
- Needs: TC-9.

**TC-7 The 2.5 offline rule: acceptance tests inside S6-3 and S6-5 (no pull request of its own).** Kind: agent code in those steps.
- S6-3's sync gate gains a third condition. After `/api/me` answers and the access record is current, the phone calls `getToken(appCheck, true)` before `enableNetwork`. In monitor mode a failure or a 5-second wait does not hold the gate; it is counted on the phone. Under enforcement (TC-13) the gate waits with "Checking this phone" and retries. Either way nothing queued is deleted or locked.
- S6-5's failure classes gain: a refused App Check token from our own routes (only possible under enforcement) means "fetch a fresh token and retry", never "stop".
- Tests:
  - A write queued offline with an expired token (a fake App Check provider seam in `field-db.ts`) is sent exactly once after reconnect, and its journal entry is never dropped.
  - A token fetch that fails leaves the journal and queue untouched and the gate in the right state for the mode.
  - A photo refused for its token is retried, not blocked.
- The phone repeat (airplane mode for more than an hour, then reconnect) goes into the S6-9 iPhone checklist.
- Needs: TC-5's seam, or a stub seam if S6-3 lands first.

**TC-8 Release record: version, tag, GitHub Release with the manifest, rollback command, failure line (M, High: workflow, owner-approved).** Kind: agent code (**the only workflow change**) and one owner IAM grant (TC-9).
- Workflow, `.github/workflows/web-release.yml`:
  - The `build` job computes `YYYY.MM.DD-N` (UTC date; N is 1 plus the highest same-day tag, **counting the old app's tags**) and bakes it into the image as `APP_VERSION`. A rerun of the same commit reuses its image and its version.
  - A new final job `record` holds the workflow's only write permission, `permissions: contents: write` on that job alone. The Test guard's list (write to pull requests, issues, checks or statuses) does not include it, so no label is needed.
  - On success, after `deploy`, `record` runs `web/scripts/release-manifest.ts`, pushes the tag at the released commit, and creates a GitHub Release (pre-release, "test") with `manifest.json` attached and the rollback command in its notes.
  - On any failure after the gate, `record` writes one line with `gcloud logging write dryscope-release '{"env":"test","version":...,"result":"failed","run":...}' --payload-type=json --severity=ERROR`, for TC-11's alert (C11).
  - `gh` is installed pinned, as the old `deploy.yml` did.
- The manifest, a Zod schema in `release-manifest.ts`, holds:
  - version, environment, commit, image digest, the revision and the traffic it replaced;
  - **migration level** (the highest file in `web/migrations` at the commit; the migrate job applied all of them or the release stopped);
  - **Terraform tag**, the newest `infra-test-<root>-*` tag per root (C6);
  - **prompt and model versions**, from an AI registry file once S7 adds one, else `[]`;
  - **switch defaults**: `FLAG_NAMES`, all off by default;
  - **minimum phone version**: `MIN_CLIENT_EPOCH` once S6-6 lands, else `null`;
  - **rollback**: the exact `gcloud run services update-traffic dryscope-api-test --to-revisions=<previous revision>=100 --region=us-central1 --project=dryscope`, with the rule that the database never rolls back (the add-first rule keeps the previous code working).
- BE: `/api/health` also reports `version`, and `smoke-release.ts` checks it.
- Infra (TC-9): `roles/logging.logWriter` for `dryscope-deploy-test`.
- Tests:
  - Unit: the manifest schema, the migration level, the rollback command naming the remembered revision, version numbering including old-app tags and a second release on the same day.
  - `tests/test_web_release_workflow.ts`: `record` needs `deploy`; only `record` can write; the tag is pushed only after the traffic move succeeded; the failure line is written on every failure path after the gate.
  - The Standard's "rehearsal after any change to the release workflow": the owner runs one rollback on `test` from the first manifest (section 7 M).
- Needs: nothing to start. S6-6 fills one field later.

**TC-9 Data-root bundle: APIs, IAM, scanning, reCAPTCHA key and App Check (M, High: IAM, APIs, money).** Kind: agent Terraform and owner apply.
- Infra (`infra/dryscope/data`):
  - APIs: `clouderrorreporting`, `telemetry`, `cloudtrace`, `firebaseappcheck`, `recaptchaenterprise`, `containerscanning` (C5), `billingbudgets`, `cloudfunctions`, `cloudbuild`, `run`, `monitoring`. Already-on APIs are a no-op.
  - IAM:
    - `roles/telemetry.tracesWriter` for the `api` runtime account (conditioned to the project).
    - `roles/logging.logWriter` for the deploy account.
    - A new service account `dryscope-synthetic-<env>`, with `secretAccessor` on one new secret, `dryscope-<env>-synthetic-password`. The value is added by the owner, never in Terraform.
  - `vulnerability_scanning_config { enablement_config = "INHERITED" }` on the image repository, set explicitly.
  - `google_recaptcha_enterprise_key` (Website, `SCORE`, the environment's app host only, no localhost, no checkbox).
  - `google_firebase_app_check_recaptcha_enterprise_config` (`app_id` from a new variable that the owner fills from the registered web app; `token_ttl = "3600s"`).
  - The `identitytoolkit` service identity grant is owner-run, because creating a service identity is not a plain Terraform resource here.
  - **Added 2026-11-12 (D-023, G6): the 35-day backup window.** The evidence bucket gets a lifecycle rule deleting noncurrent versions after 28 days, with soft delete at 7 days in every environment (`evidence_soft_delete_days` is 30 in `live.tfvars` today, which would make the window 58 days); Cloud SQL keeps at most 30 retained backups (`sql_backup_retained_count` capped at 30); the Firestore field database gets a daily backup schedule kept 14 days, which does not exist today. Test: the plan shows the rule, the schedule and both limits, and a soft delete above 7 days or more than 30 retained backups is refused.
  - **Added 2026-11-12 (D-024, G7): GitHub keyless sign-in trusts the numeric repository id only.** `workload_identity_principal_set` accepts `attribute.repository_id` only; the repository-name form (`attribute.repository`) is refused. Test: a `terraform test` case for each form.
- Tests:
  - `terraform test` and `check-guards.js` cases: every new grant names one account and one condition; the key lists no wildcard or localhost.
  - `check-plan.js` accepts the plan with no deletes.
- Needs: owner step 8 (the web app id) for the App Check resource. The rest can apply before it.

**TC-10 Synthetic probe code (M, High: test credentials, a new deployable).** Kind: agent code.
- `web/synthetic/`:
  - `probe.ts`: pure `fetch`, no dependencies, so the existing `web` CI tests it.
  - An entry file using `@google-cloud/synthetics-sdk-api` (`runSyntheticHandler`), with its own `package.json` and lock file for the function build.
- Probe (C4, option A):
  1. Sign in as the synthetic technician of test company A through Identity Platform REST (`accounts:signInWithPassword` with `tenantId`). The password comes from a secret environment variable, and the request carries the test app's origin as a browser would.
  2. `GET /api/me` must say signed in to that company.
  3. `GET /api/jobs/{id}` (S5a-3) opens the fixed job and checks its fixed name.
  - The whole probe has a 30-second limit and logs only step names and status codes.
  - **Correction (2026-11-13):** the probe logs exactly these non-sensitive fields: severity, step name, status code and, on failure, a fixed failure code.
- Tests: unit with `fetch` stubbed for success, wrong password, membership removed, job 404, timeout and slow responses. Each failure names its step and contains no email, password or token. A local run against the dev server and the Auth emulator.
- Needs: S5a-3, https://github.com/nnorman100/adr-field-estimator/pull/341, for the jobs read route. New dependency per section 3.

**TC-11 App-root bundle: alerts to the phone, the error-rate rule, budget, synthetic monitor (M, High: cloud, money, monitoring).** Kind: agent Terraform and owner apply.
- Infra (`infra/dryscope/app`):
  - Variable `alert_channel_ids`: the full names of the phone channels the owner's device created (C1). Every policy notifies them plus the email channel; there is a test for it.
  - Uptime check on in `test` (`uptime_check_enabled = true`, C3).
  - Error rate (C2): a PromQL condition, 5xx above 2% of `run.googleapis.com/request_count` for 10 minutes **and** at least 5 errors. It replaces the count rule.
  - **Release failed:** `condition_matched_log` on `logName="projects/dryscope/logs/dryscope-release" AND jsonPayload.env="<env>" AND severity>=ERROR`, with `notification_rate_limit` 5 minutes and auto-close in 7 days.
  - **Backup failed** (C12): `condition_matched_log` on `logName="projects/dryscope/logs/cloudaudit.googleapis.com%2Fsystem_event" AND protoPayload.methodName="cloudsql.instances.automatedBackup" AND resource.labels.database_id="dryscope:dryscope-<env>-pg" AND protoPayload.metadata.windowStatus=("STATUS_FAILED" OR "STATUS_ATTEMPT_FAILED" OR "STATUS_SKIPPED")`.
  - **Synthetic monitor** (test only, like the scheduler):
    - `google_cloudfunctions2_function`: Node 22, 256 MiB, the `dryscope-synthetic-test` account, the password as a secret environment variable, source zipped from `web/synthetic` by a pinned packaging script before plan.
    - `google_monitoring_uptime_check_config` with `synthetic_monitor`, every 15 minutes (C4).
    - Its alert on `uptime_check/check_passed`.
  - **Budget** (C8): created once for the project (only when `environment == "test"` and a billing account is passed), $200 a month, 50, 90 and 100%, notifying the phone and email channels.
  - **Added 2026-11-12 (D-020, G3): a monthly Agent Platform spend cap** on each project that uses AI, set above the sum of the companies' AI budgets so the app's own ceilings act first; when it triggers, the app keeps working with AI off. Never a cap on Cloud Run on live. Test: the cap exists once per project and is above the configured company budget sum.
  - TC-5's settings in `common_env`.
- Tests:
  - `terraform test`: every policy has the phone and email channels; one budget per project; the release and backup filters match fixed sample entries (one from the docs' `windowStatus` example with the status swapped); the uptime and synthetic checks exist in `test`.
  - `check-plan.js` with no deletes.
- Needs: TC-8 (log format), TC-10 (function source), TC-9 applied (APIs, accounts), the owner's phone channel (section 7 A).

**TC-12 Close-out gate: docs, owner drills and real-service checks (S, Medium: docs and checks only).** Kind: agent docs and owner checks.
- Docs:
  - `docs/MONITORING.md` rewritten for project `dryscope` (the old project's content moves to a legacy section).
  - `docs/runbook/`: reading a trace, Error Reporting, App Check monitor results, scan results, alert drills, rolling back from a manifest, `infra-*` tags after an apply.
  - `owner-cloud-steps.md` items in their place (section 7).
  - `docs/ARCHITECTURE.md` profile at Standard version 2.6.
  - `SECURITY.md` (App Check, reCAPTCHA, the client-error route), `ACCESS.md`, `DATA.md` (what logs, spans and client reports hold), `AI.md` (the manifest's prompt and model fields).
  - `docs/status/` updated in the batch after merges.
- Real-service checks on `test`, recorded apart from mock results:
  - one trace from route to database;
  - one server error and one iPhone browser error in Error Reporting, each with no personal data;
  - App Check outcomes `valid` from staff phones;
  - sign-in reCAPTCHA verdicts;
  - the first GitHub Release with its manifest, and one rollback rehearsal from it;
  - scan results listed for the serving image;
  - the synthetic monitor passing;
  - every alert drill reaching the phone (section 7 L).
- Needs: TC-1 to TC-11 and S6-9's iPhone session (shared).

**TC-13 Enforcement (S, High; after C7, not before the first test user).** Kind: agent code and owner cloud.
1. Sign-in reCAPTCHA moves to `ENFORCE` per tenant through the TC-6 command. The synthetic monitor's tenant stays on `AUDIT` or the monitor moves to its own test tenant (section 11).
2. `APP_CHECK_MODE=enforce` for `/api` writes: refusal `app_check_required` (401), which the phone treats as "retry with a fresh token" (TC-7). Plus an alert when refusals spike (the Core "alerted when they spike"). The synthetic monitor carries a registered debug token from Secret Manager.
3. Firestore and Authentication enforcement in the Firebase console, each checked on `test` first.

Needs C7's criteria met. Each surface is its own pull request or owner step.

## 6. What can run in parallel

In flight on 2026-11-12:
- S4-6, https://github.com/nnorman100/adr-field-estimator/pull/340, then S4-7 (price screens).
- S5a-3, https://github.com/nnorman100/adr-field-estimator/pull/341, then S5a-4 to S5a-12 (S5a-6 job screens). The database lane's next job is S5a-7.
- S6 wave A: S6-2 to S6-6. S6-1 merged as https://github.com/nnorman100/adr-field-estimator/pull/339.

TC adds **no database job**, so it never waits for that lane.

| Wave | Steps | Waits on |
| --- | --- | --- |
| A (now) | TC-1, TC-4, TC-8, TC-9 (Terraform written now; owner applies when ready) | Nothing. All four run beside S4, S5a and S6 today. |
| B | TC-2, TC-3 (after TC-1); TC-5 (any time; its live test needs TC-9 applied and owner step 8); TC-6 (after TC-9 applied) | TC-1; TC-9 apply |
| C | TC-10 | S5a-3 (#341) merged |
| D | TC-11, then the owner's app-root apply (also the long-pending owner step 9) | TC-8, TC-9 applied, TC-10, the owner's phone channel |
| E | TC-12, shared with S6-9's iPhone session | TC-1 to TC-11, S6-9 |
| Later | TC-13 | C7's criteria |
| Inside S6 | TC-7 | S6-3, S6-5 |

**Shared files** (the second to merge rebases):

| Files | TC steps | Other steps |
| --- | --- | --- |
| `web/src/lib/firebase-client.ts`, `web/src/lib/config.ts` (`BrowserSignInConfig`) | TC-5 | S6-2, S6-3 (`field-db.ts`) |
| `web/src/lib/auth/route.ts` (App Check hook) | TC-5 | S6-6 (adds `requireCurrentClient` to routes; does not edit the wrappers) |
| `web/src/lib/public-api.ts` | TC-2 | S5a routes add member paths |
| `web/src/instrumentation.ts` | TC-1, TC-3 | none in flight |
| `web/src/db/tenant.ts` | TC-3 (spans) | S5a steps use `withCompany` but do not change it |
| `.github/workflows/web-release.yml` | TC-8 | none known |
| `infra/dryscope/app/*.tf` | TC-11 | S6-7 may add a scheduler job |
| `infra/dryscope/data/*.tf` | TC-9 | none known |
| `web/tests/e2e/screens.ts` (guard) | TC-4 | every new screen: S4-7, S5a-6, S6-2 (section 10) |

## 7. Owner cloud steps, in order (to merge into `docs/runbook/owner-cloud-steps.md`), and the phone check

| # | Step | Needs | Verify |
| --- | --- | --- | --- |
| A | Install the Google Cloud console app on the phone, sign in, open project `dryscope`. Monitoring creates a mobile channel. Copy its full name from Monitoring, Alerting, Edit notification channels (Mobile Devices) into `TF_VAR_alert_channel_ids`, never into git. | none | "Send test notification" reaches the phone |
| B | Re-plan and apply the **data root** with TC-9, after `check.sh` and `check-plan.js`. Scanning starts billing at once (C5). | TC-9 merged | The plan check passes with no deletes; the APIs are listed as enabled |
| C | `gcloud beta services identity create --service=identitytoolkit.googleapis.com --project=dryscope`, then grant `roles/identitytoolkit.serviceAgent` to that identity. | B | The IAM policy shows the one grant |
| D | Owner step 8 if not done (register the web app). Pass its app id as the TC-9 variable and re-apply (B), which registers App Check with the reCAPTCHA key. Leave every product **unenforced** in Firebase, App Check. | B | The App Check page shows the web app with reCAPTCHA Enterprise and no enforcement |
| E | `npm run platform:recaptcha -- --tenant <id> --mode audit` for each test tenant (from `web/`, with your own `gcloud auth application-default login`). | C, TC-6 merged | Verdict metrics appear after a sign-in |
| F | Add a value to `dryscope-test-synthetic-password`. As operator, invite the synthetic technician to test company A; create one fixed job; put its id in `envs/test.tfvars` (not a secret). | B, S5a-3 | The probe passes locally against `test` |
| G | Apply the **app root** with TC-11 and TC-5's settings, with `TF_VAR_alert_email`, `TF_VAR_alert_channel_ids` and `TF_VAR_billing_account_id`. You need Billing Account Administrator on the billing account for the budget (C8). This is also owner step 9 if it has not run. | A, B, F, TC-11 merged | The plan check passes; one budget exists; the policies list the phone channels |
| H | After each apply, push `infra-test-<data\|app>-YYYY.MM.DD-N` at the applied commit (C6). | G | The next manifest names it |
| I | GitHub, Settings, Notifications, Actions: failed workflows only, to GitHub Mobile, as the backup for release failures before Google sign-in (C11). | none | A failed run reaches the phone |
| J | Gemini Cloud Assist (C9): Cloud console, Gemini Cloud Assist, enable for `dryscope`, and grant yourself Gemini Cloud Assist User if asked. Investigations are not available without Premium Support. | none | The chat panel answers on the Cloud Run page |
| K | Query Insights check: `gcloud sql instances describe dryscope-test-pg --project=dryscope --format='value(settings.insightsConfig.queryInsightsEnabled)'` prints `True`. | none | Recorded in TC-12 |
| L | Alert drills, recorded in TC-12:<br>• **Uptime:** point the test check's path at a missing page in the console, wait for the alert, put it back (the next plan shows no drift).<br>• **Release failed:** `gcloud logging write dryscope-release '{"env":"test","result":"failed","drill":true}' --payload-type=json --severity=ERROR --project=dryscope`.<br>• **Backup failed:** run its filter in Logs Explorer with `STATUS_SUCCEEDED` in place of the failure states and see the latest backup match. Audit logs cannot be faked.<br>• **Synthetic:** change its job id to a missing one for one run.<br>• **Budget:** the test notification. | G, TC-12 | Each one reaches the phone |
| M | Rollback rehearsal (the Standard's "after any change to the release workflow"): run the rollback command from the first TC-8 manifest on `test`, check `/api/health`, release forward again. | G, TC-8 | The date and result are in `RELEASES.md` |

**Phone check** (about 10 minutes, inside the S6-9 iPhone session):
1. Sign in on the installed app with email and password: the reCAPTCHA audit verdict appears in Monitoring.
2. Open a job: App Check outcome `valid` for that phone.
3. Airplane mode for more than an hour with an edit queued, then reconnect: the edit arrives once (TC-7) and App Check shows a fresh `valid`.
4. Take an alert drill on the phone and open it from the notification.

## 8. Owner decisions (all decided 2026-11-12)

The owner answered every question below on 2026-11-12 as recommended; the "Decided" column shows the chosen option. Options are listed smallest first. "Applies to" is the first step that needs the answer.

| # | Question | Options | Decided (2026-11-12) | Cost and reason | Applies to |
| --- | --- | --- | --- | --- | --- |
| C1 | How alerts reach your phone. | **A.** The Google Cloud console app (install, open `dryscope`; Monitoring makes the channel), with the existing email kept as the backup Google advises.<br>**B.** Add SMS (console verification; Google calls it not fully reliable; 200 per number a day).<br>**C.** Both. | **A** | **A.** $0. | TC-11 |
| C2 | The error-rate alert. | **A.** Keep today's count (more than 5 server errors in 10 minutes); departs from the Standard.<br>**B.** The Standard's rate (server errors above 2% of requests for 10 minutes) **and** at least 5 errors, so 1 failed request in 20 at night does not wake you.<br>**C.** The rate alone. | **B** | **B.** $0 until alerting prices start (2027-09-01), then about $0.35 a month. | TC-11 |
| C3 | Uptime check on the test copy. | **A.** On, every 5 minutes from three regions; it wakes the scale-to-zero test service about 288 times a day.<br>**B.** Off; rely on the synthetic monitor (does not meet "down from two regions"). | **A** | **A.** $0: under 1 million free checks; Cloud Run bills only request time. | TC-11 |
| C4 | The synthetic monitor's shape and interval. | **A.** A no-browser probe: signs in through Identity Platform as a synthetic technician of test company A, reads `/api/me`, opens one fixed job through the jobs API; 256 MiB.<br>**B.** A Puppeteer browser walk through the real screens; needs S5a-6 and 2 GiB, plus a large dependency.<br>Interval: 5, 15 or 60 minutes. | **A, every 15 minutes** | About 2,880 runs a month, about $3.34 after the 100 free, plus a few cents of function time. 5 minutes is about $10.25; 60 minutes about $0.74. | TC-10, TC-11 |
| C5 | Container scanning scope. | **A.** Turn on automatic scanning for the project: every new image in every Docker repository is scanned once, then watched for 30 days free.<br>**B.** A daily on-demand scan of the serving image only: about 30 scans, about $7.80 a month, plus a scheduled job, an extra API and IAM. | **A** | **A.** $0.26 per new image. About 100 web images a month at the November pace (41 `web/` commits in 12 days) is **about $26 a month**, the largest new cost here. Revisit if the budget alert fires. | TC-9 |
| C6 | The manifest's "Terraform tag". | **A.** After each apply you push `infra-<env>-<root>-YYYY.MM.DD-N` at the applied commit (one runbook line); the manifest records the newest per root.<br>**B.** Terraform stamps the applied commit into a label the release can read (a new input on every apply plus a read path). | **A** | **A.** $0. | TC-8 |
| C7 | When enforcement starts (App Check on `/api`, Firestore and Auth; sign-in reCAPTCHA `ENFORCE`). | **A.** After S6-9's iPhone check passes and two weeks of staff use show at least 99% `valid` App Check outcomes and no low-score staff sign-ins; then one surface at a time, sign-in first, each a High pull request or owner step.<br>**B.** At the first test user. | **A** | **A.** B risks locking staff out on an iPhone nobody has measured. | TC-13 |
| C8 | The budget. | **A.** One $200 a month budget for project `dryscope` (the Standard's figure), alerting at 50, 90 and 100% to the phone and email, created once. You need Billing Account Administrator at apply.<br>**B.** One budget per environment using the `environment` label; misses unlabelled costs such as monitoring and scanning.<br>Today's stub: $300 per environment, each counting the whole project. | **A** | **A.** $0 (budgets never cap spend). | TC-11 |
| C9 | Gemini Cloud Assist. | **A.** You turn it on in the console and grant yourself Gemini Cloud Assist User. Chat only: investigations need Premium Support since 2026-04-10. Cloud Assist may keep data in any Google data center; DryScope has no residency rule on record.<br>**B.** Terraform the API and your role (puts your account in a Terraform input). | **A** | **A.** $0. | owner step J |
| C10 | Tracing packages. | **A.** Minimal: `@opentelemetry/api`, `sdk-trace-node`, an OTLP exporter and `resources`, using `google-auth-library` (already a dependency) for the token; hand-written spans for Postgres, Firestore and later Gemini.<br>**B.** `@opentelemetry/sdk-node` with `auto-instrumentations-node` (dozens of packages; still nothing for postgres.js). | **A** | **A.** $0 at test-copy volume (2.5 million spans a month free). | TC-3 |
| C11 | How a failed release reaches your phone. | **A.** GitHub's own failed-run notification to GitHub Mobile (a setting; reaches only the person whose merge started the run).<br>**B.** The release writes an error line to Cloud Logging and a log-based alert pages your phone (the workflow change in TC-8 plus a log-writer grant for the deploy account), with A kept as the backup for failures before Google sign-in. | **B**, with GitHub Mobile (A) kept as the backup | **B.** $0. | TC-8, TC-11 |
| C12 | The failed-backup alert. | **A.** A log-based alert on the automated-backup audit log: failed, attempt failed, or skipped (instance stopped).<br>**B.** Also "no successful backup in 26 hours" through a log-based metric with an absence condition. | **A** | **A.** $0. B adds about $0.35 a month from 2027-09; add it if a backup ever goes silent. | TC-11 |
| C13 | What a browser or phone error report contains. | **A.** Error name; message scrubbed and cut to 300 characters (email-like text, long digit runs, URL query strings and token-like strings removed); stack lines from the app's own scripts only; route pattern, not the address; app version; browser family. Nothing about the person or company.<br>**B.** Also the company id and a hash of the user id, to help support. | **A** | **A.** $0. | TC-2 |

## 9. The eight checks for TC

| Check | For these steps |
| --- | --- |
| Rules and indexes | No Firestore rules or index change. No Postgres change; no database job. |
| Older records | None. Clean start (D-006); the old app's projects and tags are never changed. The old tags are only counted when numbering releases (TC-8). |
| Offline | The 2.5 rule (TC-7): a stale or missing App Check token never drops, locks or blocks queued work. Client error reports wait in memory while offline (TC-2). |
| Who may use it | One new public route, `/api/client-errors`: write-only, capped, reads no company data, listed in `ACCESS.md`. App Check is monitor-only until TC-13. Sign-in reCAPTCHA is in AUDIT. No new capability key. |
| App cache | No change. TC-2 adds no phone store; App Check's own token cache is the SDK's. |
| Help and docs | The reCAPTCHA notice on sign-in. `MONITORING.md`, the runbook, `SECURITY.md`, `DATA.md`, `ACCESS.md`, `AI.md` and the profile version (TC-12). |
| Privacy and logs | Hard rule 6 tests on every new path (TC-1, TC-2, TC-3). Route patterns, not paths. No bodies. `record_client_address` stays off. Phone channels hold no personal data in git. |
| Phone check | Section 7's check inside S6-9's iPhone session; every alert drill reaches the phone (TC-12). |

## 10. Corrections this plan asks for in earlier plans

Recorded under "Corrections" in the named plan files in the pull request that commits this plan (S5.md, pricing.md and S6.md, dated 2026-11-12). The `ARCHITECTURE.md` profile line changes in TC-12 and the `README.md` line is added with this plan.

| File | Change |
| --- | --- |
| `S6.md` section 3, "No data in logs" | "There is no client telemetry until S9" becomes: browser and phone **error reports** go to `/api/client-errors` (TC-2, required by Standard 2.5 Tier 1). Still no counters, analytics or other client telemetry until S9. |
| `S6.md` S6-3 | The sync gate fetches a fresh App Check token before enabling the network. In monitor mode a failed fetch does not hold it; nothing queued is ever dropped for a token (TC-7, with its tests). |
| `S6.md` S6-5 | A refused App Check token from our own routes is a retry-with-fresh-token class, never a stop (TC-7). |
| `S6.md` S6-6 | `MIN_CLIENT_EPOCH` is also read by the release manifest (TC-8). |
| `S6.md` S6-9 | The iPhone checklist gains the App Check offline repeat and the TC-12 phone checks. |
| `S5.md` S5a-6, `pricing.md` S4-7, `S6.md` S6-2 (and every later UI step) | Each new page adds its axe check and its entry in `web/tests/e2e/screens.ts`; the TC-4 guard fails a page without one. |
| `docs/ARCHITECTURE.md` profile | "Standard version 2.4" becomes 2.6 (TC-12). |
| `docs/plans/README.md` | Adds the TC line. |

## 11. Risks

| Risk | Effect | Handling |
| --- | --- | --- |
| reCAPTCHA scores in an installed Home Screen app on iPhone are unmeasured. | Under enforcement, staff could be refused sign-in or writes. | Monitor and audit first. C7's criteria are read from `risk_scores` and App Check outcomes from staff phones; enforce one surface at a time (TC-13). |
| The synthetic monitor has no browser reCAPTCHA token and no App Check token. | Refused once sign-in or `/api` is enforced: a false outage. | At TC-13, keep its tenant on AUDIT (or give it its own test tenant) and give it a registered App Check debug token from Secret Manager. Test only; fake data only. |
| The Firebase web API key is restricted to the test app's address. | The probe's server-side sign-in call could be refused. | The probe sends the app's origin as a browser does (the key is public by design). If that is refused, C4 falls back to a separate key restricted to the Identity Toolkit API, held in Secret Manager. |
| OpenTelemetry packages and the Next.js standalone build. | Missing modules in the image, slower cold starts on scale-to-zero `test`. | The image smoke starts with tracing on; start-up measured; `OTEL_SDK_DISABLED` switch; minimal package set (C10). |
| Personal data in logs, spans or client reports (hard rule 6). | A privacy breach in Logging, Trace or Error Reporting. | Allowlisted fields, route patterns, scrubbing on both sides, crafted-data tests in TC-1, TC-2 and TC-3; review checks DATA.md. |
| `/api/client-errors` is public. | Log flooding or cost. | Size and count limits, a per-instance cap, App Check outcome logged; enforcement later. 50 GiB of logs a month are free. |
| Release tags share the old app's `YYYY.MM.DD-N` names. | A clash or a confusing "Latest" release. | Numbering counts every existing tag; new releases are marked pre-release "test" until live exists. |
| Budget double count today. | Two budgets each count all spend once both environments apply with a billing account. | One project budget (C8). |
| Alerts exist only after the app-root apply. | No alert reaches anyone before the first test user. | TC-11's apply is the same as the long-pending owner step 9, which the first test user needs anyway. |
| Mobile, Slack and webhook channels share one Google service. | One outage silences the phone. | Email stays on every policy (Google's advice); GitHub Mobile is the second path for release failures. |
| Log-based alert limits (20 a day, 5 minutes between repeats). | A burst is under-reported. | One policy per cause, a rate limit set; Error Reporting groups the detail. |
| Error Reporting does not apply JavaScript source maps. | Browser stacks are minified. | Reports carry the version. Later: keep each build's source maps as a private release asset. |
| Scanning cost follows merge volume. | Higher spend in busy weeks. | C5 estimate; the $200 budget alerts at 50%; switch to C5 B if needed. |
| Firestore SDK behaviour with App Check on queued writes is undocumented. | A stale token could stall sync. | The S6-3 gate fetches a fresh token itself; TC-7 tests it; the phone check repeats it. |
| Gemini Cloud Assist may store data outside the US. | Data residency. | No residency rule is on record; C9 states it; chat only, no investigations. |
| A Test guard trap. | Merging the four `expectAccessible` copies would reduce assertion lines and trip the guard. | TC-4 adds, never refactors. |

## 12. Costs (new monthly spend, test copy at staff scale)

| Item | Price (source in section 2) | Estimate |
| --- | --- | --- |
| Container scanning | $0.26 per new image | **About $26** at about 100 images a month (C5 A) |
| Synthetic monitor | $1.20 per 1,000 runs, 100 free | About $3.34 at 15 minutes, plus a few cents of function time |
| Uptime checks | 1 million free per project | $0 |
| Alerting policies | Free until 2027-09-01, then $0.35 per metric reference | $0 now, about $2 later |
| Cloud Trace | 2.5 million spans free | $0 |
| Logging and Error Reporting | 50 GiB per project free | $0 |
| reCAPTCHA (App Check refreshes plus sign-ins) | 10,000 free, then a flat $8 to 100,000 | $0 (about 2,000 to 3,000 a month for a handful of staff) |
| Query Insights, budgets, Gemini Cloud Assist chat | No charge listed | $0 |
| **Total** | | **About $30 a month**, inside the $200 budget |

**Later (not in TC):**
- The probe as the release's sign-in and open-record smoke step (after S5a-8, add create-and-submit).
- The Standard's "runner down" alert.
- The App Check failure-spike alert (lands with TC-13).
- Keeping source maps as a private release asset.
- Live wiring for every alert at S8.
- The agent spending cap (runner side).

## 13. Corrections

Later changes to this plan, newest last.

- **2026-11-12, S7 plan ([S7.md](S7.md)), owner-approved.** TC-3 and TC-8: `withAiSpan` is used by S7-1, and the manifest's "prompt and model versions" come from `web/src/lib/ai/registry.ts`; the manifest also gains the relay image digest (S7-R).
- **2026-11-12, Technology Standard 2.7 decisions ([DECISIONS.md](../DECISIONS.md) D-020, D-023, D-024), owner-approved.** TC-9 gains the 35-day backup window (D-023: evidence noncurrent versions deleted after 28 days plus 7 days of soft delete, Cloud SQL at most 30 backups, a Firestore daily backup schedule kept 14 days) and the numeric-`repository_id`-only keyless sign-in (D-024). TC-11 gains the monthly Agent Platform spend cap (D-020). Plan text only; the Terraform lands in those pull requests, owner-applied. The `docs/ARCHITECTURE.md` profile already reads Standard version 2.9 (set with the 2.7 decisions), so TC-12's "2.6" target (sections 4 and 9) is already met and TC-12 only keeps it current.
- **2026-11-14, TC-9 grants without IAM conditions (owner decision A).** TC-9's "conditioned to the project" (the trace grant) and its test "every new grant names one account and one condition" are amended: these three grants each name one account and carry no IAM condition, and `check-plan.js` (`infra/dryscope/scripts/check-plan-tc.js`) enforces exactly these three grants with no condition. Google's [resource attributes](https://cloud.google.com/iam/docs/conditions-resource-attributes) list the services IAM Conditions can scope.
  - `roles/telemetry.tracesWriter` for `dryscope-api-<env>` on project `dryscope`. The Telemetry API and Cloud Trace are not among the services IAM Conditions can scope by resource, and a condition naming a resource attribute such a service does not report is never interpreted as granting access, so it would silently drop every span.
  - `roles/logging.logWriter` for `dryscope-deploy-test`, test only. A log entry has no IAM resource of its own to condition on, so the grant is project-wide.
  - `roles/secretmanager.secretAccessor` for `dryscope-synthetic-test`, granted on the single secret `dryscope-test-synthetic-password` itself. Resource-level IAM already limits it to that one secret, so a condition adds nothing.
- **2026-11-17, S8 plan ([S8.md](S8.md)), owner-approved.** Section 12, "Live wiring for every alert at S8", is S8-10. The synthetic monitor's address and the reCAPTCHA key's domains move to the public address in S8-13. TC-13's state on live is go-live gate G3.
