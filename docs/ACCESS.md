# Access matrix

Summary of who may do what. **Source of truth in code:** the `CAPABILITIES` dictionary in `backend/workspaces.py`, enforced by `job_access` and the route checks. Some routes test the caller's *role* (owner) instead of a capability key; those are listed under "Checks by role" below. `can()` in `public/workspaces.js` only hides buttons. Prose detail: `docs/company-workspaces.md`. If this file and the code disagree, the code wins; fix this file in the same PR. The rebuilt app's TypeScript port of this table is `web/src/lib/access/`; `web/tests/unit/access.test.ts` reads the table below and fails when the port differs from it, so change both in the same PR.

## Principles
1. Identity = verified Firebase ID token (Google or password sign-in, email verified). Public sign-up stays **disabled**.
2. Authorization = private Firestore membership and job-access records. Never custom claims or anything from the browser. (Exception: the `password_change_required` claim only *denies*.)
3. Browsers never reach Firestore (`firestore.rules` is deny-all; a test enforces it). Server SDK access is controlled by IAM, not rules.
4. Every business endpoint checks identity, company membership and job access on every call, including evidence downloads and Live reconnects. An estimator also needs to be on the job's `accessible_estimator_uids` (created it or assigned); a job outside their company or list answers 404, and an archived job answers 410.
   With `WORKSPACES_ENABLED` off (a rollback mode) there are no capabilities: access is the `STAFF_EMAILS` allowlist plus `owner_uid == uid`.
5. One active owner and one company membership per user.
6. Superadmin support access is read-only plus listed support actions, always audited, and is not a membership.

