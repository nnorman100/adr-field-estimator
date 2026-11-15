# Access matrix: Principles

Part of [Access matrix](../ACCESS.md).

## Principles

1. Identity = verified Firebase ID token (Google or password sign-in, email verified). Public sign-up stays **disabled**.
2. Authorization = private Firestore membership and job-access records. Never custom claims or anything from the browser. (Exception: the `password_change_required` claim only _denies_.)
3. Browsers never reach Firestore (`firestore.rules` is deny-all; a test enforces it). Server SDK access is controlled by IAM, not rules.
4. Every business endpoint checks identity, company membership and job access on every call, including evidence downloads and Live reconnects. An estimator also needs to be on the job's `accessible_estimator_uids` (created it or assigned); a job outside their company or list answers 404, and an archived job answers 410.
   With `WORKSPACES_ENABLED` off (a rollback mode) there are no capabilities: access is the `STAFF_EMAILS` allowlist plus `owner_uid == uid`.
5. One active owner and one company membership per user.
6. Superadmin support access is read-only plus listed support actions, always audited, and is not a membership.
7. Rebuilt app (`web/`) sign-in (`web/src/lib/auth/policy.ts`): owners, office users and the platform operator must sign in with an authenticator app as a second step, or every route except second-step setup answers 403 `second_step_required` and the field database rules (`web/firestore.rules`) refuse their reads and writes; estimators may opt in. Office was added on 2026-11-14 (D-030), as was the rule that every sign-in tenant enforces passwords of at least 12 characters and email enumeration protection (set by `npm run platform:create-tenant`; existing tenants by `npm run platform:secure-tenants`). Since TC-6 the tenant command also turns on sign-in reCAPTCHA in audit mode (assessed, never blocked; existing tenants by `npm run platform:recaptcha -- --tenant <id> --mode audit`, with the project from your gcloud default project or `--project`; it refuses enforcement until TC-13).
