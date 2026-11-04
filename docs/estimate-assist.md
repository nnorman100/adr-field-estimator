# Estimate assist

Four additions to owner-defined price tables. Each section belongs to one pull request, and sections 1 and 2 are built. All four are server arithmetic over data the app already holds: no model supplies a count, a price, a percent or a warning.

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

Not built yet.

## 4. Guard rails while estimating

Not built yet.
