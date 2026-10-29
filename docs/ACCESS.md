# Access matrix

Summary of who may do what. **Authoritative detail:** `docs/company-workspaces.md`. Code: `can()` in `public/workspaces.js` (convenience only) and the server checks in `backend/main.py`, `backend/workspace_api.py`, `backend/workspaces.py` (the real enforcement). If this file and the code disagree, the code wins; fix this file in the same PR.

## Principles
1. Identity = verified Firebase ID token (Google or password sign-in, email verified). Public sign-up stays **disabled**.
2. Authorization = private Firestore membership and job-access records. Never custom claims or anything from the browser. (Exception: the `password_change_required` claim only *denies*.)
3. Browsers never reach Firestore (`firestore.rules` is deny-all; a test enforces it). Server SDK access is controlled by IAM, not rules.
4. Every business endpoint checks identity, company membership and job access on every call, including evidence downloads and Live reconnects.
5. One active owner and one company membership per user.
6. Superadmin support access is read-only plus listed support actions, always audited, and is not a membership.

## Roles
| Capability | Superadmin | Owner | Estimator | Office |
|---|---|---|---|---|
| Create/suspend companies, invite or replace owners | yes | no | no | no |
| Company profile, team, invitations | support actions only | yes | no | no |
| See jobs | any company, read-only | all company jobs | own or assigned | all company jobs |
| Live walkthrough, scope, photos, OCR, audit | no | yes | yes | no |
| Create job | no | yes | yes | empty-scope job only |
| Sign (on site / send signing link) | no | yes | yes | no |
| Coordination, assignments, claim details | read-only | yes | [confirm] | yes |
| Copy signed job to new draft | no | yes | yes (jobs they can open) | yes |
| Address suggestions and map (`places`) | no | yes | yes | no (directions link only) |
| Document delivery status and Resend | read-only | yes | [confirm] | yes |
| Archive unsigned draft | no | yes | no | no |
| Read the team roster | yes | yes | no | active estimators only |

Rows marked [confirm] are not stated in the docs I read; check `can()` and the server before relying on them.

## Non-role access
- **Homeowner signing link** (`/api/sign*`): single-use token, expires in 7 days, stops working on any edit; acts as the technician who sent it.
- **Document link** (`/documents`): read-only, bound to one signed agreement and one document set, expires in 30 days, revocable, multi-view.
- **Server-only**: Cloud Run runtime service account `adr-runtime@…`; background jobs (vault backup, monitoring).

## Rules for adding a feature
- Add a capability to `can()` **and** the server check; test owner, estimator, office, superadmin support, and a different company's user.
- Refuse before reading when the caller lacks the role, so refusals cannot probe other companies.
- Audit anything superadmins do.
