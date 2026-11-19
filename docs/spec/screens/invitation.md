# Accept invitation

Part of [Screen specs](README.md). Address: `/sign-in/{address}/invitations/{invitationId}`. Built
in: `web/src/app/(auth)/sign-in/[address]/invitations/[invitationId]/page.tsx` (opens the company
sign-in screen with the invitation id), `sign-in-screen.tsx` and `invitation-screen.tsx`; words in
`web/src/lib/team/screen.ts`. Stages S3-10 (API), S3-13, S3-16.

## Purpose

The link an owner (or, for an owner invitation, the platform operator) copies and sends. It is the
company's [sign-in page](sign-in.md) opened for an invited person: they sign in (usually after "Set
your own password"), and once signed in without a membership they see the invitation addressed to
their verified email and accept it once. Accepting makes the membership; the sign-in page then
continues as for any member.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Invited person (not yet a member), signed in with the invited, verified email | "Accept invitation": "{company} has invited you to join as {role}." | "Accept invitation" while it is open |
| Signed in with another email, or no invitation at this id | "Accept a company invitation before using this app": "…there is no invitation at this link for your email address…" (the server answers both the same way) | sign out |
| Owner, estimator, office already in this company | the signed-in dashboard of the [sign-in page](sign-in.md); the invitation is not shown | as on that page |
| Superadmin support | nothing: the operator has no company sign-in | nothing |
| Different-company user | this page signs in to this company's tenant only; their account is not in it | nothing |

The page answers 404 ("This sign-in link is not recognised") when the id is not a UUID or the address
names no company. Signed out, the sign-in form adds "You have been invited to {company}. First time
here? Choose Set your own password.".

## States

- Checking: "Checking your invitation…".
- Unavailable: "We could not check your invitation" ("Check your connection, then reload this
  page.").
- Open: the offer with "Accept invitation"; a refusal shows its reason (`acceptErrorMessage`).
- Closed: "This invitation has expired. Ask the owner of {company} to send it again.", "This
  invitation was cancelled. Ask the owner of {company} for a new one." or "This invitation has
  already been used.".
- Second step needed (an owner or office invitation, and the account has no authenticator app):
  the "Set up your second sign-in step" screen; once set up, accepting is tried again. If the account
  already has an app but signed in without it: signed out with "Your authenticator app is set up. Sign
  in again and enter its code, then accept the invitation.".
- Sign-in too old: "Your sign-in has run out. Sign in again, then accept the invitation.".

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Read the invitation | `GET /api/invitations/{invitationId}` | signed-in account (`accountRoute`), only for the invited verified email |
| Accept invitation | `POST /api/invitations/{invitationId}/accept` | signed-in account; owner and office need a second step |
| Set up the second step | Firebase Auth (TOTP enrolment), no app route | the signed-in account |

Rules: `docs/access/roles.md`; second-step rule by role in [Company sign-in](sign-in.md).

## Not built yet

- The invitation email (stage S9); the link is copied by hand.

## Mismatches to check

None found.
