# Status: S5 core workflows (jobs, estimate, signing, office)

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

Nothing here is deployed to production: no live project exists yet (D-018). S5a is not closed until the owner records the real-service checks in `docs/runbook/` (bucket precondition, Submit fence and double submit on Cloud Run, homeowner signing on a real iPhone; #406).

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Core job tables and company profile columns | yes (#338) | no (rebuild not live) | n/a | Migration `0010_core_job_tables` |
| Jobs API and the shared job-access function (S5a-3) | yes (#341) | no (rebuild not live) | n/a | Job access is decided by one shared function |
| Submission, estimate, price pin and agreement tables | yes (#346) | no (rebuild not live) | n/a | Migration `0011_submissions_agreements` |
| Photo receipt and photo read routes (S5a-5) | yes (#351, #400, #458) | no (rebuild not live) | no | Capture time recorded and the photo log ordered by it (#400); the 300-photo limit counts the photos the server stored (#458) |
| Company profile API and Company settings screen (S5a-4) | yes (#365) | no (rebuild not live) | no | Owner only |
| Letterhead fields and document settings (S5a-4b) | yes (#387) | no (rebuild not live) | no | Migration `0013_company_documents` |
| Submit with a fence and Back to editing (S5a-8) | yes (#372) | no (rebuild not live) | no | A repeated or racing submit makes one record |
| Job screens on the phone (S5a-6) | yes (#373) | no (rebuild not live) | no | Jobs, New job, Check Scope, Customer and claim, Photos |
| Estimate, documents and Review screen (S5a-9) | yes (#381) | no (rebuild not live) | no | Prices the submission from the job's pinned price version |
| Photo audit log grouped by shot tag or room (S5a-9c) | yes (#392) | no (rebuild not live) | no | Company setting `photo_log_grouping` |
| Room inputs and item list on Check Scope (S5a-10) | yes (#393) | no (rebuild not live) | no | Field map v2 |
| Proposal layout options, itemized or letter, with company clauses | yes (#396) | no (rebuild not live) | no | |
| Sign on the phone with a locked signed record (S5a-11) | yes (#390) | no (rebuild not live) | no | Signed records are immutable |
| Remote signing links and document links (S5a-11b) | yes (#397) | no (rebuild not live) | no | Migration `0014_signing_links` |
| Bounded field draft ids, room order entries and Submit reads | yes (#402) | no (rebuild not live) | n/a | Firestore rules id checks |
| Office jobs, estimator assignment and field owner (S5b-1, server) | yes (#409, #470) | no (rebuild not live) | n/a | Migration `0015_office_jobs`; a missing current draft is rebuilt at Start field work and the owner move (#470) |
| Office job screens, assign estimator, coordination and Start field work (S5b-1) | yes (#427, #466) | no (rebuild not live) | no | Unsent prep-task and new-room text kept across owner transfers (#466) |
| Archive, restore and copy jobs (S5b-2) | yes (#430 server, #440 screens, #469) | no (rebuild not live) | no | Archived screens stay read only and a refused job list clears addresses (#469) |
| Bounded email check and capped jobs request bodies (security F2) | yes (#434, #465) | no (rebuild not live) | n/a | |
| Each field draft id bound to one job (security F1) | yes (#435) | no (rebuild not live) | n/a | Migration `0016_job_drafts` |
| Room Add and Remove built from a cache re-read under the room-write guard | yes (#471) | no (rebuild not live) | no | Owner phone check suggested in the PR: remove a room on a near-limit job and reopen Check Scope |
