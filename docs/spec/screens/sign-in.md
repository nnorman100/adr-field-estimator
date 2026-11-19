# Company sign-in, second step and dashboard

Part of [Screen specs](README.md). Address: `/sign-in/{address}`, where `{address}` is the company's
sign-in address. Built in: `web/src/app/(auth)/sign-in/[address]/page.tsx`, `sign-in-screen.tsx`,
`unsent-sign-out-dialog.tsx`, `offline-ready-text.ts`, `work-not-secured.tsx`, `not-found.tsx`; the
second step in `web/src/app/(auth)/second-step/` (`code-screen.tsx`, `enrol-screen.tsx`,
`second-step-section.tsx`); outcomes in `web/src/lib/sign-in/outcome.ts`. Stages S3-13, S3-14,
S5a-4, S6-3, TC-5, TC-6 (owner decision D5).

## Purpose

Each company's own sign-in page. A person signs in with email and password or with Google, enters
an authenticator code when they have a second step, and lands on a small signed-in page (the
"dashboard") that opens the field app and, for the owner, the team and company settings. The page
remembers itself on the phone, so the [start page](start-page.md) comes back here. While signed in it
also gets the field app ready to open with no signal.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | "Signed in to {company}": "You are signed in as the owner…", the second-step line, "Open the field app", "Team and invitations", "Company settings", Sign out | add an authenticator app; open those screens; sign out. A second step is required: without one, only "Set up your second sign-in step" or sign out |
| Estimator | the same without Team and Company settings | open the field app; add an authenticator app (optional); sign out |
| Office | the same as an estimator | the same; a second step is required, as for the owner |
| Superadmin support | nothing: the operator signs in at `/operator/{tenantId}` ([Operator: companies](operator-companies.md)) | nothing |
| Different-company user | this page signs in to this company's sign-in tenant only, so their account is not found; a sign-in from another tenant is signed out | nothing |
| Signed in, not a member | "Accept a company invitation before using this app" ([Accept invitation](invitation.md) on an invitation link) | sign out |

"Team and invitations" shows for a role with `team_manage` (`offersTeamScreen`), "Company settings"
for `profile_manage` (`offersCompanyScreen` in `web/src/lib/profile/screen.ts`); both are the owner
today. There is no link to [Prices](prices.md) here (see Mismatches to check).

## States

- Unknown address: "This sign-in link is not recognised" (`not-found.tsx`).
- Sign-in not set up for this environment: "Sign-in is not set up here yet. Try again later."
- Checking: "Checking your sign-in…"; getting ready for no signal: "Getting DryScope ready to work
  with no signal…"; not ready: "DryScope could not get ready to open with no signal on this phone.
  Open the field app once while you have signal."
- Signed out: "Sign in to {company}" with email, password, "Sign in", "Sign in with Google", "Set
  your own password" and the reCAPTCHA notice.
- "Set your own password" → "Check your email" ("If {company} has an account for that email
  address, a link to set your password is on its way…").
- Code: "Enter your sign-in code" ("Open your authenticator app and enter the 6-digit code…"); timed
  out: "That sign-in timed out. Sign in again."
- Second step required and missing: "Set up your second sign-in step", no way past it but setting
  it up or signing out. Adding another: "Add an authenticator app".
- "Verify your email" with "Send the link" and "I have verified it".
- "Your access is turned off" ("Ask the owner of {company} to turn it back on.").
- "{company} is not active" ("Sign-in is paused for this company. Contact DryScope support.").
- Unavailable: "We could not check your sign-in" with "Try again".
- Sign out with unsent field work: "Work not sent yet" with "Keep it and sign out", "Discard it and
  sign out" or go back.
- A sign-out that could not first save its reason on the phone: "We couldn't secure your saved work"
  with "Try again".

## Key actions and server routes

| Action | Route or service | Key |
|---|---|---|
| Sign in, Google, set password, verify email, authenticator code and enrolment | Firebase Auth for the company's sign-in tenant (no app route) | none |
| Who is signed in (role, company, keys) | `GET /api/me` | member |
| Open the field app | `/field` ([Field app shell](field-shell.md)) | member |
| Team and invitations | `/sign-in/{address}/team` ([Team](team.md)) | `team_manage` |
| Company settings | `/sign-in/{address}/company` ([Company settings](company-settings.md)) | `profile_manage` |

Rules: `docs/access/roles.md`; session rules (second step by role, 15-minute sign-in for sensitive
changes) in `docs/access/role-checks-and-switches.md` and S3-8 (`docs/plans/S3.md`).

## Not built yet

- A real dashboard: the page says "The rest of DryScope arrives in later updates."; the jobs lists
  live in the field app.
- Sign-in emails sent by DryScope itself (stage S9); Firebase Auth sends the password and
  verification links.

## Mismatches to check

- An estimator or office user holds `prices_read` while the company's prices are on, but no screen
  links to [Prices](prices.md) for them: the only link is on Company settings, which only the owner
  can open. They reach the read-only price list only by typing `/sign-in/{address}/prices`.
