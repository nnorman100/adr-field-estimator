# Decision log

Newest at the bottom. Never delete; mark superseded. Dates come from `docs/roadmap.md`, `VISION.md`, `AGENTS.md` and `RELEASES.md`; confirm any marked [confirm].

## Template

```
### D-NNN: Title
Date · Status: accepted | superseded by D-NNN
Context · Options · Decision · Consequences
```

### D-001: Mirror the company workbook for prices (Oct 2026)

Status: accepted. Prices come from the company's estimating workbook, calculated in Decimal on the server. ADR's after-hours labor stays at the workbook formula's rate even though the sheet lists a higher one (owner chose to mirror the formula). A model never overrides a total.

### D-002: One product named DryScope, built on this repo (Oct 24, 2026)

Status: accepted. The Next.js `nnorman100/Dryscope` repo is only a feature source, rebuilt here in this repo's style. No repo rename or domain. Firebase project stays `alert-disaster-field-2026`.

Superseded for the rebuild (Nov 9, 2026, owner): the TypeScript rebuild lives in project `dryscope` (see D-006 and D-012); the current app stays in `alert-disaster-field-2026`.

### D-003: Static frontend, no build step

Status: accepted. Same-origin vendored dependencies; browser never loads Google scripts (maps go through the backend).

### D-004: Deny-all database rules; server enforces access

Status: accepted. All access goes through the backend, which checks company membership and job access on every call.

### D-005: Emails hold private links, not PDFs; crew lead by email now, text later (Oct 24, 2026)

Status: accepted.

### D-006: Add a separate test project before a second company subscribes (Oct 28, 2026)

Status: accepted (owner). Until then, releases keep staging at 0% traffic in production. Adding the test project is a prerequisite for onboarding the second company.

Superseded (Nov 6, 2026, owner, per the rebuild plan): test resources, databases, identities and release targets are isolated inside `alert-disaster-field-2026` instead of a separate project. Isolated test resources remain a prerequisite for onboarding the second company.

Further superseded (Nov 9, 2026, owner): the TypeScript rebuild is a clean start in dedicated project `dryscope` (`570228742694`), with separate `test` and `live` resources there and no data migration from `alert-disaster-field-2026`. Throwaway test data stays in CI and the `test` environment's own smoke-test company; there is no hidden test company on `live`, and `live` checks are read-only. Test Cloud SQL uses the shared-core `db-f1-micro` tier (`ENTERPRISE`, zonal, about $10/month; no uptime guarantee, fine for test), while `live` keeps the dedicated `db-custom-1-3840` tier. Resources are defined in `infra/dryscope/`; `alert-disaster-field-2026` keeps serving the current app unchanged until the rebuilt app is live.

Further superseded (Nov 12, 2026, owner, D-018): Technology Standard 2.7 gives each environment its own Google Cloud project. `dryscope` stays the `test` project; the `live` project is created before S8. The Nov 9 note's "separate `test` and `live` resources there" no longer holds for live.

### D-007: Switch email to Resend before a second company subscribes (Oct 28, 2026)

Status: accepted (owner). Gmail stays for ADR until then. Background: production uses Gmail SMTP (`INVITATION_TRANSPORT=smtp`) from a personal account, capped near 500/day. The code already supports the Resend email service (`INVITATION_TRANSPORT=resend`, the default, with `RESEND_API_KEY` and `INVITATION_FROM`; see `mail_settings` in `backend/workspaces.py`). What remains is the owner's decision, a sending domain, the secret, and a release. Note the name clash: the in-app **Resend** button re-sends documents and is unrelated to the Resend service.

### D-008: DryScope stays a standalone product for now (Oct 28, 2026)

Status: accepted (owner). Options considered: stay standalone; fold into the platform later; rebuild on the platform. Keep shipping in this repo; revisit once DryScope has paying companies. Billing for other companies does not exist here yet; the approved billing stage plan is [docs/plans/BILLING.md](plans/BILLING.md) (2026-11-17).

### D-009: Agents ask before merging any PR (Oct 28, 2026)

Status: accepted (owner). Overrides the roadmap's earlier rule that agents may merge Low/Medium risk PRs with green CI. Enforced by the `gh pr merge` approval rule in `.claude/settings.json`.

