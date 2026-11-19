# Operator: a company's team

Part of [Screen specs](README.md). Address: `/operator/{tenantId}/companies/{companyId}/team`. Built
in: `web/src/app/operator/[tenantId]/companies/[companyId]/team/page.tsx`,
`support-team-screen.tsx`. Stages S3-9 (API), S3-15 (screen).

## Purpose

A read-only support view of one company's members (name, email, role, active or turned off) and
invitations (email, role, status), so the operator can help a company by phone. Opening it is
recorded in the audit log, one row per view.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner, estimator, office | the operator sign-in only (a malformed tenant id answers 404; for a well-formed one the operator API answers 403 `not_an_operator` and the sign-in is dropped) | nothing |
| Superadmin support (platform operator) | "{company}: team" ("Read-only support view. Company status: {status}. Opening this view is recorded in the audit log."), Members, Invitations | read only |
| Different-company user | the same as a company role | nothing |

## States

- Unknown company id: "Company not found".
- Loading: "Loading the team…"; refused: the server's reason, or "Sign in again to view this team."
- Empty: "No members yet.", "No invitations."

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Read the team | `GET /api/platform/companies/{id}/team` | platform operator; audit `support_team_viewed`, one per view |

Rules: `docs/access/superadmin.md`.

## Not built yet

- The support actions on the team that `docs/access/superadmin.md` lists and that have routes:
  resend or cancel a staff invitation (`…/invitations/{invitationId}/resend`, `/cancel`), switch a
  member between estimator and office (`PATCH …/members/{membershipId}`) and re-enable a member
  (`…/members/{membershipId}/enable`). This view offers none of them.

## Mismatches to check

None found.
