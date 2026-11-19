# Job actions: archive, restore, copy

Part of [Screen specs](README.md). Shown under every job view (`/field?job={id}&view=…`) and, for
Restore, on Archived drafts. Built in: `web/src/app/field/job-actions.tsx`. Stage S5b-2.

## Purpose

File away an unsigned job ("Archive job"), put it back ("Restore"), or start a new draft from a
signed job ("Copy to a new draft"). All three need a connection and keep the ids the phone made until
answered, so a retry is the same request.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | Archive on a draft or submitted job; Copy on a signed job; Restore on Archived drafts | all three |
| Estimator | Copy on a signed job they can see | copy; the copy is their own new job and they own its field work |
| Office | Copy on a signed job | copy; the copy has no field owner and opens on Job coordination |
| Superadmin support | nothing | nothing |
| Different-company user | nothing: 404 | nothing |

Archive shows for `jobs_archive` when the job is `draft` or `submitted`; Copy for `jobs_copy` when
the job is `signed` (`job-actions.tsx`). A signed job has no Archive.

## States

- Archive asks first: "Archive this job?" with "Archive job" and "Keep the job".
- Sending: "Archiving the job…", "Restoring…", "Copying the job…".
- Offline: "Needs a connection".
- Stale: "This job changed since it was opened. It is read again: check it, then archive it again."
  and, on the list, "This job changed since the list was read. The list is read again."
- Lost answer: "Try archiving again", "Try restoring again", "Try copying again"; an unfinished one
  says "…this job did not finish: its field work may not be updated yet."
- Archived job: "This job is archived", with a link to Archived drafts for the owner; every other
  job route then answers 410.

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Archive | `POST /api/jobs/{id}/archive` | `jobs_archive` |
| Restore | `POST /api/jobs/{id}/restore` | `jobs_archive` |
| Copy to a new draft | `POST /api/jobs/{id}/copy` | `jobs_copy` |

Rules: `docs/access/jobs.md` ("Archive, restore and copy").

## Not built yet

- Superadmin support archiving or restoring an unsigned draft (S5b-5).

## Mismatches to check

None found.
