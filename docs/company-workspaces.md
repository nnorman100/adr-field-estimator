# Company workspaces

The build adds company dashboards; production activation requires the staged checks below. Workspace activation remains separate from the mobile repair release.

Read-only October 11, 2026 readiness review (October 12 UTC): production is now backend `alert-disaster-field-estimator-00013-hup`, tag `harden-fixes`, 100% traffic, with workspaces **disabled**, and frontend `hardening-20261011-1`. Hosting version is `05af952eff367594` (release `1791758723456000`). The `workspaces` tag still points to `00008-jom` with zero default traffic. The paragraphs below record the historical workspace staging session, not the current rollback pair. Recheck live metadata immediately before any release. See `docs/mobile-usability-repairs.md` for current repair gates.

Staged backend: `alert-disaster-field-estimator-00008-jom`, tag `workspaces`, zero production traffic. The tagged health check reports workspaces enabled and anonymous session access returns 401. Production retains backend `00006-yer` and frontend `live-reliable-20261007-1`. The four workspace indexes are READY. ADR migration created seven private access records; a reconciliation run created none and verified that source inspection/authorization fingerprints stayed unchanged. The initial verified account now has ADR owner membership and separate superadmin status in the staged workspace model.

Python: 110 passed; frontend/lifecycle and HTML mirror checks passed. The complete browser regression passed 59 checks with seven existing Windows WebKit skips. All 20 workspace checks are verified across Chromium/WebKit after correcting and rerunning an early WebKit assertion in the former-owner test. The final workspace checks are recorded in the status artifact. A real database/storage check passed 12 scenarios and removed its 38 synthetic records and signature evidence. These identities were synthetic policy inputs, not authenticated Google accounts. No real invitation email, four-role authenticated API acceptance or physical device acceptance is claimed. Evidence: `review-artifacts/workspaces-20261007/`.

Activation is pending a verified Resend sender, server-only secret, real invitation receipt/acceptance and authenticated staged workflows. Hosting has not been deployed.

## Roles and source of authorization

Verified Firebase ID tokens from Google or email/password sign-in establish identity. With WORKSPACES_ENABLED=true, Firestore memberships authorize access; browser capabilities and Firebase custom claims cannot grant permissions. The root user is bootstrapped by an explicit migration, not by matching an email on each request. Superadmin membership lives separately from company membership.

| Role | Allowed operations |
| --- | --- |
| Superadmin | Create/suspend/reactivate companies, invite or replace owners, inspect account/invitation metadata. No customer-job access through this role. |
| Owner | Company profile/team/invitations; all company jobs, coordination, assignments and the full field workflow. |
| Estimator | Jobs created by them or currently assigned to them; Live, scope, photos/OCR, audits and customer-signature capture. Reassignment retains creator access. |
| Office | Company jobs and documents/evidence/export; empty-scope job creation; coordination and assignments. The team endpoint returns office staff only active estimators' uid/email for assignment; estimators cannot read the team. Scope, capture, OCR, audits and signature submission are denied. |

One active owner and one company membership per user are supported. Office-created jobs have no rooms or measured scope; the estimator supplies them. Signed property/document contents are immutable; office contact notes and assignment sidecars can still change. Owners cannot replace or disable the active owner; superadmin replacement takes effect atomically on acceptance and disables the prior membership. A disabled former owner can later be given a staff role.

Private collections are _companies, _memberships, _platform_admins, _invitations, _invite_keys, _admin_events, _company_limits, _workspace_jobs and _workspace_authorizations. Job sidecars contain company, creator, assignee, coordination version and query summaries. Signed source records, payload hashes and stored evidence paths are retained. The migration manifest records source fingerprints around each run to detect concurrent source changes before cutover. Every write rechecks permission within its transaction; long AI results recheck before commit and evidence downloads before return. Live rechecks every 20 seconds and removes checkpoints after permission loss. Existing per-user quotas/leases remain. Each company may create or resend at most 50 invitations per day; more return 429 with Retry-After.

## Sign-in methods

