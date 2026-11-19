# Customer and claim

Part of [Screen specs](README.md). Address: `/field?job={id}&view=customer`. Built in:
`web/src/app/field/customer-view.tsx`. Stages S5a-3, S5a-6, S5b-1.

## Purpose

Two forms the documents print: Customer (customer name, customer phone, customer email, property
address) and Claim (insurance carrier, claim number, policy number, date of loss, cause of loss,
adjuster name, email and phone, deductible). They are stored on the server (Postgres), not in the
field draft, so they need a connection. Each save carries the job's revision and a change id made
on the phone, so a retry after a lost answer is the same save.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | both forms | save both while the job is unsigned (`scope` or `coordination`) |
| Estimator | both forms, on jobs they made, own or are assigned to | save both only while they own the job's field work and the job is unsigned (`scope`; the server refuses others with `not_field_owner`) |
| Office | both forms | save both while the job is unsigned (`coordination`) |
| Superadmin support | nothing | nothing |
| Different-company user | nothing: 404 | nothing |

The screen shows the forms read only after a move away (J5) or while the job is archived or being
checked (`canSave` in `customer-view.tsx`). It does not check whether the job is signed; the server
refuses a save on a signed job with 409 `job_signed` (`web/src/lib/jobs/service.ts`) and the
refusal is shown.

## States

- No job read yet: "Needs a connection", or the read error with "Try again".
- Offline: "Needs a connection"; saving is not possible.
- Lost answer: "This customer was sent but no answer came back. Try again to finish it." (and the
  same for the claim).
- Stale revision or refusal: the server's message; the typed values are kept.
- Archived job (410): the screen moves to the archived state.

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Read the job, customer and claim | `GET /api/jobs/{id}` | `jobs_read` |
| Save the customer and property address | `PUT /api/jobs/{id}/customer` | `scope` or `coordination` |
| Save the claim | `PUT /api/jobs/{id}/claim` | `scope` or `coordination` |

Rules: `docs/access/jobs.md` ("Jobs routes"), owner decision J3 (`docs/plans/S5.md`). A save after
the estimate makes the estimate need review ([Review](review.md)).

## Not built yet

- Corrections after signing by the owner and office (S5b-4, J3).
- Address suggestions (needs a Maps key, J9).

## Mismatches to check

- The screen offers Save to any estimator with `scope` who can open the job (`canSave` in
  `web/src/app/field/customer-view.tsx` does not check field ownership). The server allows an
  estimator only while they own the job's field work (J3; `jobAccess` with `customer: true` in
  `web/src/lib/jobs/access.ts`), so an estimator who made the job or is assigned to it, but does not
  own its field work, fills the form and then gets a refusal (`not_field_owner`). The server is
  right; the screen could show these forms read only.
