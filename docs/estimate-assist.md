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

A table on `assist.range_method = uncertainty` builds its high end from what could actually change on the job, instead of a flat percentage. This is the calculation itself, so it has no rollout switch: a pinned table prices the same way every time. Its editor fields come with the price editor (`PRICE_BOOKS_ENABLED`). The formulas are in [Pricing source](pricing-source.md#range-from-real-uncertainty).

**What the high end prices.**

- Air movers at the S500 maximum for the stated wet floor areas, or the entered count when that is higher.
- Dehumidifiers at the recommended units, or the entered count when that is higher.
- The planned drying days plus `assist.extra_drying_days`.
- Labor and materials with `assist.hidden_damage_percent` added. An area line carries the percent of its room's category. A line with no area, such as labor hours, carries the largest percent among the job's rooms.

The low end, job charges, approved additional work and every other line are the same in both amounts.

**When the check cannot size a count, that count stays as entered.** A room missing its floor area, ceiling height or water class turns the whole check off, so a room added without them lowers the high end's equipment until they are stated. The readiness check already asks for them. A wet-walls-only room leaves air movers unsized, and no AHAM rating leaves dehumidifiers unsized (decision D5).

**Who gets which method.**

| Table | Method |
| --- | --- |
| Starter list for a new company | Uncertainty: 10 / 15 / 25% hidden damage for categories 1 / 2 / 3 and 1 extra drying day (decision D3) |
| Mapped from a rate book at the switch | Cushion, so its numbers match the rate book |
| Published before the `assist` map existed | Cushion, unchanged to the cent |
| `adr-residential-v1` | Untouched |

The owner chooses under **Estimate assist** in the price editor. Choosing the uncertainty method hides the **Range cushion** box and shows the extra days and the three percents; choosing the cushion does the reverse. One-price mode hides all of them, and no high end is calculated for printing. A change to the method or a percent counts as a large change in the publish review.

**What the documents say.** `EstimateSummary` has no new field. `range_explanation` carries one sentence that names the counts, days and only the categories on the job. The sentence is left out when nothing separates the two amounts. No AI is involved.

**Merge order.** Starter tables have carried `range_method = uncertainty` since section 1, and they priced from the cushion until this section. Merge this before `PRICE_BOOKS_ENABLED` goes on, so no table is published under the old reading.

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

Advisory warnings on an unsigned draft. `backend/estimate_warnings.py` works them out on every read, like `equipment_sizing`, when `AI_FEATURES=estimate_assist` is on. They are never stored and never reach a document, a signing link or a model. They never change `signable`, the proposal hash or a signing rule, and they name no amount.

| Code | When | Needs |
|---|---|---|
| `air_movers_below`, `air_movers_above` | The IICRC sizing check flags the count. The text is the check's own reason. | The check to be available |
| `dehumidifiers_below`, `dehumidifiers_above` | The same, for dehumidifiers | The check to be available |
| `unpriced_room` | A room with area whose category no enabled, priced, room-measured item covers | A company table |
| `unpriced_quantity` | A job number above 0 with no enabled item on the table, or a saved quantity for an item the table no longer lists. A saved item at 0 is left out, because nothing was entered. | A company table |
| `unpriced_extras` | Additional work hours entered on the table's additional work item | A company table |
| `far_from_typical` | The low end is below half or above double the median low end of at least 5 signed jobs with the same highest category and an area within two-thirds to one and a half times this job's. Both ends of that area window count, and two jobs with no area compare with each other. | Saved prices and the company's own signed jobs |

**Who gets what.** A job on a rate book gets the sizing and typical-job warnings. Its form prices every field, so the `unpriced_*` warnings do not apply. A job compares its low end only once it has saved prices: a company-table draft from its first save, a rate-book draft from its first audit. A job that prices nothing yet has no low end, and keeps its other warnings.

**Roles.** They come with the draft read, under `jobs_read` and job access, so owners, office staff and the estimator on the job read them. Only people with `scope` see the dialog. Read-only superadmin support and signed records carry none. A failed read of the saved prices or the history leaves the list empty and never fails the draft read.

**On the phone.** **Ready to review?** gains **Check before you finish**, each warning with **Fix**. The dialog opens for a new gap or a new warning. A warning that was already listed stays acknowledged, like a gap. With `readiness` off the same dialog opens for warnings alone. While the draft has unsaved changes the section says **Warnings update once the draft saves.** instead of listing older numbers. Offline it also shows the last saved warnings, because the phone keeps the saved record. The review screen repeats the texts in the same box as **Unpriced work**. That box never prints.

**What Fix opens.**

| Warning | Fix goes to |
|---|---|
| Sizing | The air mover or dehumidifier input |
| `unpriced_room` | The room's category |
| `unpriced_quantity` | **Not in the current price list** |
| `unpriced_extras` | **Additional work**, or the item list when that panel is off |
| `far_from_typical` | The rooms |

**The thresholds are fixed constants** (decision D8), and the comparison uses at most the 300 rows of section 3's history.
