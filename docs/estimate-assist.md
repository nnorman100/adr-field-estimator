# Estimate assist

Four additions to owner-defined price tables. Each section belongs to one pull request, and only the first has shipped. All four are server arithmetic over data the app already holds: no model supplies a count, a price, a percent or a warning.

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

Not built yet.

## 4. Guard rails while estimating

Not built yet.
