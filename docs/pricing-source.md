# Pricing source

Each company sets its own prices. DryScope has no default price list, and one company's rates are never used for another.

- **A company with no published prices cannot price an estimate.** The audit answers 409 and the job stays a draft. The owner is told "Set your company prices before your first estimate", with a Set company prices button while the editor is on; estimators and office staff are told to ask the owner.
- **Owners publish prices under Company prices** (behind `PRICE_BOOKS_ENABLED`), or import the CSV/XLSX template. The template for a company without prices lists item names and units with blank prices; `version_id=starter` on the export route gives the v2 starter catalog in the same blank form. See [Company workspaces](company-workspaces.md#company-prices). While the flag is off the editor is unavailable, so the flag must be on before a company other than ADR can price anything.
- **The browser gets prices only from the API,** for the signed-in company. No rate is written in `public/`; `tests/test_no_adr_default.py` checks that.
- **Rates live on the server as data:** a published book is stored per company, and each job pins the book it was first priced from. A published book applies to new pricing from the server's publication time. An existing draft keeps its saved rates until the owner reviews and applies new prices to that one draft. Signed records never change.
- **Formulas, waste and range factors, default quantities and mandatory wording stay in code** (`backend/claims.py`) for now on `adr-residential-v1` books, under `CALCULATION_VERSION`. An owner-defined `dryscope-v2` table is a separate model that holds its own items and settings.

ADR's rates are ADR's proprietary data. They sit in `backend/adr_price_book.py` and ADR's own price-book record, are used only for company `adr`, and their source notes are in [ADR pricing source](adr-pricing-source.md). `scripts/migrate_price_books.py` writes them as ADR's book and refuses any other company; see [ADR price book](../RELEASES.md#adr-price-book). An older book or unsigned draft in another company that holds ADR's rates is refused rather than used; signed records stay viewable.

For pricing work outside the catalog and its treatment in the estimate range, see [Priced additional work](priced-extras.md).

Each job's saved prices record a calculation version, and that version selects the formulas used to price the job (`POLICIES` in `backend/claims.py`, `CALCULATION_FACTORS` in `backend/price_books.py`). `adr-residential-v1` and `dryscope-v2` are the versions with formulas, and `backend/pricing.py` chooses between them. A `dryscope-v2` table can be published, but audits and additional-work approvals still refuse it with a conflict until the estimator screens and documents are connected. A version's formulas never change once saved prices use it, so existing drafts and signed documents keep their numbers; new formulas get a new version. An unknown version is refused, never priced with another version's formulas.

## Company-defined tables (`dryscope-v2`)

A company on calculation version `dryscope-v2` prices from its own table: `items` and `policy`, pinned to the job (see [Company workspaces](company-workspaces.md#company-prices)). Documents already priced on `adr-residential-v1` keep that calculation and their numbers. `backend/pricing_v2.py` holds this calculation. All math is `Decimal`; a model never supplies a price.

**Lines.** Each enabled item with a price makes lines from its `quantity_source`. Room sources make one line per room matching the item's `categories`; the unit price is multiplied by the room's category multiplier, and by the cabinetry multiplier for a category 3 room with custom cabinetry when the source is `room:demolition:finished` or the scope is `all_cat3`. A room's own waste wins over the item's when it is above zero. Job sources make one line, at the item's price and waste, and only when a room matches the item's `categories`. A line total is `quantity × price × (1 + waste / 100)`, to cents, half up; a zero quantity makes no line. Each approved extra makes one line at its approved rate, taxable when the enabled `extras` item is marked taxable and not taxable when no `extras` item is enabled. The enabled `extras` item is never priced by quantity: it only supplies the hourly rate an owner approves work at, so unapproved hours cannot reach a total.

**Unset job numbers.** An unset job number prices from the item's default quantity, which is 0 when the owner set none; the job model's own defaults never price. A `count_days:` source with either number unset prices the default quantity rather than a product. Because a saved draft stores every number, a saved draft is protected only by seeding new v2 drafts from the company table, which is required before v2 audits are accepted.

**Entered quantities.** `quantity_overrides` holds what an estimator entered over a walkthrough measurement, and pricing reads the entered number. Keys name what was overridden: a job number by its field name (`air_movers`, `drying_days`, `monitoring_hours`), or a room area as `<room name>:<field>` (`Kitchen:finished_sf`, with `unfinished_sf`, `finished_sf`, `wet_floor_sf` or `floor_sf`). A typed item's entered quantity is its `scope_items` `quantity`. A key that names no such field or room is ignored and listed as a warning.

**Buckets.** A line's group sets its bucket: job charges, optional services and extras are fixed (`F`), drying equipment is equipment (`E`), and demolition, treatment and labor are labor and materials (`L`). `L_area` is the labor-and-material lines read from a room's area; `L_other` is the rest, such as labor hours.

**The high end.** With `N = range.first_sf`, `X = first_percent / 100` and `Y = beyond_percent / 100`, `TopN` is the dollars of the `N` most expensive square feet of `L_area`, taking a partial line in proportion:

```
H = round_cents( (1 + Y) × L_area + (X − Y) × TopN + (1 + X) × L_other )
```

At or below `N` square feet this is `(1 + X) × L`, and above `N` the factor falls smoothly toward `1 + Y`, with no step at any size. Because `TopN` is the most any `N` square feet can cost, adding area at any rate, or raising any price, can never lower it. A share of the job's area spread evenly does not have that property: cheap added area would dilute expensive dollars and lower the high.

**Each end.** `LM` is `L` at the low end and `H` at the high end, and `m` is `after_hours.multiplier` on an after-hours job, else 1.

| Summary line | Amount |
| --- | --- |
| Subtotal | `F + E + LM` |
| After-hours adjustment, with the owner's label | `round_cents(LM × (m − 1))` |
| Minimum job charge | `minimum_job_charge − (subtotal + adjustment)`, when that is above zero |
| Overhead and profit, `p` | `round_cents(p × (subtotal + adjustment + minimum))` |
| Sales tax, `t` | `round_cents(t × (T_F + T_E + m × T_L × LM / L) × (1 + p))` |
| Total | the sum of the lines above |

`T_F`, `T_E` and `T_L` are the same sums over lines marked taxable, and `T_L × LM / L` is zero when `L` is zero: the high end taxes the same proportion of labor and materials as the low end. Overhead and profit comes before sales tax, so taxable items carry their own share of it; with overhead and profit off it plays no part in tax. The minimum job charge comes before overhead and profit, which applies to it. The minimum job charge is not taxed.

If the high end's amount before the minimum is still below the minimum, the job is the minimum at both ends and the high equals the low. Otherwise the high has no minimum line. The high is not floored on its own, because adding non-taxable work under the minimum would shrink its taxable share and lower its total with nothing to offset that.

The itemized total printed beside the range is the low total. A single-price company prints the low total as the price and has no high end; `H` is still calculated, so a later switch to a range needs no change to the calculation.

**Rounding.** Each line, `H`, and each summary line round once, to cents, half up, and nothing else rounds. Printed lines always add up to the printed total.

**Guards.** A priced scope of $0.00 is refused with "The priced scope totals $0.00. Enter at least one quantity or room measurement before auditing." before any minimum applies, so a minimum never turns an empty job into a signable one. A line outside the three buckets raises an error rather than vanishing from the range.

**Neither total drops when work is added.** Raising any room area, equipment count, day count, labor hour, charge count, approved extra, the after-hours flag or any unit price never lowers the low or the high beyond rounding (two cents at most). `tests/test_pricing_v2.py` scans this over 2,000 random tables and jobs on a fixed seed.

**Explanation text.** `explanation()` builds the paragraph under the amounts from the pinned policy, and `range_explanation()` builds the one sentence naming the cushion tiers, such as "The high end allows 50% extra on the first 1,000 sq ft of work and 20% beyond, for hidden damage." Both are server text.

**Advisory warnings**, returned beside the lines and never blocking on their own: `missing_area`, `unknown_scope_item`, `unknown_quantity_override`, `blank_price_item` and `unpriced_extras_quantity` (an enabled `extras` item holds a `scope_items` quantity or a default quantity above zero, which is not priced).

**Sample jobs.** `SAMPLE_JOBS` are three made-up jobs for previews: "Clean-water kitchen leak", "Gray-water main floor" and "Mold remediation, after hours". Each carries the notice "Sample job only. This does not price a saved job." and states every job number, so no item's default quantity reaches a preview.
