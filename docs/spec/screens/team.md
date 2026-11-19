# Team and invitations

Part of [Screen specs](README.md). Address: `/sign-in/{address}/team`. Built in:
`web/src/app/(auth)/sign-in/[address]/team/page.tsx`, `team-screen.tsx` (sign-in check) and
`team-board.tsx` (the board); words in `web/src/lib/team/screen.ts`. Stages S3-10 (API), S3-16
(screen).

## Purpose

The company owner's one screen for the people of the company: invite someone as an estimator or
office user, see the members, change a member between estimator and office, turn a member off or
on, and resend, cancel or clear invitations. There is no email service yet, so the screen shows
each new or resent invitation's link for the owner to copy and send ("Send them this link. It works
for 7 days."). Every change is one call followed by reading the team again, so the screen shows
what the server holds.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | "Team and invitations": Invite someone, Members, Invitations | invite, change role, turn off or on, resend, cancel, clear |
| Estimator | "This screen is for the company owner" ("Only the owner of {company} can see and change the team."); the team is never requested | nothing |
| Office | the same as an estimator | nothing here (the server lets office read only active estimators, for assignment in [Job coordination](job-coordination.md); this screen does not ask) |
| Superadmin support | nothing here; the operator has its own read-only [team view](operator-team.md) | nothing |
| Different-company user | the page belongs to the company in the address; a sign-in from another company's tenant is signed out (`belongsTo`), and every team route checks the company from the sign-in | nothing |

The screen asks `GET /api/me` and requests the team only when the role holds `team_manage`
(`signedInMember` in `web/src/lib/team/screen.ts`). The owner row has no buttons ("The owner cannot
be changed here." is the server's answer if tried). The sign-in page offers "Team and invitations"
only to a role with `team_manage` ([Company sign-in](sign-in.md)).

## States

- Sign-in not set up for this environment: "Sign-in is not set up here yet. Try again later."
- Checking: "Checking your sign-in…".
- Signed out: "Sign in to see your team" with "Go to the {company} sign-in page".
- Sign-in unfinished (email not verified, no membership, second step missing): "Finish signing in
  first".
- Could not save the sign-out on this phone: "We couldn't secure your saved work" with "Try again"
  (`work-not-secured.tsx`).
- Unavailable: "We could not open the team" ("Check your connection, then try again.").
- Empty invitations: "No invitations."
- Invitation status per row: "Open until {date}", "Expired", "Accepted", "Cancelled".
- Refused change: the server's reason in plain words (`teamErrorMessage`), for example "That email
  address is already on the team.", "That email address already has an invitation. Resend or cancel
  it below.", "An invitation that is still open cannot be cleared. Cancel it first.", "This company
  has no sign-in link yet, so nobody can be invited. Contact DryScope support.".
- Sign-in too old: "For safety, team changes need a sign-in from the last 15 minutes. Sign in again,
  then repeat the change." with "Sign in again".
- Changed but not re-read: "The change was made, but the list could not be refreshed. Reload the
  page."
- Copy: "Link copied." or "Could not copy. Select the link and copy it by hand."

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Who is signed in | `GET /api/me` | member |
| Read the team | `GET /api/companies/{id}/team` | `team_manage` gets the full view (office gets estimators only) |
| Create invitation (email, role estimator or office) | `POST /api/companies/{id}/invitations` | owner role, sign-in under 15 minutes |
| Resend (open or expired) | `POST /api/companies/{id}/invitations/{invitationId}/resend` | owner role, sign-in under 15 minutes |
| Cancel (open) | `POST /api/companies/{id}/invitations/{invitationId}/cancel` | owner role, sign-in under 15 minutes |
| Clear (closed) | `POST /api/companies/{id}/invitations/{invitationId}/clear` | owner role, sign-in under 15 minutes |
| Change to estimator / office | `PATCH /api/companies/{id}/members/{membershipId}` | owner role, sign-in under 15 minutes |
| Turn off / Turn on | `POST /api/companies/{id}/members/{membershipId}/disable` or `/enable` | owner role, sign-in under 15 minutes |

Rules: `docs/access/roles.md` (`team_manage`), `docs/access/role-checks-and-switches.md` ("all
member and invitation changes" are by owner role).

## Not built yet

- Sending invitations by email: the owner copies the link (email is stage S9).
- Inviting an owner or changing the owner: only the platform operator can
  ([Operator: one company](operator-company.md)).
- Listing a member's pending signing links before turning them off (named in
  `docs/access/role-checks-and-switches.md`; no route or screen in `web/`).

## Mismatches to check

None found.
