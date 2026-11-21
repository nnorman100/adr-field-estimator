# Access matrix: Checks by role and feature switches

Part of [Access matrix](../ACCESS.md).

## Checks by role (no capability key)

These routes test the owner role directly, so a new role would not gain them from a key:

- Approve additional work (`/extras/{id}/approve`), read company AI usage, read this month's company AI spending (`GET /api/companies/{id}/ai-spending`; other companies, estimators, office and superadmin support are refused), restore a price version, preview a reprice, read price version detail and history events, list pending signing links of a member, clear invitations, and all member and invitation changes.
- Company drying-watch list: owner or office only (estimators use "My drying jobs").
- `POST /api/companies/{id}/prices/import-preview` is checked with `prices_read`, so any role that can read prices can run an import preview; saving or publishing still needs `prices_manage`. This looks like a gap and is recorded here, not changed. The rebuilt app (`web/`, S4-7) does not carry the gap over: `POST /api/prices/import` needs `prices_manage`.
- `POST /api/qr-tags` needs a signed-in member but no capability and no job.

## Feature switches that gate routes

`AI_FEATURES` names: `priced_extras`, `job_summary`, `ai_usage`, `drying_watch`, `estimate_assist`, `readiness`. A switched-off feature's routes answer 404. `PRICE_BOOKS_ENABLED` decides whether `prices_read` and `prices_manage` exist at all; with it off every price route answers 404.

In the rebuilt app (`web/`) the switches are per company, rows in `company_feature_flags`, all off by default, named in `FLAG_NAMES` (`web/src/lib/flags/known.ts`): `price_books`, the six AI switches, and the deterministic feature switches (`readiness`: `GET /api/jobs/{id}/readiness`, see [Ready to review?](readiness.md); `priced_extras`: the proposal and approval routes, see [Proposals and approvals](approvals.md); `drying_watch`: `GET /api/jobs/{id}/drying-watch` and `POST /api/jobs/{id}/drying-watch/actions`, see [Drying log](drying.md); `estimate_assist`: `GET /api/jobs/{id}/outcome`, `POST /api/jobs/{id}/close` and `GET /api/estimate-accuracy`, see [Drying log](drying.md)). Only the platform operator changes one. A switched-off feature's routes answer 404.
