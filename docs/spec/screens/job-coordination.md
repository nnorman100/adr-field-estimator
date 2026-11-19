# Job coordination

Part of [Screen specs](README.md). Address: `/field?job={id}&view=coordination`. Built in:
`web/src/app/field/coordination-view.tsx`. Stage S5b-1.

## Purpose

The office side of a job: who owns its field work, which estimators are assigned, moving the field
work (owner only), and the office notes. Stored on the server, so it needs a connection. Each write
keeps its ids on the phone until answered, so a retry is the same request, never a second
assignment or move.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the tab and the whole view | assign and unassign estimators; Move field work to themself ("Me (company owner)") or an assigned estimator, while the job is not signed or archived; edit the office notes |
| Estimator | no tab; if the address is typed, "Job coordination is kept by the office and the company owner." | nothing (the route answers 403) |
| Office | the tab and the whole view | assign and unassign estimators; edit the office notes; no Move |
| Superadmin support | nothing | nothing |
| Different-company user | nothing: 404 | nothing |

The tab shows for `coordination` or `assignment` (`job-screens.tsx`); Move for
`field_owner_transfer`; Unassign and Assign for `assignment`; the notes are editable for
`coordination` (`coordination-view.tsx`). The estimator who owns the field work cannot be unassigned
from here (no Unassign button for them).

## States

- Loading: "Reading job coordination…".
- Offline: "Needs a connection".
- Load error: the message with "Try again".
- Field work: "{name} owns the field work." or "Nobody has started the field work yet. The first
  assigned estimator to start it owns it."
- No assignment: "No estimator is assigned yet."; every active estimator assigned: "Every active
  estimator is assigned to this job."
- Unanswered write: "A move of the field work / Assigning an estimator / Unassigning an estimator /
  Saving the notes was…" with "Send the unanswered change again". A move can also answer 503 ("Saved,
  but the field work could not be updated just now. Try again."): the move is committed on the server
  but the draft does not name the new owner yet. The owner can send the same move again, or the
  person moved to (an estimator, or the owner moving it to themself while the existing draft still
  names the former owner) can open Check Scope or Photos and use "Start field work" to finish it
  ([Check Scope](check-scope.md) lists every trigger of that prompt and which ones Start can repair:
  this recovery finishes a move onto an existing draft, and it cannot make a job's first draft).
- Done: "The field work was moved.", "The estimator was assigned.", "Notes saved.".

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Read the view | `GET /api/jobs/{id}/coordination` | `coordination` or `assignment` |
| Save the office notes | `PUT /api/jobs/{id}/coordination` | `coordination` |
| Assign an estimator | `POST /api/jobs/{id}/assignments` | `assignment` |
| Unassign an estimator | `DELETE /api/jobs/{id}/assignments/{assignmentId}` | `assignment` |
| Move field work (a 503 after the move is saved is finished by sending it again, or by the new owner's Start field work recovery, including the owner's move to themself; Start does not make a first draft that was never made) | `POST /api/jobs/{id}/field-owner/transfer` | `field_owner_transfer` |

Rules: `docs/access/jobs.md` ("Office jobs routes"), owner decision J5 (`docs/plans/S5.md`).

## Not built yet

- Recording a signed job's close (final invoiced amount, actual drying days) and drying-watch state
  (S5b-10).
- Approvals of added work and change orders (S5b-8, S5b-9).

## Mismatches to check

None found.
