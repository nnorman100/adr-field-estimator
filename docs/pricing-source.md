# Pricing source

Each company sets its own prices. DryScope has no default price list, and one company's rates are never used for another. Prices and totals come from the server in Decimal; a model never supplies a price.

Two pricing engines exist while the app is rebuilt. The rebuilt app's engine is `dryscope-v3`, below. The old app (`backend/`, retired in S8) prices on `adr-residential-v1` and `dryscope-v2`, described under [The old app](#the-old-app-backend-until-s8).

## The rebuilt app (`web/`, engine `dryscope-v3`)

The engine is in `web/src/engine/` and is a library for now: no route or screen calls it yet (the price tables, Prices API and pins come in later steps of the [pricing plan](plans/pricing.md)). Its entry points are in `estimate.ts`:

- `priceEstimate(table, job)` prices a saved draft from a published table: plain JSON in and out, money as Decimal strings. It returns the lines, both ends of the range, the warnings, `engine_version: "dryscope-v3"` and `table_sha256`, the SHA-256 of the parsed table's canonical JSON with items in id order. A refusal names its stage (`table`, `inspection`, `pricing` or `documents`).
- `checkTable(table, acknowledgements)` is the publish check: a blank price on an enabled item blocks publishing, and a zero price needs the item's `allow_zero` and its id or code in `acknowledgements`.

The table is one Zod schema, `PriceTableV3` in `table.ts`, used by every caller. Prices, percents and multipliers are Decimal strings; an unknown key is refused. Once a signed job uses an engine version, that version's formulas never change; new formulas get a new version.

### Categories

A room's `category` is `1`, `2` or `3` (water Category 1 to 3) or `"mold"`. An item's `categories` filter lists the categories it applies to, from the same four; an empty filter means every category, Mold included. The filter decides whether a room gets a line for the item; rows only decide its price.

### Which price a room line uses

Every item has a required **default row**: its `unit_price`, or its own `price_brackets`. An item may also carry `rows`, each naming one category with a `unit_price` or its own `price_brackets`:

```json
{ "item_id": "drywall_removal", "unit_price": "2.00",
  "rows": [{ "category": 3, "unit_price": "5.00" }, { "category": "mold", "unit_price": "4.00" }] }
```

For each room, the row naming the room's category wins; otherwise the default row prices it.

| The room | Priced by | Multipliers |
| --- | --- | --- |
| Has a row of its category | that row, used as set | none: no category multiplier and no cabinetry multiplier |
| Water room (Cat 1, 2, 3) without one | the default row | the category multiplier, and the cabinetry multiplier in a Cat 3 room with custom cabinetry (finished work, or all work when the scope is `all_cat3`) |
| Mold room without one | the default row | none |

So an owner who types a Cat 3 price gets exactly that price, even in a custom-cabinetry kitchen. A line priced by a row names it, for example "Kitchen, Cat 3: Drywall removal"; a default-row line reads "Kitchen: Drywall removal".

The schema allows at most one row per category (four in all), only categories the item's filter allows, and rows only on items priced per room (`room:` quantity sources), because a job-level line has no room and so no category. A row's brackets follow the default row's rules: square-foot items only, limits rising, the last band open-ended. A blank row price blocks publishing like any blank price, and a zero row price needs `allow_zero` and the owner's confirmation. Rows are stored in category order (1, 2, 3, Mold), so the order they were written in does not change the content hash, and an empty `rows` list is the same table as none.

### Brackets count per row

