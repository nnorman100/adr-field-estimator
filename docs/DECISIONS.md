# Decision log

Newest at the bottom. Never delete; mark superseded. Dates come from `docs/roadmap.md`, `VISION.md`, `AGENTS.md` and `RELEASES.md`; confirm any marked [confirm].

## Template
```
### D-NNN: Title
Date · Status: accepted | superseded by D-NNN
Context · Options · Decision · Consequences
```

### D-001: Mirror the company workbook for prices (Oct 2026)
Status: accepted. Prices come from the company's estimating workbook, calculated in Decimal on the server. ADR's after-hours labor stays at the workbook formula's $47.46/hr even though the sheet lists $83.45 (owner chose to mirror the formula). A model never overrides a total.

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

### D-007: Switch email to Resend before a second company subscribes (Oct 28, 2026)
Status: accepted (owner). Gmail stays for ADR until then. Background: production uses Gmail SMTP (`INVITATION_TRANSPORT=smtp`) from a personal account, capped near 500/day. The code already supports the Resend email service (`INVITATION_TRANSPORT=resend`, the default, with `RESEND_API_KEY` and `INVITATION_FROM`; see `mail_settings` in `backend/workspaces.py`). What remains is the owner's decision, a sending domain, the secret, and a release. Note the name clash: the in-app **Resend** button re-sends documents and is unrelated to the Resend service.

### D-008: DryScope stays a standalone product for now (Oct 28, 2026)
Status: accepted (owner). Options considered: stay standalone; fold into the platform later; rebuild on the platform. Keep shipping in this repo; revisit once DryScope has paying companies. Billing for other companies does not exist here yet.

### D-009: Agents ask before merging any PR (Oct 28, 2026)
Status: accepted (owner). Overrides the roadmap's earlier rule that agents may merge Low/Medium risk PRs with green CI. Enforced by the `gh pr merge` approval rule in `.claude/settings.json`.
