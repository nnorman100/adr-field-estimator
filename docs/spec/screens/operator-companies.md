# Operator: companies (and operator sign-in)

Part of [Screen specs](README.md). Address: `/operator/{tenantId}`, where `{tenantId}` is the
operator sign-in tenant's id. Built in: `web/src/app/operator/[tenantId]/layout.tsx`,
`operator-session.tsx` (sign-in for every operator page), `page.tsx`, `companies-screen.tsx`,
`ui.tsx`, `use-action.tsx`; calls in `web/src/lib/operator/client.ts`. Stages S3-9 (API), S3-15
(screens). The pages are marked `noindex`.

## Purpose

The platform operator's home: sign in to the operator-only tenant, list every company (name,
status, sign-in address, whether its sign-in tenant is set) with "Manage", and add a company by name
and sign-in address. The operator is not a company member and sees no customer data here.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner, estimator, office | "Platform operator sign-in"; their company account is not in the operator tenant; an account that signs in but is not an operator is signed out with "This account is not a platform operator." (the routes answer 403 `not_an_operator`) | nothing |
| Superadmin support (platform operator) | "Companies" and "Add a company" | list, add a company, open [one company](operator-company.md) |
| Different-company user | the same as a company role | nothing |

A tenant id that is not shaped like a tenant id (letters, digits and hyphens, 1 to 128 characters) answers 404 (`isOperatorTenantId` in the layout). The layout checks only that shape: a well-formed id of a company's tenant opens the operator sign-in, and a company account that signs in there is refused by the operator API with 403 `not_an_operator` and dropped.

## States

- Sign-in not set up: "Sign-in is not set up here yet. Try again later."
- Signed out: "Platform operator sign-in" ("For DryScope platform operators only.") with email,
  password, "Sign in", "Sign in with Google" and the reCAPTCHA notice; then the authenticator code.
- Checking: "Checking your sign-in…"; unavailable: "We could not check your sign-in" with "Try
  again".
- "Verify your email"; no second step: "Set up your second sign-in step" ("…Setting it up from this
  screen arrives in the next update.") with only Sign out.
- Empty: "No companies yet."
- Add a company: "Enter the company's name."; "The sign-in address is lowercase letters, digits and
  hyphens…"; done: "{name} was created."; refusals from the server (`useAction`).
- Sign-in too old for a change (a company status, owner or second-step change after 15 minutes, `useAction`): the person stays on the administration screen, which shows "For that change, sign in again." with a "Sign in again" button; pressing it signs them out, and the sign-in screen opens with that same message. Nothing is signed out until they press it.

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Sign in, code | Firebase Auth, operator tenant (authenticator required, again after 12 hours) | none |
| List companies (also the sign-in check) | `GET /api/platform/companies` | platform operator |
| Add company | `POST /api/platform/companies` | platform operator |

Rules: `docs/access/superadmin.md`.

## Not built yet

- Setting up the operator's second step on this screen (the page says it arrives in the next
  update); operators are added by the owner-run `npm run platform:add-operator`.
- Binding a company's sign-in tenant from a screen (`POST /api/platform/companies/{id}/tenant`
  exists; the owner-run command makes the tenant).

## Mismatches to check

- `docs/access/superadmin.md` gives the operator read-only support access to every company's jobs,
  documents and photos; no operator screen or route reads them (S5b-5, see [README](README.md)
  item 4).
