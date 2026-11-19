# Operator: one company

Part of [Screen specs](README.md). Address: `/operator/{tenantId}/companies/{companyId}`. Built in:
`web/src/app/operator/[tenantId]/companies/[companyId]/page.tsx`, `company-admin-screen.tsx`,
`status-section.tsx`, `owner-section.tsx`, `second-step-section.tsx`; status words in
`web/src/lib/operator/screens.ts`. Stages S3-9 (API), S3-15 (screen). Signed in through the
operator session ([Operator: companies](operator-companies.md)).

## Purpose

Administer one company without touching its customer data: see its status, sign-in address and
whether its sign-in tenant is set; suspend, reactivate or archive it; invite the first owner or
replace the owner by link; reset a member's second step after a phone check; and open the read-only
[team view](operator-team.md). Jobs, estimates and prices are not shown or changed here.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner, estimator, office | the operator sign-in only; the routes answer 403 `not_an_operator` | nothing |
| Superadmin support (platform operator) | the company's name, Status, Sign-in address, Sign-in tenant, and the sections Status, Owner, Second step, Team | suspend (asks first), reactivate, archive (only for a suspended company; asks first); invite or replace the owner (replace needs "I understand the current owner is turned off and signed out everywhere straight away."); list members and reset one's second step (needs "I confirmed by phone that this is {name}."); open the team view |
| Different-company user | the same as a company role | nothing |

The page finds the company in the list the session already read, so opening it writes no audit
row; each change writes one. Status, owner and second-step changes need a sign-in under 15 minutes
old (`freshSignIn` on the routes); listing the team for the second-step section writes one audit
row ("Listing the team here is recorded in the audit log, like the team view.").

## States

- Unknown company id: "Company not found" with "Back to Companies".
- Status: "Suspending turns off sign-in and field access for everyone in this company until you
  reactivate it."; "Archiving closes this company. You can still reactivate it later."; done: "{name}
  is now {status}.".
- Owner, no sign-in tenant: "This company has no sign-in tenant yet, so an owner cannot be invited.
  The tenant is made by the owner-run command and bound to the company first."
- Owner invited: "No email is sent yet. Send this link to {email} yourself; it works for 7 days."
  (after a replace, first "The previous owner is turned off and signed out."), with the link and
  copy ("Link copied." / "Could not copy. Select the link and copy it.").
- Second step: "This company has nobody to reset yet."; done: "Second step reset for {who}. No email
  is sent yet: tell them by phone that they must set it up again when they sign in." (or "They have
  been emailed.").
- Refusals and "For that change, sign in again.": as on [Operator: companies](operator-companies.md).

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Suspend, reactivate, archive | `POST /api/platform/companies/{id}/status` | platform operator, sign-in under 15 minutes |
| Invite or replace owner | `POST /api/platform/companies/{id}/owner` | platform operator, sign-in under 15 minutes |
| List members for the second step | `GET /api/platform/companies/{id}/team` | platform operator |
| Reset second step | `POST /api/platform/companies/{id}/members/{membershipId}/reset-second-step` | platform operator, sign-in under 15 minutes |
| Open the team view | `/operator/{tenantId}/companies/{id}/team` | platform operator |

Rules: `docs/access/superadmin.md`.

## Not built yet

- Screens for routes that exist: bind the sign-in tenant (`…/tenant`), feature flags (`…/flags`),
  AI ceilings (`…/ai-settings`), the read-only prices view (`…/prices`) and the records check
  (`…/records-check`, screen planned as S8-4, `docs/plans/S8/S8-4.md`).
- Emailing the owner invitation and the second-step reset (stage S9).

## Mismatches to check

None found.