With WORKSPACES_ENABLED=true the backend accepts Firebase ID tokens whose sign-in provider is `google.com` or `password`, and only when the email is verified. Password accounts are created only by invitation. The app has no sign-up control. Before each invitation email is sent, the backend looks up the invited email in Firebase Authentication and creates an unverified account without a password if none exists. This stops anyone else from registering the invited address first. If the account does not sign in with Google, the email carries a set-password link; otherwise it tells the invitee to sign in with Google using that email. Resending an invitation reuses the account and mails a fresh link. The link is a credential, so it appears only in the outgoing email, never in Firestore or logs. If the link has expired, the invitee uses **Forgot password** on the sign-in page. An unverified password account stays on the verification step and makes no session or job calls. A verified account still has no access until it accepts a company invitation for that exact email. The legacy STAFF_EMAILS mode is unchanged.

Public sign-up must be disabled before activation, or the Firebase Auth API still accepts self-registration with the public web API key. This is a separate production change. Run it only with operator approval:

```
PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/alert-disaster-field-2026/config?updateMask=client.permissions.disabledUserSignup
{"client":{"permissions":{"disabledUserSignup":true}}}
```

Verify it by reading `GET https://identitytoolkit.googleapis.com/admin/v2/projects/alert-disaster-field-2026/config` and confirming `client.permissions.disabledUserSignup` is `true`. While sign-up is disabled, a client sign-up attempt returns `auth/admin-restricted-operation`, which the app shows as "Ask your company owner for an invitation." Server-side account creation through the Admin SDK is not affected.

Firebase keeps one account per email. Signing in with Google replaces an unverified email/password account with the same address, and some combinations return "This email already uses a different sign-in method." Each staff member should use one sign-in method per email. The app has no account-linking flow.

`firebase.json` enables the email/password provider. Enable it in the project as a separate approved step before hosting activation: `firebase deploy --only auth --project alert-disaster-field-2026`. The Firebase CLI auth deploy only enables providers; it also re-sends the existing Google provider settings from `firebase.json`.

## Invitations and interfaces

Superadmin creates companies or sends owner replacements. Owners invite estimator/office emails. Invitations last seven days and activate only after explicit acceptance by a verified account with the exact invited email. Acceptance checks current inviter access and company status. Owner invitations bind the owner being replaced so competing invitations cannot silently replace a newly accepted owner. Repeated acceptance is idempotent; incompatible existing membership, expiry and cancellation return conflicts. Team changes use expected versions.

Resend delivery has an eight-second transport deadline per attempt, up to three attempts and a stable idempotency key. Send failures are visible; operators can resend or cancel. Concurrent sends reserve the same attempt. Attempts older than 23 hours require explicit resend to stay inside the provider's idempotency window. The invitation link is an opaque invitation ID; the ID alone grants no account access. Account provisioning needs the backend runtime identity to read and create Firebase Authentication users and generate password-reset links (for example Firebase Authentication Admin); confirm the grant on the staged revision before activation. No custom-token grant is required. A failed lookup, creation or link generation marks the delivery failed; **Resend invitation** retries it.

The additive interfaces are /api/access; /api/admin/companies and company status; /api/companies/{id} profile, team and invitations; /api/invitations/{id} read/accept; and /api/jobs/{inspection_id}/coordination. Existing inspection and agreement URLs use company permissions. Session responses advertise workspace_protocol_version=1 and role/capabilities. Company-aware clients send X-ADR-Workspace-Protocol: 1. New company audits/signatures and saved branded documents require this header, preventing cached clients from displaying hardcoded ADR identity. Non-ADR Live handshakes also send workspace_protocol_version=1. Existing ADR v1 Live connections and historical unsigned/legacy records retain compatibility.

## Company documents and offline drafts

