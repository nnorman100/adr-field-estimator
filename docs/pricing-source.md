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

The schema allows at most one row per room type and category, only categories the item's filter allows, and rows only on items priced per room (`room:` quantity sources), because a job-level line has no room and so no category or type. A row's brackets follow the default row's rules: square-foot items only, limits rising, the last band open-ended. A blank row price blocks publishing like any blank price, and a zero row price needs `allow_zero` and the owner's confirmation. Rows are stored in a fixed order (category rows 1, 2, 3, Mold, then each room type's rows by id), so the order they were written in does not change the content hash, and an empty `rows` list is the same table as none.

### Room inputs

Each room carries these inputs, all optional, and the technician confirms them (Live may suggest them):

| Input | Field | Read by |
| --- | --- | --- |
| Category | `category` | which items apply, which row prices them (above) |
| Room type | `room_type_id` | the suggested item list; room-type rows when the setting is on. No type means Other |
| Size tier | `size_tier` (`s`, `m`, `l`, `xl`) | per-room items. When blank it comes from the floor area and the owner's limits |
| Water class | `water_class` (1 to 4) | equipment suggestions only. It is not a price axis |
| Mold condition | `mold_condition` (1, 2 or 3, S520) | which mold items apply |
| Affected square feet | `affected_sf` | which containment item applies |

### Per-room items and size tiers

An item priced per room has `unit: "room"`, `quantity_source: "room:each"` and `tier_prices` (`s`, `m`, `l`, `xl`) instead of a `unit_price`. It makes one line of quantity 1 for every room the item applies to, priced by that room's size tier, and the line says which: "Kitchen: Contents manipulation (size M)". Tier prices may be blank (a blank blocks publishing) but never fall as the room grows (a larger room never costs less than a smaller one). A category row or room-type row of a per-room item holds its own four prices.

The owner sets where each tier ends in `policy.size_tiers` (`s_up_to_sf`, `m_up_to_sf`, `l_up_to_sf`, rising; XL is everything above). A limit is the largest size in its tier (a 100 sq ft room is S when the S limit is 100). **A new company's limits are blank** (`null`): a table with an enabled per-room item cannot publish until all three are set, and there is no default.

**A room's size is its floor area.** A room has several areas (floor, wet floor, unfinished and finished demolition), and only the floor measures the room itself; the others measure the work in it, so a small room with a lot of demolition stays small. A size the technician confirmed wins. A room with no floor area and no confirmed size gets no line for a per-room item, and the advisory warning says its size is needed. Size tiers never count square feet across rooms, so they are not brackets.

### Mold condition and containment (M8)

A mold item names where it applies with two optional filters, both only on items whose `categories` is `["mold"]`:

- `mold_conditions` (a list of 1, 2, 3): the item applies only to Mold rooms of those conditions. The owner's removal item lists `[3]`, cleaning `[2, 3]`; Condition 1 (normal fungal ecology) gets neither. An item with no `mold_conditions` applies to every condition.
- `affected_bands`: `up_to_10`, `over_10_to_100`, `over_100` square feet (10 and 100 belong to the lower band). The owner makes one containment item per band. Neither filter changes a unit price; they decide which items exist for the room.

A Mold room that lacks the input a filtered item asks about gets no line for it, and the advisory warning names the room once ("its mold condition is needed to price its mold items"). Clearance testing is just another item without these filters.

### Room types and "Price varies by room type"

`policy.room_types` is the owner's list: up to 30, each `{id, name, suggested_items}`, with unique ids and names. **Other always exists** and is the type of a room with none; the owner may list it to give it a suggested item list. A room type is a label with a suggested item list: choosing it on Check Scope pre-fills that list for the estimator to confirm (`suggestedItems` returns the enabled items in the owner's order) and changes no price.

`policy.room_type_pricing` is **off for a new company**. While it is off, room-type rows are kept in the table (so turning it on again loses nothing) but never used, never block publishing and never warn. When on, a row may name a room type, and a room's line uses the most specific matching row:

1. room type and category,
2. room type,
3. category,
4. the item's default row.

With the setting off the order is category, then default. A room whose type is not in the pinned version (removed since, or from an older phone) prices from the rows without a room type, as if it had no type. Only when the setting is on, an advisory warning says so for a room with an unknown type or a type of Other, when an item that applies to it has room-type prices (it does not warn for an item with none). A row's room type must be one in the list or Other. A room-type row is used as set, like a category row: no multiplier. Brackets count per row, so a room-type row's bands count only the rooms it priced.

