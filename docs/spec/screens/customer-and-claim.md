# Customer and claim

Part of [Screen specs](README.md). Address: `/field?job={id}&view=customer`. Built in:
`web/src/app/field/customer-view.tsx`. Stages S5a-3, S5a-6, S5b-1.

## Purpose

Two forms: Customer (customer name, customer phone, customer email, property address) and Claim (insurance carrier, claim number, policy number, date of loss, cause of loss,
adjuster name, email and phone, deductible). The documents print the customer's name and the property
address; the customer's phone and email are stored in the submitted record but the estimate builder
does not carry them into the documents (`web/src/lib/estimates/inputs.ts`). Every field of the claim
that is filled in prints in the scope defense letter: the insurance carrier and the adjuster's name,
email and phone in its addressee block, and the claim number, policy number, date of loss, cause
of loss and deductible in its reference block (`addressee`, `claimReference` and the letter in
`web/src/engine/documents.ts`); the
itemized claim and its Scope JSON export carry the priced line items, not these fields. They are stored on the server (Postgres), not in the
field draft, so they need a connection. Each save carries the job's revision and a change id made
on the phone, so a retry after a lost answer is the same save.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | both forms | save both while the job is unsigned (`scope` or `coordination`) |
| Estimator | both forms, on jobs they made, own or are assigned to; after the app records a move of field work they held, the open job keeps the forms it had loaded, with what was typed, read only, not saved (`moved`), while they switch tabs; leaving the job and reopening it in the same field shell restores the saved values and any pending or refused save, but not text that was typed and never sent; an estimator who was assigned but never held the field work loses the forms on the next refused read | save both only while they own the job's field work and the job is unsigned (`scope`; the server refuses others with `not_field_owner`) |
| Office | both forms | save both while the job is unsigned (`coordination`) |
| Superadmin support | nothing | nothing |
| Different-company user | nothing: 404 | nothing |

On a fresh online page, an estimator who still has job access sees the forms; one who lost it (404,
for example unassigned from a job they did not make) gets no forms. Only the same field shell that
recorded a move of field work they held keeps the forms read only: unsent typing only while the job stays open, saved values and pending or refused saves also when it is reopened ([Check Scope](check-scope.md)).

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
