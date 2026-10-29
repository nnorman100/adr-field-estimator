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

### D-006: Single production project, no separate dev project [confirm]
Status: open. Releases are staged at 0% traffic on production instead. Decide whether a dev project is worth the cost, especially before other companies subscribe.

### D-007: Transactional email service before other companies send at volume
Status: open. Gmail SMTP from a personal account is capped near 500/day. Needs the owner's decision.

### D-008: Relationship to the multi-tenant restoration platform repo
Status: **open — owner decision.** Options: (a) stay standalone and sell DryScope separately; (b) fold into the platform later as a module; (c) rebuild on the platform. Billing for other companies does not exist here yet.
