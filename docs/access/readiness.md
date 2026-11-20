# Access matrix: Ready to review?

Part of [Access matrix](../ACCESS.md).

## Ready to review? (rebuilt app, S5b-11)
`web/src/lib/readiness/`, one read-only handler behind the company's `readiness` switch (`requireFlag`, off by default), through the job-access function. No new capability key: the check is scope work, as Submit is (`scope`), so the owner and the estimator with the job read it and office does not. No body and no query (a query is 400 `invalid_request`); the company is the caller's own from the sign-in.

| Route | Who | Rule |
|---|---|---|
| `GET /api/jobs/{id}/readiness` | `scope` (owner; the estimator who made the job, owns its field work or is assigned it) | The advisory gaps of the job's current editing draft: `{status: 'checked', jobId, draftId, jobRevision, fieldSha256, ready, gaps: [{code, roomId?, count?}], unavailable}`, or `{status: 'unavailable', jobId, reason}` (`not_editing` for a submitted or signed job or a fenced draft, `draft_changed` when the job changed while the draft was read, `draft_unreadable`, `field_unavailable`). Gaps name field keys, claim keys and stable room ids only, never a value, name or note. Reads Postgres (the job, its address, claim, price version's area basis and stored photo ids) and the field draft; writes nothing, no audit event. `Cache-Control: no-store`. |

Switch off: 404 `not_found` before anything is read. Office: 403 `not_allowed`. A job of another company, or another estimator's job they are not assigned: 404 `not_found`. An archived job: 410 `archived`. A database failure: 503 `readiness_unavailable`. Finish, Submit, the estimate and signing never call this route, and none of its answers holds them up. `GET /api/me` tells the screens whether the switch is on (`features.readiness`); the route checks it again.
