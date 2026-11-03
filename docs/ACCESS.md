# Access matrix

Summary of who may do what. **Source of truth in code:** the `CAPABILITIES` dictionary in `backend/workspaces.py`, enforced by `job_access` and the route checks. `can()` in `public/workspaces.js` only hides buttons. Prose detail: `docs/company-workspaces.md`. If this file and the code disagree, the code wins; fix this file in the same PR.

## Principles
1. Identity = verified Firebase ID token (Google or password sign-in, email verified). Public sign-up stays **disabled**.
2. Authorization = private Firestore membership and job-access records. Never custom claims or anything from the browser. (Exception: the `password_change_required` claim only *denies*.)
3. Browsers never reach Firestore (`firestore.rules` is deny-all; a test enforces it). Server SDK access is controlled by IAM, not rules.
4. Every business endpoint checks identity, company membership and job access on every call, including evidence downloads and Live reconnects.
5. One active owner and one company membership per user.
6. Superadmin support access is read-only plus listed support actions, always audited, and is not a membership.

## Company roles (from `CAPABILITIES` in `backend/workspaces.py`, Oct 28, 2026)
| Capability key | What it allows | Owner | Estimator | Office |
|---|---|---|---|---|
| `jobs_read` | See jobs (estimator: only jobs they created or are assigned) | yes | yes | yes |
| `jobs_create` | Start a job (office: empty scope only) | yes | yes | yes |
| `jobs_copy` | Copy a signed job to a new draft | yes | yes | yes |
| `coordination` | Job coordination and claim/loss details | yes | no | yes |
| `assignment` | Assign estimators to jobs | yes | no | yes |
| `scope` | Edit rooms, measurements, scope | yes | yes | no |
| `places` | Address suggestions and job map | yes | yes | no |
| `photos` | Add photos | yes | yes | no |
| `ocr` | Meter-photo recognition | yes | yes | no |
| `audit` | Finish & review (generate documents) | yes | yes | no |
| `sign` | Capture signature / send signing link | yes | yes | no |
| `live` | Live walkthrough | yes | yes | no |
| `jobs_archive` | Archive and restore unsigned drafts | yes | no | no |
| `team_manage` | Team and invitations | yes | no | no |
| `profile_manage` | Company profile and logo | yes | no | no |
| `delivery_manage` | Company delivery settings | yes | no | no |
| `delivery_resend` | Resend signed documents | yes | no | yes |
| `quantity_notes_read` | Receive estimator quantity-override notes with a job's documents (the API omits them for everyone else, including superadmin support and all links) | yes | no | no |
| `prices_read` | See company price books, enabled items (including in version diffs) and settings (only when `PRICE_BOOKS_ENABLED`; added in `_capabilities`) | yes | yes | yes |
| `prices_manage` | Edit company price books, items and settings, including the owner-only working copy; export disabled items (only when `PRICE_BOOKS_ENABLED`) | yes | no | no |

Office can read only active estimators' uid/email from the team, for assignment.

## Superadmin
Not a company role and not a membership. Can create/suspend/reactivate companies and invite or replace owners (or create an owner login with a temporary password). Read-only, audited support access to any company's jobs, documents, photos, team and invitations, plus listed support actions: resend or cancel a staff invitation, switch a non-owner between estimator and office, re-enable a disabled member, archive or restore an unsigned draft (also in a suspended company). Never edits customer jobs.

## Non-role access
- **Homeowner signing link** (`/api/sign*`): single-use token, expires in 7 days, stops working on any edit; acts as the technician who sent it.
- **Document link** (`/documents`): read-only, bound to one signed agreement and one document set, expires in 30 days, revocable, multi-view.
- **Server-only**: Cloud Run runtime service account `adr-runtime@…`; background jobs (vault backup, monitoring).

## Rules for adding a feature
- Add a capability key to `CAPABILITIES` in `backend/workspaces.py`, check it on the server route, mirror it in `can()` in `public/workspaces.js`, and add a row to the table above. Test owner, estimator, office, superadmin support, and a different company's user.
- Refuse before reading when the caller lacks the role, so refusals cannot probe other companies.
- Audit anything superadmins do.
