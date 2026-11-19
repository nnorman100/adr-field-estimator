# New job

Part of [Screen specs](README.md). Address: `/field?view=new-job`. Built in:
`web/src/app/field/new-job-view.tsx`. Stages S5a-6, S5b-1.

## Purpose

Start a water or mold loss job from its property address. The phone makes the job id and the first
draft id, so sending again after a lost answer makes the same job, never a second one.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the form, with "Water or mold loss. You can add the customer and claim after." | start a job; goes on to its Check Scope |
| Estimator | the same | the same |
| Office | the form, with "…The job starts empty: you assign an estimator next, and the assigned estimator does the field work…" | start an empty job; goes on to its Job coordination |
| Superadmin support | nothing | nothing |
| Different-company user | only their own company's form; the job is made in the company of the sign-in | nothing here |

A role without `jobs_create` sees "Your role cannot start jobs." (no company role lacks it today).

## States

- Offline: "Needs a connection"; the start button is disabled.
- Sending: "Starting the job…".
- Lost answer: "This job was sent but no answer came back. Try again to finish it." (the same ids
  are sent again).
- Refused: the server's message, and the typed address goes back in its box.

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Start the job | `POST /api/jobs` with `{ id, draftId, propertyAddress }`: the job row first, then its field draft | `jobs_create` |

Rules: `docs/access/jobs.md` ("Jobs routes").

## Not built yet

- Address suggestions (`places`; needs a Maps key, J9 in `docs/plans/S5.md`).
- Customer and claim at intake: entered afterwards on [Customer and claim](customer-and-claim.md).

## Mismatches to check

None found.