- **Tiered** (the default): only the rooms a row priced count toward that row's bands, dearest rooms first; the default row's bands count only the rooms the default row priced. A bracketed row's lines round on that row's cumulative amount. Counting square feet across rows could lower a total when square feet are added (a Cat 1 row at $0.10 growing by 100 sq ft would push a Cat 3 row's 100 sq ft from $10.00 into a $1.00 band, $890.00 less), so it is not done.
- **Whole-job**: the job's total square feet (each room once at the largest area figure its priced square-foot items read, plus square feet typed without a room, before waste) picks the band in each row's own list, as in [Owner square-foot brackets](sqft-brackets.md). Whole-job can price a job just above a band boundary lower, by design.

### Mold rooms elsewhere

- Under the uncertainty method, a Mold room carries the category 3 hidden-damage percent (`assist.hidden_damage_percent["3"]`), and the range sentence names it as "category 3 or mold rooms".
- Unless the room states its loss type, the IICRC drying-equipment check treats a Mold room as a mold loss and skips it, as it already did a Cat 3 room.
- A Mold room that no item prices is named in the advisory warning as "mold work".

### What `dryscope-v3` keeps from `dryscope-v2`

Everything else follows the rules described for `dryscope-v2` below, in Decimal: lines (`quantity x price x (1 + waste / 100)`, rounded to the cent half up, once), a room's own waste over the item's, the three buckets, the cushion over the dearest square feet or the uncertainty high end, the after-hours adjustment, the minimum job charge, overhead and profit, sales tax on the taxable share, the single-price mode and the $0.00 guard. A table with no rows, priced for rooms with no Mold category, prices exactly as `dryscope-v2` did. The rebuilt app has no `adr-residential-v1`, no ADR rates in code and no switch from a rate book (D-017). Room types, room-size tiers and per-room items (S4-4b), and per-item after-hours, no-O&P and materials-share flags with per-trade minimums (S4-4c) are not built yet.

### Tests

Hand-worked examples, each with its arithmetic in a comment: `web/tests/unit/estimate-worked-examples.test.ts` (quantity, waste, eligibility, multipliers, brackets, range, minimum, overhead and profit, tax, after-hours, publish checks, rounding) and `web/tests/unit/estimate-category-rows.test.ts` (each precedence step, Mold rooms, each bracket mode with rows, row schema rules). `web/tests/unit/estimate-properties.test.ts` scans seeded random tables and jobs, with and without rows and Mold rooms: in tiered mode adding square feet or a quantity never lowers either total; the high is never below the low; each total equals its lines and adjustments; the same table gives the same hash.

## The old app (`backend/`, until S8)

The rest of this page describes the old app's pricing, which the Python backend still runs until it is retired in S8.


- **A company with no published prices cannot price an estimate.** The audit answers 409 and the job stays a draft. The owner is told "Set your company prices before your first estimate", with a Set company prices button while the editor is on; estimators and office staff are told to ask the owner.
- **Owners publish prices under Company prices** (behind `PRICE_BOOKS_ENABLED`), or import the CSV/XLSX template. The template for a company without prices lists item names and units with blank prices; `version_id=starter` on the export route gives the v2 starter catalog in the same blank form. See [Company workspaces](company-workspaces.md#company-prices). While the flag is off the editor is unavailable, so a company other than ADR cannot set prices; that page says when the flag may be turned on.
- **The browser gets prices only from the API,** for the signed-in company. No rate is written in `public/`; `tests/test_no_adr_default.py` checks that.
- **Rates live on the server as data:** a published book is stored per company, and each job pins one book: a v2 draft at its first server save, a v1 draft at its first audit. A published book applies to new pricing from the server's publication time. An existing draft keeps its saved rates until the owner reviews and applies new prices to that one draft. Signed records never change.
- **Formulas, waste and range factors, default quantities and mandatory wording stay in code** (`backend/claims.py`) for now on `adr-residential-v1` books, under `CALCULATION_VERSION`. An owner-defined `dryscope-v2` table is a separate model that holds its own items and settings.

ADR's rates are ADR's proprietary data. They sit in `backend/adr_price_book.py` and ADR's own price-book record, are used only for company `adr`, and their source notes are in [ADR pricing source](adr-pricing-source.md). `scripts/migrate_price_books.py` writes them as ADR's book and refuses any other company; see [ADR price book](../RELEASES.md#adr-price-book). An older book or unsigned draft in another company that holds ADR's rates is refused rather than used; signed records stay viewable.

For pricing work outside the catalog and its treatment in the estimate range, see [Priced additional work](priced-extras.md).

Each job's saved prices record a calculation version, and that version selects the formulas used to price the job (`POLICIES` in `backend/claims.py`, `CALCULATION_FACTORS` in `backend/price_books.py`). `adr-residential-v1` and `dryscope-v2` are the versions with formulas, and `backend/pricing.py` chooses between them. Audits, additional-work approvals and reprice price a job from the table pinned to it (see [Documents from a company price table](#documents-from-a-company-price-table-calculation-dryscope-v2)). A version's formulas never change once saved prices use it, so existing drafts and signed documents keep their numbers; new formulas get a new version. An unknown version is refused, never priced with another version's formulas.

### Company-defined tables (`dryscope-v2`)

A company on calculation version `dryscope-v2` prices from its own table: `items` and `policy`, pinned to the job (see [Company workspaces](company-workspaces.md#company-prices)). Documents already priced on `adr-residential-v1` keep that calculation and their numbers. `backend/pricing_v2.py` holds this calculation. All math is `Decimal`; a model never supplies a price.

**Lines.** Each enabled item with a price makes lines from its `quantity_source`. Room sources make one line per room matching the item's `categories`; the unit price is multiplied by the room's category multiplier, and by the cabinetry multiplier for a category 3 room with custom cabinetry when the source is `room:demolition:finished` or the scope is `all_cat3`. A room's own waste wins over the item's when it is above zero. `policy.area_basis` sets what a `room:basis` item prices: `demolition` and `demolition_with_waste` read unfinished plus finished, and `wet_floor` reads the wet floor area (a blank one reads the floor area). Job sources make one line, at the item's price and waste; an item that names `categories` makes it only when a room matches one of them. A line total is `quantity × price × (1 + waste / 100)`, to cents, half up; a zero quantity makes no line. Each approved extra makes one line at its approved rate, taxable when the enabled `extras` item is marked taxable and not taxable when no `extras` item is enabled. The enabled `extras` item is never priced by quantity: it only supplies the hourly rate an owner approves work at, so unapproved hours cannot reach a total.

**Unset job numbers.** An unset job number prices from the item's default quantity, which is 0 when the owner set none; the job model's own defaults never price. A `count_days:` source with either number unset prices the default quantity rather than a product. Because a saved draft stores every number, a saved draft is protected only by seeding new v2 drafts from the company table, which is required before v2 audits are accepted.

**Entered quantities.** `quantity_overrides` holds a walkthrough-filled quantity: what was measured, what is entered now and, once the two differ, the required short reason. Pricing reads the entered number, but an override does not price a room area left blank. Keys name what was overridden: a job number by its field name (`air_movers`, `drying_days`, `monitoring_hours`), or a room area as `<room name>:<field>` (`Kitchen:finished_sf`, with `unfinished_sf`, `finished_sf`, `wet_floor_sf` or `floor_sf`). A typed item's entered quantity is its `scope_items` `quantity`. Saves and audits refuse an override whose key names no such field or room, or whose entered number differs from the job's current value, with a blank room area read as 0 (`check_quantity_overrides` in `backend/contracts.py`). The calculation on its own ignores an unknown key and lists a warning.

**Buckets.** A line's group sets its bucket: job charges, optional services and extras are fixed (`F`), drying equipment is equipment (`E`), and demolition, treatment and labor are labor and materials (`L`). `L_area` is the labor-and-material lines read from a room's area; `L_other` is the rest, such as labor hours.

**The high end.** A table's `assist.range_method` chooses how the high end is built: `cushion`, below, which is also how a table without the `assist` map reads, or `uncertainty` ([Range from real uncertainty](#range-from-real-uncertainty)). With `N = range.first_sf`, `X = first_percent / 100` and `Y = beyond_percent / 100`, `TopN` is the dollars of the `N` most expensive square feet of `L_area`, taking a partial line in proportion:

```
H = round_cents( (1 + Y) × L_area + (X − Y) × TopN + (1 + X) × L_other )
```

At or below `N` square feet this is `(1 + X) × L`, and above `N` the factor falls smoothly toward `1 + Y`, with no step at any size. Because `TopN` is the most any `N` square feet can cost, adding area at any rate, or raising any price, can never lower it. Under `area_basis: demolition_with_waste` each line counts its square feet plus its own waste in `TopN`, so the first `N` fill sooner; `L_area` and every line stay as they are, so waste is charged once and the low total is unchanged. `demolition` and `wet_floor` count each line's own square feet. The uncertainty method does not read `area_basis`. A share of the job's area spread evenly does not have that property: cheap added area would dilute expensive dollars and lower the high.

**Each end.** `LM` is `L` at the low end and `H` at the high end, and `m` is `after_hours.multiplier` on an after-hours job, else 1.

| Summary line | Amount |
| --- | --- |
| Subtotal | `F + E + LM` |
| After-hours adjustment, with the owner's label | `round_cents(LM × (m − 1))` |
| Minimum job charge | `minimum_job_charge − (subtotal + adjustment)`, when that is above zero |
| Overhead and profit, `p` (0 to 100 percent, two decimals) | `round_cents(p × (subtotal + adjustment + minimum))` |
| Sales tax, `t` | `round_cents(t × (T_F + T_E + m × T_L × LM / L) × (1 + p))` |
| Total | the sum of the lines above |

`T_F`, `T_E` and `T_L` are the same sums over lines marked taxable, and `T_L × LM / L` is zero when `L` is zero: the high end taxes the same proportion of labor and materials as the low end. Overhead and profit comes before sales tax, so taxable items carry their own share of it; with overhead and profit off it plays no part in tax. The minimum job charge comes before overhead and profit, which applies to it. The minimum job charge is not taxed.

If the high end's amount before the minimum is still below the minimum, the job is the minimum at both ends and the high equals the low. Otherwise the high has no minimum line. The high is not floored on its own, because adding non-taxable work under the minimum would shrink its taxable share and lower its total with nothing to offset that.

The itemized total printed beside the range is the low total. A single-price company prints the low total as the price and has no high end; `H` is still calculated, so a later switch to a range needs no change to the calculation.

**Rounding.** Each line, `H`, and each summary line round once, to cents, half up, and nothing else rounds. Printed lines always add up to the printed total.

**Guards.** A priced scope of $0.00 is refused with "The priced scope totals $0.00. Enter at least one quantity or room measurement before auditing." before any minimum applies, so a minimum never turns an empty job into a signable one. A line outside the three buckets raises an error rather than vanishing from the range.

**Neither total drops when work is added (flat tables and tiered mode).** Raising any room area, equipment count, day count, labor hour, charge count, approved extra, the after-hours flag or any unit price never lowers the low or the high beyond rounding (two cents at most). `tests/test_pricing_v2.py` scans this over 2,000 random tables and jobs on a fixed seed.

**Explanation text.** `explanation()` builds the paragraph under the amounts from the pinned policy, and `range_explanation()` builds the one sentence naming how the high end is built, such as "The high end allows 50% extra on the first 1,000 sq ft of work and 20% beyond, for hidden damage." Both are server text.

**Advisory warnings**, returned beside the lines and never blocking on their own: `missing_area`, `unknown_scope_item`, `unknown_quantity_override`, `blank_price_item` and `unpriced_extras_quantity` (an enabled `extras` item holds a `scope_items` quantity or a default quantity above zero, which is not priced).

**Sample jobs.** `SAMPLE_JOBS` are three made-up jobs for previews: "Clean-water kitchen leak", "Gray-water main floor" and "Mold remediation, after hours". Each carries the notice "Sample job only. This does not price a saved job." and states every job number and room area, so a default quantity reaches a preview only through a typed-quantity item, which the sample cannot state. A starting quantity on such an item raises every sample it applies to.

### Square-foot price and cushion brackets

Owners can choose tiered brackets (default) or whole-job brackets for area-item prices and the cushion. Tiered prices charge each band separately; whole-job prices may drop at a boundary. Existing tables without brackets keep the calculation above. See [Owner square-foot brackets](sqft-brackets.md) for formulas, rounding, boundary previews, CSV/XLSX, immutable pins and document fields.

### Range from real uncertainty

When `assist.range_method` is `uncertainty`, the low end and every summary rule above are unchanged, and the high end prices what could actually change on the job. It uses no model. The cushion settings are stored but unused. The owner's reasons and the rollout are in [Estimate assist](estimate-assist.md#2-the-range-from-real-uncertainty).

**High-end job numbers** (`high_numbers`), from the IICRC sizing check (`backend/sizing.py`):

```
air movers    = max(entered, S500 maximum)       when the check is available and air movers are sized, else entered
dehumidifiers = max(entered, recommended units)  when the check is available and a rating is stated, else entered
drying days   = entered + assist.extra_drying_days
```

"Entered" is the number the low end prices, so an estimator's override counts.

**Equipment.** The same enabled items make the same lines at those numbers, wherever a `field:` or `count_days:` source reads them. `E_high` and `T_E_high` are the equipment-bucket totals of those lines. A count entered as 0 can make a line that appears only at the high end. A job number left unset keeps its item's default quantity at both ends. Every other bucket keeps its low lines, whatever its source reads.

**Labor and materials.** With `p_c = assist.hidden_damage_percent[c] / 100` for a room of category `c`, and `p_top` the largest `p_c` among the job's rooms:

```
H        = round_cents( Σ area lines total × (1 + p_c)  +  L_other × (1 + p_top) )
T_L_high = Σ taxable area lines total × (1 + p_c)  +  T_L_other × (1 + p_top)      (exact, never rounded on its own)
```

**Each end.** The low end is as above. The high end uses the same summary lines with `LM = H`, `E_high` in place of `E`, `T_E_high` in place of `T_E`, and `T_L_high` in place of `T_L × LM / L`, so tax is exact per line rather than a proportion. If `F + E_high + H + round_cents(H × (m − 1))` is below the minimum job charge, the high equals the low. A single-price table prints no high end; `H` and the numbers are still calculated.

**Neither total drops when work is added.** The same rule holds as for the cushion, and for raising any of these: a room's areas or ceiling height, any unit price, the extra drying days, or a hidden-damage percent. `tests/test_pricing_v2_uncertainty.py` scans this over 2,000 random tables and jobs on a fixed seed. The S500 maximum and the recommended units only grow with those inputs, each high line is at least its low line, and a line's percent is never below zero. Two changes sit outside this rule because they make the check unavailable rather than add work: a wet floor area past the floor area, and a new room without its sizing inputs. Either one returns the high end's counts to the entered numbers until it is corrected.

**Explanation text.** `range_explanation()` prints, for the categories on the job:

> The high end allows for up to 4 air movers and 1 dehumidifier for 4 drying days (1 more than planned), the most the IICRC S500 placement recommends for the stated room sizes, and hidden damage of 15% in category 2 rooms.

| Case | Wording |
| --- | --- |
| The check is unavailable | "the equipment counts as entered for 4 drying days" with no S500 clause |
| No extra days | the parenthesis is dropped |
| A count above the check's number, or one it could not size | "the larger of the counts entered and what the IICRC S500 placement recommends for the stated room sizes" |
| A count of zero, with the check available | named, as in "up to 4 air movers and 0 dehumidifiers for 4 drying days" |
| No equipment difference, no extra days and every named percent 0 | no sentence, because the two amounts are equal |

### Switching from a rate book to a table

An owner on `adr-residential-v1` moves with **Switch to v2** (`POST /api/companies/{id}/prices/start-v2`). `price_table.from_v1_rates` maps that company's own 21 rates to items with the same prices and quantity sources, and sets the policy to the rate book's rules: range 1,000 sq ft / 50% / 20%, after-hours x1.2, cabinetry x2 on finished surfaces, demolition area basis, no overhead and profit or tax. A company holding no prices of its own, including one holding ADR's rates, starts from the blank starter list instead.

The pricing oracle that pinned what this code produces for a synthetic corpus is gone: its Python code was deleted on 2026-11-10 (exact price matching with the old app was dropped), and its stored answers in `tests/fixtures/pricing-oracle/` and the TypeScript tests that read them were removed in S4-2 of the pricing plan (`docs/plans/pricing.md`). The rebuild's engine is checked by hand-worked examples instead; the removed files are in git history.

For the same job the table matches the rate book at or below 1,000 sq ft, low and high, after hours included. It differs in three ways, which `price_table.switch_differences` states in plain words on the Switch card, in the review and in a draft's reprice review. The list below is for a table on the cushion, which a mapped table keeps; if the owner chooses the uncertainty method, the first two are replaced by how the high end is built and that labor hours carry the job's hidden-damage percent at every size, and the after-hours line is unchanged (see [Range from real uncertainty](#range-from-real-uncertainty)):

1. The high end tapers above 1,000 sq ft instead of stepping down at 1,001.
2. Labor hours carry 50% at every size. The rate book dropped them to 20% above 1,000 sq ft.
3. The after-hours 20% prints as its own line inside the itemized total. The rate book left it out of that total and added it in the range only.

Publishing records `source: from_v1`, continues the version numbering, and stores `switched_at` and `last_v1_version_id` on the company head. A draft created before `switched_at` with no pin yet prices from that last rate book (ADR's from its starting book if it had published none). Pinned drafts keep their pins. Either kind moves only when the owner applies the table to that draft (`explicit_reprice`), and signed documents never change. A rate book cannot be restored after the switch.

### Documents from a company price table (calculation `dryscope-v2`)

The server prices a job from the table pinned to it (see [Company workspaces](company-workspaces.md#company-prices)), then writes the four documents. The mandatory clauses, the 1978 pre-test notice, findings, signability rules and the photo log are the same as for the rate book; only the pricing text changes.

- **Amount.** `adr_estimate.proposed_cost` is the high end, or the single price when the company prices one amount; `proposed_cost_low` is absent in single mode and `estimate_mode` names the mode. `xactimate_total` is the low total, which includes the after-hours adjustment, minimum job charge, overhead and profit and sales tax. Documents audited on the rate book have none of the new keys and render as before.
- **Summary.** `estimate` carries the lines that add up to each end (subtotal of itemized work, after-hours adjustment under the owner's label, minimum job charge, overhead and profit, sales tax, total), the percents from the pinned policy and one plain sentence under the amounts: the engine's `range_explanation` in range mode, naming the cushion tiers (none when the first tier is 0%) or, on the uncertainty method, the high end's counts, days and hidden-damage percents (none when nothing separates the amounts), or its single-price sentence. The proposal prints it under the amount; the itemized claim prints the low end's lines before its total. Labels: "Price", "Customer estimate range", "Subtotal of itemized work", the owner's after-hours label (default "After-hours adjustment"), "Minimum job charge", "Overhead and profit", "Sales tax", "Total".
- **Letter.** The defense letter reads "Itemized total: $X." In range mode "Customer estimate range: $low to $high." and the range sentence follow; a single price adds nothing, because the total is the price.
- **Lines.** Itemized lines add only the optional `xactimate_code`; the engine's item id, group, bucket, taxable flag and room stay on the server, so no document, link or scope JSON export carries them. The claim shows an Xactimate column only when a line has a code; it is display text and never priced, and the claim's note then reads "Xactimate codes shown where the company entered them. This is not an Xactimate (ESX) file." The owner can also print the lines on the proposal page (`show_line_breakdown`).
- **Quantity overrides.** An estimator's override of a walkthrough-measured quantity (measured, entered, reason) is listed as `quantity_notes`, for the company owner only (`quantity_notes_read`). The API omits that note for estimators, office staff and superadmin support wherever a record is returned (`public_record` in `backend/main.py`). The entered values stay in the job's own data (`quantity_overrides`), visible to roles with job access; support responses remove them (`support_record`), and no link returns job data. Document links and the homeowner signing link remove the note (`link_documents` in `backend/signing_links.py`). The owner reads it on Check Scope, never on the review screen used for in-person signing. Each note names a job quantity, or a room and its area, from the override key the engine reads (`labor_hours`, `Kitchen:finished_sf`).
- **Interface.** `make_documents(..., pin=...)` takes the job's pinned table and calls `pricing.price_and_range`; a v2 price basis without the pin is refused rather than priced as the rate book. The engine returns `totals` with `mode`, `low` and `high` (each `subtotal`, `after_hours`, `minimum_charge`, `overhead_profit`, `tax`, `total`) and `explanation` and `range_explanation`; a missing line key is an error, never a $0 line.
- **Signability.** The rate-book meaning holds: baseline charges (trip, monitoring, haul, air scrubber, HEPA filter, after-hours) and typed items nobody entered do not count as work, and neither do typed job charges. Room area, equipment, labor, optional services, approved extras and other entered typed items do.
- **Document links.** The homeowner's link carries `estimate` in full and, when the owner prints the line breakdown, each line's description, quantity, unit and total in `estimate.lines`; the claim stays out. The adjuster's `estimate` object holds only the low end's amounts, the after-hours label and the percents, so its claim prints the adjustment lines that add up to its total; that object omits the high end and the explanation, and the proposal stays out. The defense letter in the adjuster's set still states the range and the cushion-tier sentence in range mode. No link or signing page receives the owner's pricing: `price_basis` keeps only what identifies the basis (company, version, sequence, content hash, calculation version, priced-at time and item count), without `policy` or `rates` (`link_documents` in `backend/signing_links.py`). Company views keep the full basis.
