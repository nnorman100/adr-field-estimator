# Estimate assist

Four additions to owner-defined price tables. Each section belongs to one pull request, and says so if it is not built yet. All four are server arithmetic over data the app already holds: no model supplies a count, a price, a percent or a warning.

## 1. Suggested counts and the assist settings

`AI_FEATURES=estimate_assist` is the rollout switch for the suggestions. It is off by default. `/api/session` lists it in `ai_features` when it is on.

**The rule (`sizing.suggested_counts`).** Only when the IICRC sizing check is available:

- An air mover count below the S500 minimum is raised to the minimum. A room with wet walls only is not sized for air movers, so there is no suggestion.
- A dehumidifier count below the recommended units is raised to that number. With no AHAM rating there is no number and no suggestion.
- A suggestion never lowers a count and never touches a count at or above the number.

**Fill scope from walkthrough.** `POST /api/inspections/{id}/scope-suggestions` adds `suggested: [{field, value, basis}]`, worked out on the job as the fill leaves it. The list is empty unless the flag is on and the draft itself prices on a company table. These stay out of it:

- a count the technician spoke in this fill, including one already on the form;
- a count explained with a reason, so rereading never undoes it;
- a count the job's table does not list, because the form has no input to correct it.

A count an earlier fill or tap set has no reason, so it rises again when the rooms grow.

The model never sees or produces these values.

**Use suggested counts.** The button under the sizing check applies the same rule to the numbers on the server's record, and leaves a count explained with a reason. It shows only when the check describes the saved draft, the phone is online, the job is on a company table, the flag is on and the person has `scope`. A job on a rate book keeps its form, its fill and its sizing card.

**Recording.** A suggested count is stored in `quantity_overrides` with `measured` and `entered` at the suggestion, like a walkthrough value. Changing it later needs the same short reason, which the server enforces and the owner sees. The fill and the button both mark it **From sizing check** with an Undo, which puts back the earlier count and the record it replaced. The basis sentence is shown on the phone and is not stored.

**The `assist` policy map.** `assist.drying_days` is what a new job starts at, on the phone at New job and on the server for office-created jobs. It is not recorded as a measured value, so changing it needs no reason. The owner edits it under **Estimate assist** in the price editor's settings. The map is optional and absent-safe. See [Company prices](company-workspaces.md#company-prices).

## 2. The range from real uncertainty

Not built yet. Until it ships, every table prices its high end from the range cushion, whatever `assist.range_method` says.

## 3. Job close and estimate accuracy

Nothing here changes a signed record, a document, a signing link or the model prompt, and nothing is applied until the owner publishes it.

**The history (`_estimate_history/{company_id}`).** One private document per company with a `rows` map keyed by job, at most 300 rows. Past that, the row with the oldest `signed_at` goes, but never the row being written. Each signature adds its row inside the signing transaction, with the flag on or off: the signed low and high, the area on the job's basis, the highest category, whether every room shares it, the low end's labor-and-material total and the planned days. A job signed earlier, or trimmed since, gets its row when it closes. A signature never fails because that total could not be worked out; the job then stays out of the overrun.

**Closing a job.** `POST /api/jobs/{id}/close` takes `final_amount` (dollars and cents, 0.01 to 2,000,000.00), `actual_days` (0 to 365, or null), `note` (up to 300 characters) and `expected_signed_at`. It needs `coordination`, a signed job and a connection, and the app never queues it. Closing again overwrites the record. Each close writes a `job_closed` audit entry with the job and where it landed, and no amount.

| Estimate | `landed` |
|---|---|
| Range | `inside` when low ≤ final ≤ high; `below` under the low; `above` over the high |
| One price | `inside` at or under the price; `above` over it |

`GET /api/jobs/{id}/outcome` returns the record and the prefilled days: the drying watch's day number when `drying_watch` is on and monitoring has finished (`dry_standard_met`, `marked_dry`, `closed`), otherwise the signed plan. An estimator on the job reads only whether it closed and when.

**The numbers.** `GET /api/companies/{id}/estimate-accuracy` is for the owner (`prices_manage`), which also means price books are on. It counts where closed jobs landed, then works out two figures per job:

- overrun: `max(0, final − low) / labor_material_low`, for jobs with labor and materials;
- extra days: `max(0, actual − planned)`, for jobs with actual days.

**Suggestions.** Each uses the nearest-rank 80th percentile, the smallest value that covers 4 of 5 jobs, and needs at least 5 qualifying jobs. Otherwise the value is null and the count is shown.

| Setting | Method | Jobs | Value |
|---|---|---|---|
| `assist.hidden_damage_percent.{c}` | uncertainty | closed, every room category `c` | overrun as a percent, up to the next 5, at most 100 |
| `assist.extra_drying_days` | uncertainty | closed, with actual days | extra days, at most 30 |
| `range.first_percent` | cushion | all closed | overrun as a percent, up to the next 5, at most 100, and never below `range.beyond_percent` |

A table refuses a `first_percent` below its `beyond_percent`, so the server holds the cushion suggestion at the published `beyond_percent` and the page says so. **Use suggestion** holds it at the working copy's value when an unpublished edit raised it further.

The overrun is a coverage number. It counts everything that raised the invoice above the low end (hidden damage, more equipment, approved extras, more days), and the page says so. A company on a rate book gets the hit rate and day numbers, with `suggestions: null` and `reason: 'rate_book'`. A company that prints one price gets `reason: 'single_price'`, because these settings only shape a high end it does not print.

**On the phone.** `public/job-close.js` is the **Job close** card on a signed job's Check Scope and Review, for owners and office staff. `public/estimate-accuracy.js` is the dashboard card and the section on the Prices page. **Use suggestion** writes into the working copy like a typed change, so the normal **Unpublished changes** and review apply. All of it needs a connection and says so.

## 4. Guard rails while estimating

Not built yet.