### Equipment suggestions

`suggestEquipment(inspection)` (in `estimate.ts`) is a pure function of each room's water class, floor area, ceiling height and wet floor area, and the job's dehumidifier rating: the IICRC S500 air-mover range, and dehumidifier pints per day from room cubic feet divided by the LGR factor for the class, with a unit count when a rating is set. A room missing an input says what it needs; a Mold room is skipped. It prices nothing: the technician confirms or changes the counts on Check Scope, and only the confirmed counts are priced.

### Brackets count per row

- **Tiered** (the default): only the rooms a row priced count toward that row's bands, dearest rooms first; the default row's bands count only the rooms the default row priced. A bracketed row's lines round on that row's cumulative amount. Counting square feet across rows could lower a total when square feet are added (a Cat 1 row at $0.10 growing by 100 sq ft would push a Cat 3 row's 100 sq ft from $10.00 into a $1.00 band, $890.00 less), so it is not done.
- **Whole-job**: the job's total square feet (each room once at the largest area figure its priced square-foot items read, plus square feet typed without a room, before waste) picks the band in each row's own list, as in [Owner square-foot brackets](sqft-brackets.md). Whole-job can price a job just above a band boundary lower, by design.

### Mold rooms elsewhere

- Under the uncertainty method, a Mold room carries the category 3 hidden-damage percent (`assist.hidden_damage_percent["3"]`), and the range sentence names it as "category 3 or mold rooms".
- Unless the room states its loss type, the IICRC drying-equipment check treats a Mold room as a mold loss and skips it, as it already did a Cat 3 room.
- A Mold room that no item prices is named in the advisory warning as "mold work".

### Item flags, trade minimums and the materials share (S4-4c)

Four optional item keys and one table key, all left out of the parsed table when they are at their default, so a table without them is the same table, with the same content hash, as before.

| Key | Meaning |
| --- | --- |
| item `after_hours: true` | On an after-hours job, `policy.after_hours.multiplier` applies to this item only. Without the flag an after-hours job adds nothing to the item. Only demolition, treatment and labor items can carry it, never drying equipment or job charges (M5). |
| item `no_overhead_profit: true` | Overhead and profit is not charged on this item, and it carries no share of overhead and profit into its tax. Overhead and profit stays off unless `policy.overhead_profit_percent` is above 0, and is its own line when on (M6). |
| item `materials_share_percent` | For a taxable item only: the part of its line, 0 to 100 with at most two decimals, that sales tax applies to. Without it a taxable item is taxed whole. A share on an item that is not taxable is refused (M9). |
| item `trade` and table `trades` | A trade heading is `{trade_id, name, minimum_charge}`, up to 30 per table, kept in id order. An item names its heading by id; an unknown id is refused. A minimum of 0 is a heading with no minimum (M7). |
| on the `extras` item | Approved additional work takes the enabled `extras` item's `no_overhead_profit`, `materials_share_percent` and `trade`, as it takes `taxable`. |
| item `xactimate_code` | The optional "matches Xactimate line" note: free text up to 80 characters, with the same spreadsheet rules as other text. It is on the itemized claim's line (`itemized_claim` in `priceEstimate`, `xactimate_scope` in the documents) and in no proposal, letter or compliance text (M2). |

**After-hours.** The adjustment is `round((multiplier - 1) x the flagged items' labor and materials)`. At the high end each labor line has its own grown amount, and the flagged, exempt, trade and tax sums are taken from those amounts. The high labor is rounded once, so each line bills its low amount plus the same share of its growth, the share of all labor growth that the rounded high labor bills; a line that does not grow keeps its low amount, and no sum falls below the low end's. On the cushion a line grows by the same rules as the high labor: its own dearest square feet at their band's percent and the rest of its area at the later percents, labor that is not read from an area at the first percent, and every line at the job's one percent in whole-job mode. Under the uncertainty method each line grows by its own room. The adjustment is rounded once for each group of items (each trade heading, the exempt items, and the rest), so with no headings and no exempt items it is one rounding, as before. A table that flags every labor item, with no trade headings and no exempt items, charges exactly the after-hours adjustment `dryscope-v2` charged for the job-wide multiplier; its high-end tax follows the per-line rule below, so it differs from `dryscope-v2` when taxable and non-taxable labor grow at different rates. Both methods tax each grown labor line, so billed, by the formula under **Tax**. Under the uncertainty method this replaces the exact unrounded `T_L_high` of `dryscope-v2`, so W65's high tax is $1.01, not $1.00. The cushion no longer taxes the low end's taxable proportion of the high labor (`T_L × LM / L` under `dryscope-v2`): when taxable and non-taxable labor grow at different rates, that proportion taxed growth in labor that is not taxable. The rate applies once to the whole base and the tax rounds once, as at the low end. Of the existing worked examples only the unflagged case in W62 (the W57 job, demolition taxable, hours not) changes: its high-end tax is $250.00, not $260.00.

**Trade minimums.** A trade is charged its minimum at an end of the range only when that end has a priced item under it, so a line that appears only at the high end can trigger the minimum there. If the trade's lines plus their after-hours adjustment fall short, the difference is added as that trade's own line (`trade_minimums` on each end). Items that are exempt from overhead and profit are neither counted toward a minimum nor able to trigger one; a rental under the same heading is billed on top. Without that rule, more exempt work could lower the total when a minimum binds. The job minimum comes after the trade lines and counts them: `max(0, job minimum - (subtotal + adjustment - exempt items + trade lines))` is the job minimum line, and overhead and profit applies to the trade and job minimum lines as it already did to the job minimum. At the high end each trade is measured at its larger amount, so its line can be smaller than at the low end. A high end still under the job minimum is the low end, as before, unless it charges more before tax: growth in exempt items is billed on top of the minimum at the high end too.

**Tax.** Sales tax is `rate x` the sum, over taxable items, of `line x materials share x (the after-hours multiplier if flagged) x (1 + overhead and profit unless exempt)`. With every share at 100 and nothing flagged or exempt that is the formula described for `dryscope-v2`.

**Rounding.** Every amount that is added to the total is rounded once to cents, half up, as before. The low end never falls when work is added. At the high end a binding trade minimum is measured on grown amounts that are fractions of a cent, so it can cost up to one cent per trade heading when work is added. When that rounding would put the high end's total below the low end's, the high end keeps its grown lines and adds the gap to its last trade minimum line, so its parts still sum and the range never runs backwards (W63).

### What `dryscope-v3` keeps from `dryscope-v2`

Everything else follows the rules described for `dryscope-v2` below, in Decimal: lines (`quantity x price x (1 + waste / 100)`, rounded to the cent half up, once), a room's own waste over the item's, the three buckets, the cushion over the dearest square feet or the uncertainty high end, the minimum job charge, overhead and profit, sales tax on the taxable share, the single-price mode and the $0.00 guard. The after-hours adjustment, overhead and profit and the tax follow the section above. A table with no rows, no per-room items, no mold filters and no flags, priced for rooms with no Mold category on a job that is not after hours, prices exactly as `dryscope-v2` did, except that a cushion high end taxes each grown labor line, so its tax differs when taxable and non-taxable labor grow at different rates. A per-room line has no square feet, so the cushion treats it like labor hours: it is not a tiered area line, and under the uncertainty method it grows by its own room's hidden-damage percent. The rebuilt app has no `adr-residential-v1`, no ADR rates in code and no switch from a rate book (D-017).

### Tests

Hand-worked examples, each with its arithmetic in a comment: `web/tests/unit/estimate-worked-examples.test.ts` (quantity, waste, eligibility, multipliers, brackets, range, minimum, overhead and profit, tax, after-hours, publish checks, rounding) and `web/tests/unit/estimate-category-rows.test.ts` (each precedence step, Mold rooms, each bracket mode with rows, row schema rules) and `web/tests/unit/estimate-item-flags.test.ts` (each flag, trade minimums, the materials share and the Xactimate note, one or more worked examples each) and `web/tests/unit/estimate-room-inputs.test.ts` (each size tier and its limits, several areas in one room, each mold condition, each containment band, room-type rows on and off, a removed type, suggested lists, equipment suggestions, schema rules). `web/tests/unit/estimate-properties.test.ts` and `estimate-room-properties.test.ts` scan seeded random tables and jobs, with and without rows, Mold rooms, size tiers, mold filters and room-type rows: in tiered mode adding square feet or a quantity never lowers either total; the high is never below the low; each total equals its lines and adjustments; the same table gives the same hash; room-type rows with the setting off price as a table without them. The scan keeps a room's category, type, mold condition, affected area and confirmed size fixed: changing one of those picks a different row or item, and may legitimately lower a total, as changing a category does. `web/tests/unit/estimate-item-flags-properties.test.ts` runs the same scans over tables with flags, trade headings and materials shares, and checks that flagging every labor item reproduces the job-wide adjustment.

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