Superseded (Nov 6, 2026, owner, per the rebuild plan's settled "test-to-live deployment and ordinary automatic reviewed merges"): pull requests merge automatically once every check passes and the review is done, with two separate independent reviews on top of the pipeline review, from models that did not write the code for high-risk work; deploys run to test first, then live. Still owner-only: anything that deletes data, cannot be undone, or changes security or permissions (IAM, secrets, Firebase Auth settings); turning on deletion or new pricing; and production steps the owner runs.

Reinstated (Nov 9, 2026, owner): see D-012. The Nov 6 supersession no longer applies; agents ask before merging any PR.

Updated (Nov 12, 2026, owner): standing approval, in the owner's words: "standing approval: merge low-risk PRs when green, waive known-infra check failures, do housekeeping, and proceed on your recommendation for in-plan calls; keep high-risk merges, money, permissions, cloud, live and deletions with me." Meaning: the supervising agent may merge Low and Medium risk PRs once every check is green, and may waive only known infrastructure check failures, putting the reason on the PR. Worker agents still never merge. High-risk PRs need the owner's approval, and deletions, money, permissions, cloud, live and anything irreversible stay with the owner. This replaces "agents ask before merging any PR" (D-009 and D-012) for Low and Medium risk only. The `gh pr merge` approval rule in `.claude/settings.json` is unchanged.

### D-010: No default prices; ADR's rates are ADR's alone (Nov 2, 2026)

Status: accepted (owner). Superseded in part for the rebuild by D-017 (Nov 10, 2026): no default prices and "no published prices, no estimate" still hold, but no ADR rate book is kept in code. ADR's estimating sheet is proprietary to ADR, so it is not a product default. A company without published prices is blocked from pricing with a clear message. ADR's rates are kept as ADR's data and used only for company `adr`, and no rate ships in browser code. Later steps of the owner-pricing plan add owner-defined tables; formulas and `CALCULATION_VERSION` are unchanged here.

### D-011: Owner-defined pricing tables; ADR stays on v1 until the owner switches (Nov 3, 2026)

Status: accepted (owner). Superseded for the rebuild by D-017 (Nov 10, 2026): the rebuilt app has no `adr-residential-v1`, no Switch to v2 and no mapping from the old app. Every company prices from its own table of items and estimate settings (`dryscope-v2`). A new company starts from the blank starter list; no company but ADR ever sees ADR's rates. A company already on a rate book, ADR included, stays on `adr-residential-v1` until its owner chooses **Switch to v2**, reviews the mapped table and publishes it. There is no way back after publishing. A draft begun before the switch keeps its rate book until the owner applies the new table to that one draft, and signed documents never change. The switch names its three differences for the same job: the high end tapers above 1,000 sq ft instead of stepping, labor hours carry 50% at every size, and the after-hours 20% prints as a line inside the itemized total. `PRICE_BOOKS_ENABLED` is the only flag; turning it on in production is a separate release with the owner's word.

### D-012: Owner approves every merge; clean start in project dryscope (Nov 9, 2026)

Status: accepted (owner). Standing decisions recorded together:

- The owner kept D-009. The owner approves every merge and there is no automatic merging; the Nov 6 supersession of D-009 no longer applies. Agents ask before merging any PR.
- The rebuild is a clean start in project `dryscope` with no data migration from `alert-disaster-field-2026` (D-006, Nov 9 note).
- Test environment only for now.
- Live voice is the default capture method.

### D-013: Build server and CI runner on a Hostinger VPS (Nov 10, 2026)

Status: accepted (owner, Nov 10, 2026). Exception to Technology Standard 2.2.
Reason: the standard puts the build server and CI runner on a Google Cloud VM with no public IP. That needs the company domain and Google Cloud organization, which do not exist yet. Until they do, the build server and CI runner stay on a Hostinger VPS.
Known effect: this server cannot reach the test Cloud SQL address, so release migrations are moving inside Google (a Cloud Run job, PR #297). Until that lands, the `migrate` job in `.github/workflows/web-release.yml` runs them from the self-hosted runner through the Cloud SQL Auth Proxy.
Ends when the company domain and Google Cloud organization exist.

### D-014: DryScope may use more than three agents (Nov 6, 2026)

Status: accepted (owner, Nov 6, 2026). Exception to the standard's limit of three agents.
Reason: the rebuild is parallel work across many stages. DryScope may use every available agent.

### D-015: Pipeline reviewer is Grok 4.7, then ChatGPT; never the builder's family (Nov 9, 2026)

Status: superseded by D-029 (owner, Nov 13, 2026). Kept as recorded. Exception to the standard's choice of pipeline reviewer.
Reason: ChatGPT is unavailable for now. The pipeline reviewer is Grok 4.7 until ChatGPT returns (planned Nov 13, 2026), then ChatGPT. The reviewer is always a different model family from the builder.

### D-016: Company sign-in tenants are created by an owner- or operator-run command for the pilot (Nov 9, 2026)

Status: accepted (owner, Nov 9, 2026; confirmed Nov 10, 2026). A decision, not an exception: it is now written into Technology Standard 2.2.
Decision: for the pilot, a company's sign-in tenant is created by a command the owner or an operator runs, not by self-service sign-up. See the S3 plan (decision D4) in `docs/plans/S3.md`.

### D-017: Owners set their own prices; exact match with the old Python prices is no longer required (Nov 10, 2026)

Status: accepted (owner, Nov 10, 2026, "accept all" on the pricing plan). Supersedes D-010 and D-011 for the rebuild (`web/`); the old app is unchanged until it is retired.
Decision: the rebuilt app does not have to reproduce the old Python engine's numbers or text quirks, and no oracle comparison is required. Every company, ADR included, enters its own prices fresh in the rebuilt app; nothing is exported from the old app or imported from it, and the engine holds no ADR rate book. Still true from D-010: there are no default prices, and a company without published prices cannot price an estimate. Pricing rules, mandatory wording and signed-record immutability are unchanged; the Test guard still protects the replacement tests.
Detail: `docs/plans/pricing.md` (section 9 lists every answer, Q1 to Q15 and M1 to M10).

### Owner decisions on Technology Standard 2.7 (Nov 12, 2026): D-018 to D-028

The owner approved Technology Standard 2.5, 2.6, 2.7 and 2.8 on Nov 12, 2026, and answered decisions G1 to G10 of the 2.7 review all as recommended, except G4. The Standard is now at 2.9. Each entry below binds DryScope; the numbers G1 to G10 are the review's. Terraform and code work that follows from them is in the stage plans (`docs/plans/TC.md`, `docs/plans/S7.md`), not here.

### D-018: One Google Cloud project per environment; the live project is created before S8 (Nov 12, 2026, G1)

Status: accepted (owner, Nov 12, 2026). Supersedes the "separate `test` and `live` resources in `dryscope`" part of D-006's Nov 9 note.
Decision: each environment has its own project. `dryscope` is the `test` project. DryScope's live project is created before S8; live has no resources yet, so nothing moves.
Consequences: App Check enforcement, Model Armor floor settings, sign-in settings, spend caps and quotas can be tried on test first (TC-13). Until the live project exists they apply to `dryscope` as a whole, and the owner approves each such change.

### D-019: Live voice resumes after a dropped connection, so voice is not zero-retention (Nov 12, 2026, G2)

Status: accepted (owner, Nov 12, 2026).
Decision: the Live relay turns session resumption on (transparent mode, with buffer and replay), because technicians walk losses on cellular and a short drop must not end the walk.
Consequences: Google's documentation says session resumption "is achieved by storing cached data, including text, video, audio prompts, and model outputs", kept up to 24 hours, with project-level privacy, and that zero data retention needs resumption left off (`documents/docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention`; `documents/docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session`). So voice is not zero-retention. `docs/AI.md`, `docs/DATA.md` and the customer terms must say so when S7 ships it. The other AI features keep their own zero-data-retention checklist (`docs/AI.md`).

### D-020: A monthly Agent Platform spend cap on each project with AI (Nov 12, 2026, G3)

Status: accepted (owner, Nov 12, 2026).
Decision: each project that uses AI gets a monthly Agent Platform spend cap, set above the sum of the companies' AI budgets so the app's own ceilings act first. When the cap triggers, the app keeps working with AI off. Never cap Cloud Run on live.
Consequences: it is a backstop against a runaway loop that alerts cannot stop. Terraform work, owner-applied: `docs/plans/TC.md`.

### D-021: Cloud Deploy first, then App Lifecycle Manager as the long-term release platform (Nov 12, 2026, G4)

Status: accepted (owner, Nov 12, 2026). Differs from the review's recommendation, which was to drop App Lifecycle Manager.
Decision: the future release path stays as the Standard approved it: GitHub Actions now, then Cloud Deploy (canary and one-click rollback), then App Lifecycle Manager as the long-term release platform. Nothing changes before S8; releases still go through `.github/workflows/web-release.yml`.

### D-022: A lost second step is recovered by the platform operator, with no backup codes (Nov 12, 2026, G5)

Status: accepted (owner, Nov 12, 2026). Confirms S3 decision D9 (`docs/plans/S3.md`).
Decision: a spare authenticator is encouraged at setup; an owner's lost second step is reset by the platform operator after an identity check, logged, with the owner emailed and enrolling again; the operator's own reset is an owner-run command. One-time backup codes are not built.

### D-023: Deleted data leaves backups within 35 days (Nov 12, 2026, G6)

Status: accepted (owner, Nov 12, 2026).
Decision: the Standard's 35 days is made true, not reworded. On evidence buckets: a noncurrent-version lifecycle rule of 28 days plus 7 days of soft delete. Cloud SQL keeps at most 30 backups. Firestore backups are kept 14 days (Firestore allows up to 14 weeks: `documents/firebase.google.com/docs/firestore/backups`). No personal data goes to logs.
Basis: Google's own suggested setup is Object Versioning and soft delete on the same bucket, with Object Lifecycle Management deleting noncurrent versions after a number of days (`documents/docs.cloud.google.com/storage/docs/object-versioning`). DryScope never overwrites evidence (uploads use `ifGenerationMatch=0` and the app role cannot delete), so old versions arise only from deliberate deletion.
Consequences: small Terraform change in the data root, High risk, owner-applied, together with the missing Firestore backup schedule (`docs/plans/TC.md`). `docs/DATA.md` records the window as planned until it is applied.

### D-024: GitHub keyless sign-in trusts the numeric repository id only (Nov 12, 2026, G7)

Status: accepted (owner, Nov 12, 2026).
Decision: DryScope keeps service-account impersonation for now, and its deploy principal is restricted to the numeric `repository_id`; the repository-name form is dropped. The starter template uses direct resource access for new projects. Terraform validation change, High risk, owner-applied (`docs/plans/TC.md`).

### D-025: Offline capture on iPhone needs the installed Home Screen app (Nov 12, 2026, G8)

Status: accepted (owner, Nov 12, 2026).
Decision: on iPhone, field screens in a Safari tab work online only and say why; offline capture needs the app installed to the Home Screen. The app also asks for persistent storage at the first save. Reason: Safari clears site data after seven days without use, which would make "drafts are on the phone" untrue for occasional users. The screens are S6 (`docs/plans/S6.md`).

### D-026: Text AI is processed in the regional endpoint (Nov 12, 2026, G9)

Status: superseded by D-027 the same day (owner, Nov 12, 2026). Kept as recorded.
Decision at the time: text AI calls are processed in `us-central1` only, with the US multi-region considered after quota errors are measured at staff scale. Voice stays regional in every case.

### D-027: Text AI uses the US multi-region endpoint where no regional model is served (Nov 12, 2026, S7 V4)

Status: accepted (owner, Nov 12, 2026). Supersedes D-026.
Decision: no current GA Gemini Flash model is served from `us-central1`, so text AI runs on the `us` multi-region endpoint: processing stays in the US multi-region and the durable cache stays in `us`. Live stays on `us-central1`. Technology Standard 2.9 says regional where the model is served, else the US multi-region. Detail: `docs/plans/S7.md` (decision V4).

### D-028: Agents are decided at S7; the default is Cloud Run (Nov 12, 2026, G10, S7 V10)

Status: accepted (owner, Nov 12, 2026).
Decision: no agent is built in S7. The first agent will be ADK TypeScript 2.x on Cloud Run, with its own service and account, fixed actions, an audit log, human approval, and Model Armor on its model calls. Agent Gateway and Agent Identity are not relied on, because they need the Google Cloud organization, which does not exist yet. A2UI is not adopted until an agent answers with screens and the A2UI React renderer is at 1.0 or later and supports spec 1.0. Trigger reworded 2026-11-13 (owner): React renderer at 1.0 or later supporting spec 1.0. Detail: `docs/plans/S7.md` (decision V10).

### D-029: Pipeline reviewer is ChatGPT (GPT-6 Astra); builder family rule amended by Standard 2.11 (Nov 13, 2026, Standard 2.10)

Status: accepted (owner, Nov 13, 2026, choice "A"). Supersedes D-015.
Decision: the pipeline review agent is ChatGPT (GPT-6 Astra), with no Grok or Gemini fallback. Builders are Claude only, so the reviewer is always a different model family from the builder. Technology Standard 2.10 records the same change; the Standard is now at 2.10.
Update 2026-11-14 (owner): the reviewer is now ChatGPT GPT-6.1 Sol, replacing GPT-6 Astra, to conserve tokens; OpenAI lists it as near-Astra performance at a lower cost. Builders stay Claude only, so the reviewer is still a different model family. The rest of this decision is unchanged.
Update 2026-11-19 (owner approved Nov 14, 2026; Technology Standard 2.11): builders are no longer Claude only. The builder's model family is chosen by which family has the most allowance left, and the pipeline reviewer is always the other family, never the builder's own. The rule that the reviewer is a different family from the builder is unchanged.

### D-030: Stronger company sign-in after the sign-in security review (Nov 14, 2026)

Status: accepted (owner, Nov 14, 2026, "all recommended"). Changes S3 decisions D2 and D7 (`docs/plans/S3.md`, section 5).
Context: the sign-in and company-separation security review of Nov 14, 2026 found company sign-in tenants made with no password rule (F1), email enumeration protection not set by the tenant command (F2), and the operator's 15-minute fresh sign-in covering team changes only (F8).
Decision:
1. Company and operator sign-in tenants enforce a password rule of at least 12 characters; a shorter password set before the rule must be changed at the next sign-in. Office users, who see every job of the company, need the authenticator-app second step too (D2 now: owners, office and the platform operator must use it; estimators may opt in). The server refuses an office user without it, as it does an owner, and the sign-in and invitation screens lead them through setting it up.
2. Email enumeration protection is on for every tenant. The tenant command (`npm run platform:create-tenant`) sets both settings on a new tenant; the owner-run `npm run platform:secure-tenants` brings existing tenants up to them (read-only unless `--apply`).
3. The operator's sign-in must be under 15 minutes old (D7) for company status, tenant binding, feature switches and AI limits as well as team and second-step changes. Reads and creating a new company keep the 12-hour sign-in.
Consequences: an office user with no authenticator app is asked to set one up at their next sign-in, and an office invitation is accepted only after it is set up. Existing tenants keep their old settings until the owner runs the update command.

### Owner decisions of Nov 14, 2026: D-031 to D-035

The owner approved these on Nov 14, 2026. The pull requests named below carried them out; the decisions are recorded here in one batch.

### D-031: The three TC-9 grants stay without IAM conditions (Nov 14, 2026, option A)

Status: accepted (owner, Nov 14, 2026, option A).
Context: the TC plan asked for every new TC-9 grant to name one account and one condition. Three grants cannot usefully carry one.
Decision: these three grants each name one account and carry no IAM condition: `roles/telemetry.tracesWriter` for `dryscope-api-<env>` (Telemetry and Cloud Trace do not report a resource that a condition can scope, so a condition would silently drop every span); `roles/logging.logWriter` for `dryscope-deploy-test`, test only (a log entry has no IAM resource of its own); and `roles/secretmanager.secretAccessor` for `dryscope-synthetic-test`, granted on the one secret `dryscope-test-synthetic-password` itself.
Consequences: the plan check (`infra/dryscope/scripts/check-plan-tc.js`) holds exactly these three grants with no condition. Built in PR #383; recorded in `docs/plans/TC.md` (section 13) and `infra/dryscope/README.md` ("Accepted risks"). The owner applies the Terraform.

### D-032: The browser tests run as parallel shards (Nov 14, 2026)

Status: accepted (owner, Nov 14, 2026).
Context: the CI browser test job took 19 to 20 minutes under server load and was cancelled at its 20-minute limit with no verdict.
Decision: the `e2e` job in `.github/workflows/web.yml` is split into two Playwright shards that run in parallel, with the time limit unchanged.
Consequences: built in PR #384. Raised later to four shards with two workers each in PR #420 (Nov 17, 2026). Local runs stay unsharded.

### D-033: The old app's CI checks are removed; the old app is retired in S8 (Nov 14, 2026, option A)

Status: accepted (owner, Nov 14, 2026, option A).
Decision: the old app's Python dependency audit and Python CodeQL check are removed, and its Deploy workflow runs by hand only. The npm audit and every required check name stay. The old app's files stay in the repository until S8 retires and removes them (S8-23 in `docs/plans/S8.md`).
Consequences: built in PR #395; `docs/runbook/ci.md` ("Legacy CI retired").

### D-034: Fixed browser security headers now; the full content security policy later (Nov 14, 2026)

Status: accepted (owner, Nov 14, 2026, "all recommended" on the sign-in and company-separation security review, finding F7).
Decision: every page and API answer now carries fixed security headers: a framing ban, `nosniff`, a referrer policy, HTTPS-only and a small enforced content security policy. The one exception is the photo-item path (`/api/jobs/{jobId}/photos/{photoId}`), which takes the headers but not the small policy; a successful image read sets its own stricter `default-src 'none'; sandbox` policy, while upload receipts and JSON errors on that path carry none. A full script and connect content security policy comes later: first in report-only mode, enforced only after its reports show it blocks nothing the app needs, after the owner's phone check on the test copy (`docs/security-csp.md`) and a separate owner approval; clean reports alone are not enough.
Consequences: fixed headers built in PR #385; the full policy in report-only mode built in PR #403 (`docs/security-csp.md`). Nothing enforces the full policy yet; the phone check is still pending.

### D-035: Offline retention redesigned as one routine (Nov 14, 2026, option 1)

Status: accepted (owner, Nov 14, 2026, option 1).
Context: three review rounds of the S6-3 follow-up each found another sign-in-again path that skipped the retention cleanup of offline work.
Decision: offline retention is redesigned from scratch as one central routine with a small explicit state machine for refusal and retention, instead of patching each path. Every entry point calls it.
Consequences: built in PR #388 (`web/src/lib/field/retention.ts`), with a property-based test over random sequences of sign-outs, refusals, storage failures and day changes.

### Departures recorded after the standards audit of Nov 19, 2026: D-036 to D-039

The build-practice audit against the Technology Standard (Nov 19, 2026) found four departures that were decided or known but not written here, as the Standard's "Exceptions" rule asks. The owner answered its decisions on Nov 19, 2026 ("1a 2a 3a 4a"); D-036 and D-037 carry answers 3a and 4a, and D-038 and D-039 record earlier owner decisions and a known gap. Each stays until the condition named in its own entry is met or the owner changes it.

### D-036: Terraform plan and apply stay hand-run by the owner until the organization exists (Nov 19, 2026, option 3a)

Status: accepted (owner, Nov 19, 2026, option 3a). A recorded exception to the Standard's Core release path.
Context: the Standard says "Terraform: the plan is shown on the pull request; the owner approves; a manual workflow applies it". DryScope has neither: the owner runs plan and apply by hand ("an agent never runs plan or apply against the project", `docs/runbook/terraform-apply.md:3`, step 1). No workflow plans or applies Terraform. Since owner decision 3a the required `node` job runs the offline `infra/dryscope/scripts/check.sh` (format, validate, mocked `terraform test`, the plan check, the destroy guards and the fresh-plan comparison with the committed fixtures); the job and its limit are in `docs/runbook/ci.md` (the `node` (Terraform) row).
Options: (a) record the hand-run plan and apply as an exception until the organization exists, and run the offline `check.sh` in CI as a separate change; (b) also build a plan on each pull request now with a read-only keyless identity (large; adds a cloud identity).
Decision: (a). The owner keeps running plan and apply by hand, with the plan check, until the Google Cloud organization exists. Running the offline `check.sh` in CI is a separate pull request (it needs a workflow change and the owner's approval) and does not end this exception.
Consequences: CI now runs the offline `check.sh`, so a pull request that changes a `.tf` file without regenerating the fixture plans fails, for both roots; the comparison covers only each root's first mocked plan and not outputs (`docs/runbook/ci.md`). The check that covers an apply is the one the runbook requires on the saved real plan before each apply (`docs/runbook/terraform-apply.md`, steps 3 onward), not the fixture comparison. Plan-on-pull-request and the manual apply workflow are reconsidered when the organization exists.

### D-037: CodeQL uses GitHub's default setup instead of a workflow (Nov 18, 2026; kept Nov 19, 2026, option 4a; amended Nov 19, 2026)

Status: accepted (owner, Nov 18, 2026, to save runner minutes; kept on Nov 19, 2026, option 4a; amended on Nov 19, 2026, when the owner approved recommendation 2 of the repository settings review after the repository became public).
Context: the CodeQL workflow (`.github/workflows/codeql.yml`, now removed) ran on pushes to `master` and every Monday at 09:23 UTC, not on `pull_request`, to save about 6.3 runner-minutes per push on the self-hosted pool, and uploaded nothing, so findings appeared only in the job summary after the merge. The repository is now public, so GitHub Actions minutes on GitHub-hosted runners are free, and the owner turned on code scanning default setup, which reported 16 open alerts. Default setup scans on each push to the default branch or a protected branch, on pull requests against them (not from forks), and weekly, and it disables an existing advanced-setup workflow (https://docs.github.com/en/code-security/concepts/code-scanning/setup-types and https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning).
Options: (a) keep the push-only workflow; (b) enable code scanning and upload the results, and also scan pull requests; (c) run CodeQL on pull requests that touch `web/` only.
Decision: originally (a). Amended on Nov 19, 2026: code scanning uses GitHub's default setup, replacing the push-only workflow, because Actions minutes are free on the public repository. `.github/workflows/codeql.yml` is removed. Default setup is a repository setting the owner holds; it is not a required check.
Consequences: a CodeQL finding on a qualifying pull request (against `master` or another protected branch, from the same repository) shows on the pull request and under Security > Code scanning, not only after the merge; a push to an unprotected branch alone is not scanned (its pull request into `master` is), fork pull requests are not scanned before they land on a protected branch, and the weekly scan needs a qualifying push or pull request scan in the past 180 days. Default setup runs on GitHub's runners, not the self-hosted pool. Triaging the open alerts is separate work.

### D-038: The pipeline runs no unattended review-fix rounds (Nov 17, 2026)

Status: accepted (owner, Nov 17, 2026). A recorded exception to the Standard's validation gate, which allows "auto-fix limited to two rounds".
Context: `.no-mistakes.yaml` sets `auto_fix: review: 0` (`.no-mistakes.yaml:41-42`; `docs/runbook/ci.md`, the `.no-mistakes.yaml` paragraph).
Decision: zero unattended review-fix rounds. A review finding is not fixed automatically on its own; it waits for a selection by a person (or the supervising agent), who may direct a fix round or send it to the worker as an ordinary commit.
Consequences: no review fix lands without a selection, but a selected fix round can still produce a pipeline-authored commit, so the author of a review fix is not always the worker; protected paths still guard every automatic commit. The three-round cap on review fix rounds per pull request is unchanged.

### D-039: The release smoke check is thinner than the Standard until it covers the deployed checks (Nov 19, 2026)

Status: accepted (recorded at the owner's direction, Nov 19, 2026). A tracked, dated exception to the Standard's Core release path.
Context: the Standard asks for smoke tests on the test copy after every release: "site loads, sign-in works, a fake record is created and submitted, a file uploads, an AI feature answers within its limit." `web/scripts/smoke-release.ts:1-14` checks health (commit, version, database) and that signed-out probes are refused. The gap is already noted in `docs/plans/TC.md:20`.
Decision: the release keeps the current smoke check until the release smoke check itself covers the deployed checks: sign-in, creating and submitting a fake record, a file upload and, once an AI feature is switched on, an answer within its limit.
Consequences: until then a release can pass with sign-in, record saving, uploads or AI broken on the test copy; the browser tests (Playwright) run on pull requests that change `web/`, `live-relay-placeholder/` or `.github/workflows/web.yml` and skip their suite on other pull requests (`.github/workflows/web.yml:226-236`, `:269-270`); they exercise the app flows locally and against a local build, not the deployed copy, and do not check that an AI feature answers within its limit. Deployed sign-in, record submission, upload and a real AI answer stay open: the real-model checks run only from the separate manual `.github/workflows/ai-evals.yml:3-11`. This exception ends when the release smoke check covers those deployed checks. Live keeps read-only checks only (S8-17).
