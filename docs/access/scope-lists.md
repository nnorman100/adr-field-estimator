# Access matrix: Check Scope lists

Part of [Access matrix](../ACCESS.md).

## Check Scope lists (rebuilt app, S5a-10)
`web/src/lib/scope-lists/`, one handler, `memberRoute`, through the job-access function above. No new capability key, no body, no query: the company is the caller's own from the sign-in.

| Route | Who | Rule |
|---|---|---|
| `GET /api/jobs/{id}/scope-lists` | `jobs_read` (everyone with the job, office included) | What Check Scope picks from: the room types (id, name, and the enabled items each suggests: id, name, unit, whether a room lists it with a typed quantity or it is priced from the room's measurements or the job's counts, and the categories it is priced for) and the items a room may list with a typed quantity (enabled `room:typed` items: id, name, unit) from the job's price version (its pin, else the company's current version; `version: null` and empty lists with none published), and the company's prep-task templates from Company settings. Names and units only, never a price. 503 `prices_unreadable` for a version that does not parse or match its hash. |

Submit (`POST /api/jobs/{id}/submissions`, above) checks the same thing under the job's row lock: a room whose type is not Other and not in that version, or that lists an item the version does not price by a room's typed quantity, aborts the attempt with 409 `unknown_price_ids` (503 `prices_unreadable` when the version cannot be read); a draft naming no room type and no item reads no version. The estimate checks its items again against the version it prices from. A job another estimator owns, or another company's, is 404; an archived job is 410.
