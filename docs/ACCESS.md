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
| `profile_manage` | Company profile and logo (old app: browser key only, the server allows `PUT /api/companies/{id}` to the company's owner role, not by this key; rebuilt app: the server checks this key, see "Company profile API" below) | yes | no | no |
| `delivery_manage` | Company delivery settings | yes | no | no |
| `delivery_resend` | Resend signed documents | yes | no | yes |
| `retention_manage` | Read and change how many days each kind of record is kept (invitations, activity log, drying-watch history, photos on archived drafts); see `docs/company-workspaces.md`, Record retention. Any active member's app may start the company's daily deletion run, which honours only the owner's setting and returns counts | yes | no | no |
| `quantity_notes_read` | Receive the printed quantity-override note with a job's documents (the API omits the note for everyone else, including superadmin support and all links). The entered overrides stay in the job's data for roles with job access; superadmin support and all links do not receive them either | yes | no | no |
| `prices_read` | See company price books, enabled items (including in version diffs) and settings (only when `PRICE_BOOKS_ENABLED`; added in `_capabilities`). In the rebuilt app (`web/`, S4-6) the company's `price_books` flag decides, and the key allows `GET /api/prices`: the current published prices, enabled items only, without the change reason, the publisher or the working copy | yes | yes | yes |
| `prices_manage` | Edit company price books, items and settings, including the owner-only working copy; start the switch from a rate book to a price table; export disabled items; read the estimate-accuracy statistics and apply a suggested setting to the working copy (only when `PRICE_BOOKS_ENABLED`). In the rebuilt app (`web/`, S4-6): every other `/api/prices/` route, listed under "Prices API" below | yes | no | no |

Office can read only active estimators' uid/email from the team, for assignment.

## Checks by role (no capability key)
These routes test the owner role directly, so a new role would not gain them from a key:
- Approve additional work (`/extras/{id}/approve`), read company AI usage, read this month's company AI spending (`GET /api/companies/{id}/ai-spending`; other companies, estimators, office and superadmin support are refused), restore a price version, preview a reprice, read price version detail and history events, list pending signing links of a member, clear invitations, and all member and invitation changes.
- Company drying-watch list: owner or office only (estimators use "My drying jobs").
- `POST /api/companies/{id}/prices/import-preview` is checked with `prices_read`, so any role that can read prices can run an import preview; saving or publishing still needs `prices_manage`. This looks like a gap and is recorded here, not changed. The rebuilt app (`web/`, S4-7) does not carry the gap over: `POST /api/prices/import` needs `prices_manage`.
- `POST /api/qr-tags` needs a signed-in member but no capability and no job.

## Feature switches that gate routes
`AI_FEATURES` names: `priced_extras`, `job_summary`, `ai_usage`, `drying_watch`, `estimate_assist`, `readiness`. A switched-off feature's routes answer 404. `PRICE_BOOKS_ENABLED` decides whether `prices_read` and `prices_manage` exist at all; with it off every price route answers 404.

## Superadmin
Not a company role and not a membership. Can create/suspend/reactivate companies and invite or replace owners (or create an owner login with a temporary password). Read-only, audited support access to any company's profile, jobs, documents, photos, evidence, team, invitations, price books, job summaries, AI usage and drying watch, plus listed support actions: resend or cancel a staff invitation, switch a non-owner between estimator and office, re-enable a disabled member, archive or restore an unsigned draft (also in a suspended company). Never edits customer jobs.

In the rebuilt app (`web/`, S3-9) this is the platform operator: an actor with no company in the operator-only sign-in tenant, added only by the owner-run `npm run platform:add-operator` (no API adds one), signing in with an authenticator app every time and again after 12 hours. The screens are at `/operator/{operator tenant id}` (S3-15) and call only those routes. Every route under `/api/platform/` is an `operatorRoute`; an owner, estimator or office user gets 403 `not_an_operator` there. The operator lists and creates companies, suspends, reactivates and archives them (archive needs suspended), binds a company to its sign-in tenant once, invites or replaces the owner by link (replacing disables the old owner and revokes their sessions), resets a member's second step after a phone check (logged; no email until S9, so the operator tells them by phone), turns one of the known feature flags on or off for a company (the only way a flag changes; no company role can, an owner included), reads a company's team and its prices (current version, working copy and version list) read-only, and takes the support actions above on the team (resend or cancel an invitation, switch estimator and office, re-enable a member; a company with no active owner keeps its pending owner invitation). Each action writes one audit row naming the operator; the team view and the prices view write one per view; a refused action writes none. There is no temporary-password owner login (D11).

## Prices API (rebuilt app, S4-6)
Every route is `requireFlag('price_books', ...)`: a company without the flag answers 404 and nothing runs. No route takes a company id; the company is the verified sign-in's. A caller without the key is refused 403 before the body or the database is read. The new actions use the two existing keys, so the matrix above is unchanged.

| Route | Key | Writes |
|---|---|---|
| `GET /api/prices` | `prices_read`; the owner (`prices_manage`) also gets the working copy, which for a company that has not saved yet is the starter list with blank prices | nothing |
| `PUT /api/prices/working-copy` | `prices_manage` | the working copy; a stale revision answers 409; audit `price_working_copy_saved` |
| `POST /api/prices/preview` | `prices_manage` | nothing, not even an audit row |
| `POST /api/prices/publish` | `prices_manage`, and a sign-in under 15 minutes old (Q10) | a version and the working copy; audit `price_table_published`; the first publish needs the owner's range choice (Q14) |
| `GET /api/prices/versions`, `GET /api/prices/versions/{id}` | `prices_manage` | nothing |
| `POST /api/prices/versions/{id}/restore` | `prices_manage` | the working copy only; audit `price_version_restored` |
| `GET /api/prices/export` | `prices_manage` | nothing (CSV price list of the working copy) |
| `POST /api/prices/import` | `prices_manage` (an estimator or office user is refused before the file is read) | the working copy only, never a version; audit `price_working_copy_imported`, none when the file changes no price; a stale revision answers 409 |
| `GET /api/platform/companies/{companyId}/prices` | platform operator, read-only | audit `support_prices_viewed`, one per view |

A refused request writes nothing, audit row included. Audit details hold ids, sequence numbers and counts, never a price or a reason.

The import (S4-7) reads a CSV price list in the export's own columns and changes prices only: a line is matched to one price of the working copy by item, row, room type, band limit and tier, and its name, unit, trade, group and on/off columns must still match the working copy (those change in the editor). A cell starting with `=`, `+`, `-`, `@` or a tab is refused; every refusal names the line and column and never repeats the cell.

## Company profile API (rebuilt app, S5a-4)
The five lines the four documents print: address, phone, email, licence and sign-off. They live on the company's own row (migration 0010, no new migration). The company name is read-only here: the platform operator sets it when the company is made. The logo is not stored yet (decision J9: text letterhead until then). Both routes are `memberRoute`s and check, in this order: the company in the path is the caller's own (else 404, as for any other company's id), the caller holds `profile_manage` (else 403, before the body is read), and only then the body (Zod, strict: a body that names any other field, including the name or status, is a 400). An estimator or office user is refused on the read as well as the write, so nothing of the profile reaches their phone; the Company settings screen does not request it for them.

| Route | Key | Writes |
|---|---|---|
| `GET /api/companies/{id}/profile` | `profile_manage` | nothing; the answer also holds the profile's `revision` and lists what the engine's setup check says is missing (company name, address, CSLB licence, document sign-off) |
| `PUT /api/companies/{id}/profile` | `profile_manage` | the five profile columns of the company's own row, only while the `revision` the save names is still the stored one; audit `company_profile_saved` holding the actor, the change id and the number of fields changed, never a value, and none when nothing changed |

An empty line means not set. The limits are those of migration 0010's check constraints (address 500, phone 80, email 254, licence 80, sign-off 150 characters; no control characters; the email is stored in lower case). A platform operator cannot change a company's profile (the 0010 trigger), and no support action does.

Every save carries the `revision` it was based on (the company row's `updated_at`, as the read returns it; no new column) and a `changeId` made on the phone (a uuid). A save that asks for exactly what is stored answers 200 with the current revision, so a retry after a lost answer is not a conflict. Otherwise, a save whose revision is no longer the stored one writes nothing and answers 409 `stale_revision` with the current profile, and the Company settings screen shows that profile and tells the owner it was changed somewhere else.

## Non-role access
- **Anonymous**: `GET /health` and `GET /api/health` (status, schema version, release version, source commit). `GET /api/health/details` needs a signed-in member. In the rebuilt app (`web/`), also `GET /api/sign-in/{address}`: a company's name and sign-in tenant for its sign-in page, both public; an unknown, inactive, tenant-less or malformed address answers 404.
- **Anonymous, rebuilt app: `POST /api/client-errors`** (TC-2): a browser or phone sends error reports before or after anyone signs in, because the sign-in pages fail before a person exists. It is public and write-only, and has no role-matrix key because it reads no company data (no Postgres, no Firestore, no identity). Limits: the body must be JSON of at most 8 KB and at most 20 reports, each field bounded by a Zod schema (otherwise 400, 413 or 415); each Cloud Run instance writes at most 60 reports a minute and answers the excess 202, counted and not logged. It writes each report to the server log as an Error Reporting event for the service `dryscope-web-client`, built only from the error name, a message scrubbed again on the server (emails, tokens, street addresses, coordinates, phone numbers, long digit runs, URL query strings) and cut to 300 characters, stack frames of the app's own scripts scrubbed by the same rules, the route pattern (never the address), and the browser family; no body, header, address, person or company is logged. App Check is not recorded until TC-5 and never refuses (TC plan).
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

## Photo routes (rebuilt app, S5a-5)
`web/src/lib/photos/`, two handlers on one path, `/api/jobs/{id}/photos/{photoId}`, both `memberRoute` and both through the job-access function above. No new capability key. The bytes pass through the app server; no browser ever holds a bucket address or a signing key.

| Route | Who | Rule |
|---|---|---|
| `PUT /api/jobs/{id}/photos/{photoId}?kind=photo` | `photos` (owner, estimator) | The raw image as the body (JPEG, PNG or WebP, told by its own first bytes, at most 30 MiB, under Cloud Run's 32 MiB request limit; 415 and 413 otherwise). A new photo needs a job still on its draft and a field draft being edited: while it is `submitting` or after it is `submitted`, or once the job is signed, it is 409 `draft_locked`. The server computes the SHA-256, creates the object with a create-only precondition (`ifGenerationMatch=0`, so bytes are never overwritten) and registers it once. 201 and the receipt (photo id, kind, hash, size, type, time) the first time, 200 and the same receipt for the same bytes again, 409 `photo_conflict` for other bytes under the same id. A photo already registered answers its receipt even after the draft is locked, so a lost answer is always settled by sending again. The phone then writes the photo's reference document. |
| `PUT /api/jobs/{id}/photos/{photoId}?kind=original` | `photos` (owner, estimator) | The full-size original of a photo the job already holds, sent with `X-Photo-Sha256`: the hash of that registered photo (409 `photo_missing` when there is none, 409 `photo_conflict` when the hash is another). It may arrive after the job is signed and the draft locked, and changes nothing in the record. Same receipt rules as a photo. |
| `GET /api/jobs/{id}/photos/{photoId}?kind=photo\|original` | `jobs_read` (everyone with the job, office included) | Streams the stored bytes with the stored type, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a sandboxing content security policy. No kind means the photo. 404 for a photo or original that is not registered. |

A job another estimator owns, or another company's, is 404 on both (never a hint that it exists), an archived job is 410, and office sending a photo is 403. The job id in the path never grants anything: the registry row is looked up in the caller's own company only, so another company's photo id on the caller's own job is as missing as on its own. Every new row adds one audit row with the job id, the kind and the size only. Object names are `companies/{company}/jobs/{job}/photos/{photoId}` and `.../originals/{photoId}`: ids only, no hash, type or person in the name, so one photo id is one object and a second upload of it meets the precondition whatever its bytes.

## Company isolation gate
The standard's required test, one named suite (S3-17), run by `npm run test:isolation` in `web/` and by the `company-isolation` job of `.github/workflows/web.yml`, which `Web app / check` requires. It seeds two companies in two sign-in tenants, then as each company's owner, estimator and office user calls every route with the other company's ids (the photo route's bytes and originals among them):
- **Routes** (`web/tests/db/company-isolation.test.ts`): no sign-in answers 401; the other company's people are refused (401, 403 or 404) on every route in the matrix but four open answers the suite lists (`/api/me`, the sign-in page, health and echo) with no id, email, address or tenant of the company in the body, and the database, the sign-in tenant calls and the access projection are unchanged. Also the caller's own company with the other's record ids (an invitation, member or job of the other company), the caller's own team and job lists (no row of the other company), a job create that carries the other company's job and draft ids (it makes only the caller's own job and draft, and the other company's rows are unchanged), `/api/me` with the other company named in the query or a header, the scheduler's route (no person's token passes), and an invitation addressed to an email that exists in both companies. Each open answer is held to what its comment says is public: `/api/me` names the caller's own company, `GET /api/sign-in/{address}` answers a company's name and sign-in tenant and nothing else, and a new open route fails until its answer is listed.
- **The route list** (`web/tests/db/isolation-matrix.ts`): the suite finds and imports every `route.ts` under `web/src/app` and fails when an exported handler has no row in the matrix or a row names a handler that no longer exists; every exported handler but the create handlers is then called as above, and the suite fails by name on a handler it did not reach or a path parameter it has no id for (a create handler is called by its own test above). Each row's kind (company, invitation, operator, service, session, public) records the decision for review. A route that names no company (the Prices routes: the company is the sign-in's) is marked `self`: the other company's user is answered about their own company, so the suite holds that answer to no trace of the other company (the seeded working copies and versions carry marker names) and no change, and the route's write carries a stale revision so it is refused. Adding a route means adding its row, which a reviewer reads.
- **SQL as the runtime role** (same file): every table in the `public` schema, found from the catalog, read inside each company's context shows no trace of the other company, with no company set it shows nothing, and inserts, updates and deletes aimed at the other company's rows are refused or change no row.
- **The operator**: a support view of a company's team writes one `support_team_viewed` audit row naming the operator and that company; the other company never sees it.
- **Firestore rules** (`web/tests/emu/rules/company-isolation.test.ts`, emulator): every user of one company is refused every read, list, write, delete and mixed batch on the other's company, access records, drafts, rooms and photos; so are a sign-in with no tenant, no sign-in, a same-uid account of another tenant and an access record written for the wrong company's person.
- **Smoke check for `test`** (`web/scripts/smoke-isolation.ts`, read-only, fake data only): with the sign-ins of two test companies, one company's token and the other's ids are refused on the team, operator and invitation routes, and each token's `/api/me` names its own company. It sends no token to a service whose health does not say `test`. The owner runs it with real test sign-ins in S3-18; no workflow has those sign-ins, so none runs it.

## Rules for adding a feature
- Add a capability key to `CAPABILITIES` in `backend/workspaces.py`, check it on the server route, mirror it in `can()` in `public/workspaces.js` and in `web/src/lib/access/roles.ts`, and add a row to the table above. Test owner, estimator, office, superadmin support, and a different company's user.
- Refuse before reading when the caller lacks the role, so refusals cannot probe other companies.
- Add the route's row to `web/tests/db/isolation-matrix.ts` (the isolation gate fails without it) and give any new table a case in the SQL part of the suite if it is not found from the catalog.
- Audit anything superadmins do.
