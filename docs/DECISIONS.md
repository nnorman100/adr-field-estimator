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

### D-007: Switch email to Resend before a second company subscribes (Oct 28, 2026)

Status: accepted (owner). Gmail stays for ADR until then. Background: production uses Gmail SMTP (`INVITATION_TRANSPORT=smtp`) from a personal account, capped near 500/day. The code already supports the Resend email service (`INVITATION_TRANSPORT=resend`, the default, with `RESEND_API_KEY` and `INVITATION_FROM`; see `mail_settings` in `backend/workspaces.py`). What remains is the owner's decision, a sending domain, the secret, and a release. Note the name clash: the in-app **Resend** button re-sends documents and is unrelated to the Resend service.

### D-008: DryScope stays a standalone product for now (Oct 28, 2026)

Status: accepted (owner). Options considered: stay standalone; fold into the platform later; rebuild on the platform. Keep shipping in this repo; revisit once DryScope has paying companies. Billing for other companies does not exist here yet.

### D-009: Agents ask before merging any PR (Oct 28, 2026)

Status: accepted (owner). Overrides the roadmap's earlier rule that agents may merge Low/Medium risk PRs with green CI. Enforced by the `gh pr merge` approval rule in `.claude/settings.json`.

Superseded (Nov 6, 2026, owner, per the rebuild plan's settled "test-to-live deployment and ordinary automatic reviewed merges"): pull requests merge automatically once every check passes and the review is done, with two separate independent reviews on top of the pipeline review, from models that did not write the code for high-risk work; deploys run to test first, then live. Still owner-only: anything that deletes data, cannot be undone, or changes security or permissions (IAM, secrets, Firebase Auth settings); turning on deletion or new pricing; and production steps the owner runs.

### D-010: No default prices; ADR's rates are ADR's alone (Nov 2, 2026)

Status: accepted (owner). ADR's estimating sheet is proprietary to ADR, so it is not a product default. A company without published prices is blocked from pricing with a clear message. ADR's rates are kept as ADR's data and used only for company `adr`, and no rate ships in browser code. Later steps of the owner-pricing plan add owner-defined tables; formulas and `CALCULATION_VERSION` are unchanged here.

### D-011: Owner-defined pricing tables; ADR stays on v1 until the owner switches (Nov 3, 2026)

Status: accepted (owner). Every company prices from its own table of items and estimate settings (`dryscope-v2`). A new company starts from the blank starter list; no company but ADR ever sees ADR's rates. A company already on a rate book, ADR included, stays on `adr-residential-v1` until its owner chooses **Switch to v2**, reviews the mapped table and publishes it. There is no way back after publishing. A draft begun before the switch keeps its rate book until the owner applies the new table to that one draft, and signed documents never change. The switch names its three differences for the same job: the high end tapers above 1,000 sq ft instead of stepping, labor hours carry 50% at every size, and the after-hours 20% prints as a line inside the itemized total. `PRICE_BOOKS_ENABLED` is the only flag; turning it on in production is a separate release with the owner's word.
