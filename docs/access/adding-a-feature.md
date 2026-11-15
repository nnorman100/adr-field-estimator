# Access matrix: Rules for adding a feature

Part of [Access matrix](../ACCESS.md).

## Rules for adding a feature

- Add a capability key to `CAPABILITIES` in `backend/workspaces.py`, check it on the server route, mirror it in `can()` in `public/workspaces.js` and in `web/src/lib/access/roles.ts`, and add a row to the table above. Test owner, estimator, office, superadmin support, and a different company's user.
- Refuse before reading when the caller lacks the role, so refusals cannot probe other companies.
- Add the route's row to `web/tests/db/isolation-matrix.ts` (the isolation gate fails without it) and give any new table a case in the SQL part of the suite if it is not found from the catalog.
- Audit anything superadmins do.