## Company roles (from `CAPABILITIES` in `backend/workspaces.py`, Oct 28, 2026)
| Capability key | What it allows | Owner | Estimator | Office |
|---|---|---|---|---|
| `jobs_read` | See jobs (estimator: only jobs they created or are assigned) | yes | yes | yes |
| `jobs_create` | Start a job (office: empty scope only) | yes | yes | yes |
| `jobs_copy` | Copy a signed job to a new draft | yes | yes | yes |
| `coordination` | Job coordination and claim/loss details; record a signed job's close (final invoiced amount, actual drying days); drying-watch state changes and reminders; the full coordination view (others get the customer view) | yes | no | yes |
| `assignment` | Assign estimators to jobs | yes | no | yes |
| `scope` | Edit rooms, measurements, scope; accept suggested equipment counts; edit the customer; add and remove drying readings; voice notes; scope suggestions; additional-work quotes; reprice (owner); edit claim details (with `coordination`, either key suffices); an estimator marking a drying job dry | yes | yes | no |
| `places` | Address suggestions and job map | yes | yes | no |
| `photos` | Add photos, move or tag them, and send a photo's full-size original later. Adding a photo to a signed job is refused; the original of a photo already on the job may arrive after signing and changes nothing in the record | yes | yes | no |
| `ocr` | Meter-photo recognition | yes | yes | no |
| `audit` | Finish & review (generate documents) | yes | yes | no |
| `sign` | Capture signature / send signing link | yes | yes | no |
| `live` | Live walkthrough | yes | yes | no |
| `jobs_archive` | Archive and restore unsigned drafts | yes | no | no |
| `team_manage` | Team and invitations (the server uses this key only to choose the full team list; invitations and member changes require the owner role) | yes | no | no |
| `profile_manage` | Company profile and logo (browser key only: the server allows `PUT /api/companies/{id}` to the company's owner role, not by this key) | yes | no | no |
| `delivery_manage` | Company delivery settings | yes | no | no |
| `delivery_resend` | Resend signed documents | yes | no | yes |
| `retention_manage` | Read and change how many days each kind of record is kept (invitations, activity log, drying-watch history, photos on archived drafts); see `docs/company-workspaces.md`, Record retention. Any active member's app may start the company's daily deletion run, which honours only the owner's setting and returns counts | yes | no | no |
| `quantity_notes_read` | Receive the printed quantity-override note with a job's documents (the API omits the note for everyone else, including superadmin support and all links). The entered overrides stay in the job's data for roles with job access; superadmin support and all links do not receive them either | yes | no | no |
| `prices_read` | See company price books, enabled items (including in version diffs) and settings (only when `PRICE_BOOKS_ENABLED`; added in `_capabilities`) | yes | yes | yes |
| `prices_manage` | Edit company price books, items and settings, including the owner-only working copy; start the switch from a rate book to a price table; export disabled items; read the estimate-accuracy statistics and apply a suggested setting to the working copy (only when `PRICE_BOOKS_ENABLED`) | yes | no | no |

Office can read only active estimators' uid/email from the team, for assignment.

## Checks by role (no capability key)
These routes test the owner role directly, so a new role would not gain them from a key:
- Approve additional work (`/extras/{id}/approve`), read company AI usage, read this month's company AI spending (`GET /api/companies/{id}/ai-spending`; other companies, estimators, office and superadmin support are refused), restore a price version, preview a reprice, read price version detail and history events, list pending signing links of a member, clear invitations, and all member and invitation changes.
- Company drying-watch list: owner or office only (estimators use "My drying jobs").
- `POST /api/companies/{id}/prices/import-preview` is checked with `prices_read`, so any role that can read prices can run an import preview; saving or publishing still needs `prices_manage`. This looks like a gap and is recorded here, not changed.
- `POST /api/qr-tags` needs a signed-in member but no capability and no job.

## Feature switches that gate routes
`AI_FEATURES` names: `priced_extras`, `job_summary`, `ai_usage`, `drying_watch`, `estimate_assist`, `readiness`. A switched-off feature's routes answer 404. `PRICE_BOOKS_ENABLED` decides whether `prices_read` and `prices_manage` exist at all; with it off every price route answers 404.

## Superadmin
Not a company role and not a membership. Can create/suspend/reactivate companies and invite or replace owners (or create an owner login with a temporary password). Read-only, audited support access to any company's profile, jobs, documents, photos, evidence, team, invitations, price books, job summaries, AI usage and drying watch, plus listed support actions: resend or cancel a staff invitation, switch a non-owner between estimator and office, re-enable a disabled member, archive or restore an unsigned draft (also in a suspended company). Never edits customer jobs.

In the rebuilt app (`web/`, S3-9) this is the platform operator: an actor with no company in the operator-only sign-in tenant, added only by the owner-run `npm run platform:add-operator` (no API adds one), signing in with an authenticator app every time and again after 12 hours. The screens are at `/operator/{operator tenant id}` (S3-15) and call only those routes. Every route under `/api/platform/` is an `operatorRoute`; an owner, estimator or office user gets 403 `not_an_operator` there. The operator lists and creates companies, suspends, reactivates and archives them (archive needs suspended), binds a company to its sign-in tenant once, invites or replaces the owner by link (replacing disables the old owner and revokes their sessions), resets a member's second step after a phone check (logged; no email until S9, so the operator tells them by phone), turns one of the known feature flags on or off for a company (the only way a flag changes; no company role can, an owner included), reads a company's team read-only, and takes the support actions above on the team (resend or cancel an invitation, switch estimator and office, re-enable a member; a company with no active owner keeps its pending owner invitation). Each action writes one audit row naming the operator; the team view writes one per view; a refused action writes none. There is no temporary-password owner login (D11).

## Non-role access
- **Anonymous**: `GET /health` and `GET /api/health` (status, schema version, release version, source commit). `GET /api/health/details` needs a signed-in member. In the rebuilt app (`web/`), also `GET /api/sign-in/{address}`: a company's name and sign-in tenant for its sign-in page, both public; an unknown, inactive, tenant-less or malformed address answers 404.
- **Homeowner signing link** (`/api/sign*`): single-use token, expires in 7 days, stops working on any edit; acts as the technician who sent it and needs that technician to still hold `sign`. After signing, the used link can still view the documents for 30 days. Limits: 120 requests a minute per client address across link routes and 10 signing attempts per link.
- **Document link** (`/documents`): read-only, bound to one signed agreement and one document set, expires in 30 days, revocable, multi-view; the technician who created it must still hold `sign`.
- **Server-only**: Cloud Run runtime service account `adr-runtime@…`; background jobs (vault backup, monitoring).

## Jobs routes (rebuilt app, S5a-3)
`web/src/lib/jobs/`, five handlers under `/api/jobs`, all `memberRoute`; the company is the caller's own from the sign-in and no path, query or body names one. No new capability key: each route uses keys the table above already has.

| Route | Who | Rule |
|---|---|---|
| `POST /api/jobs` | `jobs_create` | The phone sends the job id and the first draft id. The job row is written first, then its Firestore field draft; sent again, it makes whichever of the two is missing (201 the first time, 200 after). The same id with another body, or a draft id another job holds, is 409. The creator owns the field work when they hold `scope`; an office user's job has no field owner until S5b-1. |
| `GET /api/jobs` | `jobs_read` | `scope=company` (owner and office; their default) or `scope=mine` (the jobs the caller made or owns in the field); an estimator gets only `mine` and `scope=company` is 403. Newest first, `limit` 1 to 50, `cursor` for the next page; archived jobs are left out. |
| `GET /api/jobs/{id}` | `jobs_read` | The job with its customer and claim. |
| `PUT /api/jobs/{id}/customer` | `scope` or `coordination` | Customer name, phone, email and the property address (owner decision J3: the estimator who owns the field work, the owner and office, while the job is unsigned; the estimator's `scope`, office's `coordination`). |
| `PUT /api/jobs/{id}/claim` | `scope` or `coordination` | The claim fields the documents print; either key suffices, as in the table above. |

Every job route goes through one job-access function (`web/src/lib/jobs/access.ts`), in this order: the job is in the caller's company (otherwise 404), an estimator's own job (created it or owns its field work; any other estimator's job is 404, the same answer as no such job), archived (410), then the capability (403). S5b-1 adds the jobs an estimator is assigned. A signed job's customer and claim are refused (409 `job_signed`); after signing only office and the owner correct them (S5b-4).

The two saves carry the `revision` the phone last saw and a `changeId` it made for this change. A save whose revision is not the job's current one is 409 `stale_revision` (the answer says the current revision). The same `changeId` again with the same values is the same change: the answer is the saved job, with no second revision and no second audit row, so a lost response never turns into a conflict; the same `changeId` with other values is 409. Every write adds one audit row with the job id and revision only.

## Company isolation gate
The standard's required test, one named suite (S3-17), run by `npm run test:isolation` in `web/` and by the `company-isolation` job of `.github/workflows/web.yml`, which `Web app / check` requires. It seeds two companies in two sign-in tenants, then as each company's owner, estimator and office user calls every route with the other company's ids:
- **Routes** (`web/tests/db/company-isolation.test.ts`): no sign-in answers 401; the other company's people are refused (401, 403 or 404) on every route in the matrix but four open answers the suite lists (`/api/me`, the sign-in page, health and echo) with no id, email, address or tenant of the company in the body, and the database, the sign-in tenant calls and the access projection are unchanged. Also the caller's own company with the other's record ids (an invitation, member or job of the other company), the caller's own team and job lists (no row of the other company), a job create that carries the other company's job and draft ids (it makes only the caller's own job and draft, and the other company's rows are unchanged), `/api/me` with the other company named in the query or a header, the scheduler's route (no person's token passes), and an invitation addressed to an email that exists in both companies. Each open answer is held to what its comment says is public: `/api/me` names the caller's own company, `GET /api/sign-in/{address}` answers a company's name and sign-in tenant and nothing else, and a new open route fails until its answer is listed.
- **The route list** (`web/tests/db/isolation-matrix.ts`): the suite finds and imports every `route.ts` under `web/src/app` and fails when an exported handler has no row in the matrix or a row names a handler that no longer exists; every row is then called as above. Each row's kind (company, invitation, operator, service, session, public) records the decision for review. Adding a route means adding its row, which a reviewer reads.
- **SQL as the runtime role** (same file): every table in the `public` schema, found from the catalog, read inside each company's context shows no trace of the other company, with no company set it shows nothing, and inserts, updates and deletes aimed at the other company's rows are refused or change no row.
- **The operator**: a support view of a company's team writes one `support_team_viewed` audit row naming the operator and that company; the other company never sees it.
- **Firestore rules** (`web/tests/emu/rules/company-isolation.test.ts`, emulator): every user of one company is refused every read, list, write, delete and mixed batch on the other's company, access records, drafts, rooms and photos; so are a sign-in with no tenant, no sign-in, a same-uid account of another tenant and an access record written for the wrong company's person.
- **Smoke check for `test`** (`web/scripts/smoke-isolation.ts`, read-only, fake data only): with the sign-ins of two test companies, one company's token and the other's ids are refused on the team, operator and invitation routes, and each token's `/api/me` names its own company. It sends no token to a service whose health does not say `test`. The owner runs it with real test sign-ins in S3-18; no workflow has those sign-ins, so none runs it.

## Rules for adding a feature
- Add a capability key to `CAPABILITIES` in `backend/workspaces.py`, check it on the server route, mirror it in `can()` in `public/workspaces.js` and in `web/src/lib/access/roles.ts`, and add a row to the table above. Test owner, estimator, office, superadmin support, and a different company's user.
- Refuse before reading when the caller lacks the role, so refusals cannot probe other companies.
- Add the route's row to `web/tests/db/isolation-matrix.ts` (the isolation gate fails without it) and give any new table a case in the SQL part of the suite if it is not found from the catalog.
- Audit anything superadmins do.
