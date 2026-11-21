# Operator: a company's jobs and one job

Part of [Screen specs](README.md). Addresses: `/operator/{tenantId}/companies/{companyId}/jobs` (the
jobs) and `/operator/{tenantId}/companies/{companyId}/jobs/{jobId}` (one job). Built in:
`web/src/app/operator/[tenantId]/companies/[companyId]/jobs/page.tsx`, `support-jobs-screen.tsx`,
`jobs/[jobId]/page.tsx`, `support-job-screen.tsx`; words in `web/src/lib/operator/screens.ts`;
calls in `web/src/lib/operator/client.ts`. Stage S5b-5 (server slice, then these screens). Reached
from [Operator: one company](operator-company.md), section Jobs, "Open the jobs view".

## Purpose

A read-only support view of one company's jobs, so the operator can help the company by phone: the
list of its jobs (archived ones too), and one job's record, customer, claim, signed agreement and
evidence (photos, full-size originals and the signature of a committed agreement). Nothing can be
changed here: there is no edit control, and no archive or restore (owner decision B, 2026-11-19; the
operator asks the company owner, who holds `jobs_archive`).

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner, estimator, office | the operator sign-in only (a malformed tenant id answers 404; for a well-formed one the operator API answers 403 `not_an_operator` and the sign-in is dropped) | nothing |
| Superadmin support (platform operator) | Jobs: "{company}: jobs" ("Read-only support view. Company status: {status}. Opening this list, each job and each photo is recorded in the audit log. To archive or restore a job, ask the company’s owner."), each job's address (a link), customer and "{status} · started {date}"; one job: its address, Status, Revision, Started, Last changed, and the sections Customer, Claim, Signed agreement (who signed, when, how, the proposal hash, the proposal, the itemized claim, the scope defense letter and the photo audit log as read-only lines, or "Not signed."), Evidence (each photo, original or signature with its type, size, time and SHA-256) | read only; "Show more jobs" for the next page; one image per Evidence row ("Show photo {n}" with the number the photo has in the signed photo log; "Show photo outside the signed log (received {n})", "Show full-size original (received {n})", "Show signature (received {n})" by receipt order), in the Evidence list only |
| Different-company user | the same as a company role | nothing |

The server writes one audit row for each page of the list, each job opened and each image shown, so
each page is read once per opening, the next page only on "Show more jobs", and an image only on its
"Show" button. A job of another company named under this company's address is answered not found.

## States

- Unknown company or job id (not an id): "Company not found" or "Job not found".
- Loading: "Loading the jobs…", "Loading the job…"; refused: the server's reason or "That job was not
  found in this company."; a refusal that ends the sign-in removes the screen and asks for a new
  sign-in (the operator session); no answer at all: "Needs a connection. Check the signal, then open
  this page again."
- Online only: "These views need a connection." on both screens, and "Needs a connection" while the
  phone cannot reach the app; a read with no answer says "Needs a connection. Check the signal, then
  open this page again."
- A read or an image the server refuses because the sign-in ended or the operator's access was
  turned off signs the operator out and draws no company data.
- Empty: "No jobs yet.", "No photos or signature.", an empty detail reads "Not entered".
- An image that cannot be read: "The photo could not be opened. Try again in a minute."
  With no connection it says "Needs a connection. Check the signal, then try again."

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Read the jobs, a page at a time | `GET /api/platform/companies/{id}/jobs?cursor=…` | platform operator; audit `support_jobs_viewed`, one per page |
| Read one job | `GET /api/platform/companies/{id}/jobs/{jobId}` | platform operator; audit `support_job_viewed` |
| Show one image | `GET /api/platform/companies/{id}/jobs/{jobId}/photos/{photoId}?kind=photo\|original\|signature` | platform operator; audit `support_photo_viewed` |

Rules: `docs/access/superadmin.md` (`support_jobs_view`).

## Not built yet

- Archive or restore by the operator: dropped by owner decision B (2026-11-19, S5b-5).

## Mismatches to check

None found.