Company profiles provide name (up to 80 letters, numbers, spaces or . , & ' ( ) - characters, with no web address, because invitation emails include it), address/contact, CSLB license, sign-off and optional validated PNG/JPEG logo. This release is California-only and uses the shared existing residential workbook rates/formulas/internal scope codes. Pricing is server-owned. ADR notices remain exact; non-ADR water-heater jobs require the owner's own coordination notice. Missing company identity or coordination setup blocks signing and is shown in review.

New audits store company_identity and its profile version. Profile changes invalidate unsigned signability until regeneration. Signed documents retain the saved identity; old signed records use historical ADR fallback. Company-supplied labels are untrusted JSON data in model context and text nodes in the browser.

Estimators land on My jobs, office staff on Company jobs, and owners/superadmins on their dashboard. Signing in opens the workspace without creating or automatically reopening an inspection. Authorized local drafts remain available through Jobs.

Draft keys include user/company/inspection. Legacy local drafts recover only after online confirmation of ADR membership. Access/context changes stop capture, clear visible records, pause queued writes and retain local drafts for authorized recovery. Offline coordination/admin mutation controls are disabled. Cached role data never authorizes a server operation; online synchronization revalidates access.

## Migration and release

1. Run the required Python, Node and browser suites, compare both HTML copies and verify standalone uvicorn main:app imports the new modules. Capture mock results separately from real services.
2. Preview scripts/migrate_workspaces.py with --manifest review-artifacts/workspaces-20261007/migration-preview.json. It looks up only explicitly approved existing Google emails using ADC; email/password users join through invitations, not migration; add other already-approved staff with --approved-email. Review counts and mappings before applying. Unknown creators remain unmapped.
3. Deploy only Firestore indexes in alert-disaster-field-2026 and wait until the four workspace query indexes are READY. Direct browser database access stays denied.
4. Apply the migration with --apply --manifest review-artifacts/workspaces-20261007/migration-applied.json. It creates access sidecars and initial membership only, never rewrites signed customer sources. Re-running preserves subsequent profile, role and assignment changes.
5. Stage a no-traffic backend revision with `python scripts/deploy_backend.py --workspaces on --tag workspaces --yes`, which keeps the identities, models, region and limits described in firebase-isolation.md. Existing production traffic stays on the verified Live revision.
6. Configure a verified sender in INVITATION_FROM and bind RESEND_API_KEY from a dedicated Secret Manager secret. Grant secret accessor to adr-runtime only for that secret. Store values through Secret Manager, never chat, source, CLI arguments or artifacts. Production email acceptance remains open until a real invitation is received and accepted by its intended Google account. With approval, disable public sign-up and verify the setting as described in Sign-in methods.
7. Verify staged authenticated workflows with real Google sign-in and one verified email/password account, two isolated synthetic companies and the four roles. Test owner transfer/suspension, permission changes during capture, company branding, OCR/audit/pricing/signing/reopening and exact tracked cleanup. Use `scripts/verify_workspace_database.py` for scoped real Firestore/storage checks. Synthetic database-only checks do not prove authenticated API or email delivery. Use `node scripts/verify_live_browser.js --workspaces --hold` for normal staff sign-in and the staged field workflow; four-role acceptance must use real invited Google accounts.
8. During a controlled cutover, drain old writes and re-run the migration to cover jobs created by the old release. Verify sidecar summaries and mappings before promotion. Promote the verified backend, then only hosting:alert-disaster in alert-disaster-field-2026. Recheck deployed assets and authenticated workflows.

Prior matched production pair at start: backend alert-disaster-field-estimator-00006-yer; frontend live-reliable-20261007-1; Hosting version 0350de7b1566a1b5 (release 1791398669068000). Source baseline is preserved under review-artifacts/workspaces-20261007/baseline. Capture a fresh pair before promotion. Stop workspace writes before rollback, disable workspace authorization, and restore the matched original owner-only backend/frontend. Sidecars are retained but ignored in that mode; raw customer documents and evidence are not deleted. New-company memberships are unavailable in owner-only rollback, and staff-signed/assigned jobs need reconciliation before reactivation.

Physical iPhone/Bluetooth acceptance remains open. This feature does not add billing, company rates, other-state rules, multiple-company membership, Live tools, Cloud Vision or automatic invitation background retries.
