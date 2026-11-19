# Status: S3 identity, sign-in and company separation

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

The server side of S3 up to S3-12 is in [S2 TypeScript app skeleton](s2-typescript-skeleton.md). Nothing here is deployed to production: no live project exists yet (D-018).

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Platform operator API and owner-run tenant and operator commands (S3-9) | yes (#314) | no (rebuild not live) | no | Routes under `/api/platform/`; `npm run platform:add-operator` and `platform:create-tenant` |
| Operator route to change a company's feature flag (S3-11b) | yes (#329) | no (rebuild not live) | no | Refuses unknown flag names; one audit row per change |
| Company sign-in page found from the database (S3-13b) | yes (#323) | no (rebuild not live) | no | Migration `0007_sign_in_address` |
| Second-step screens: authenticator-app setup and sign-in (S3-14) | yes (#321, #413) | no (rebuild not live) | no | One status message at a time on the setup screen (#413) |
| Platform operator screens (S3-15) | yes (#325) | no (rebuild not live) | no | Companies, company administration and a read-only team support view |
| Team and invitation screens for the owner (S3-16) | yes (#326) | no (rebuild not live) | no | Includes the Accept invitation screen |
| Company-isolation gate (S3-17) | yes (#337, #342, #406) | n/a | n/a | `npm run test:isolation`, a required CI job; calls every exported route handler with the other company's ids; S5a records added in #406 |
| Stronger company sign-in (D-030) | yes (#382) | no (rebuild not live) | no | 12-character passwords, office second step, operator 15-minute fresh sign-in, `npm run platform:secure-tenants` (owner-run) |
| Sign-in reCAPTCHA in audit mode (TC-6) | yes (#389) | no (rebuild not live) | no | New tenants get audit mode; `npm run platform:recaptcha` for existing ones (owner-run) |
| Sign-in kept across `user.reload` when refusing second-step sessions | yes (#399) | no (rebuild not live) | no | |
| SECURITY DEFINER functions search the temporary schema last (security F4) | yes (#461) | no (rebuild not live) | n/a | Migration `0017_definer_search_path` |
| Sign-in review go-live gates G6a to G6c | plan only (#462) | n/a | n/a | Live takes no real company until all three are met (`docs/plans/S8/2026-11-19-sign-in-review-go-live-gates.md`) |
