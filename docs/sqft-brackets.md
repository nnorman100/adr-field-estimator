# Owner square-foot brackets

Company owners can add square-foot price brackets to an area item, add cushion
brackets, and choose **Tiered** (the default) or **Whole-job** under Company prices.
Office staff, estimators and support retain their read-only price view. These
controls use the existing price-book rollout switch; this change enables no flags
and changes no starting rates or v1 rate books.

A price bracket belongs to one item. In tiered mode its quantity is that item's
combined square feet across matching rooms, or its typed square-foot quantity,
**before waste**. In whole-job mode the job's total square footage picks the band:
each room counts once at the largest area figure its priced square-foot items
(flat or bracketed) use, plus each square-foot quantity typed without a room, before
waste. Finished plus unfinished demolition counts as one figure, even when only
one demolition item reads that room. Floor and wet-floor items use their own area
figures; a blank wet floor uses the floor area. A `room:basis` item reads the
policy's area basis. A `room:typed` item reads the square feet typed for that room
(see `pricing-source.md`). Area figures that no enabled, priced square-foot item reads
do not contribute: a room priced only by a floor item at 600 sq ft counts 600,
even if a larger demolition area was entered.
Several items on one 500 sq ft room count 500 sq ft; demolition on a room with 400 sq ft finished
and 400 sq ft unfinished contributes an 800 sq ft figure however its items split it; separate
rooms count separately even when they share a name. It is
not a separate region price. Room category
and cabinetry multipliers and waste still apply. Price brackets are available only
on `sf` items with a room or typed quantity source. Without brackets, the item
keeps its flat unit price. With brackets, the bracket rates replace that price;
the flat price may be blank. Every enabled bracket must have a price before publishing, and zero requires
the existing allow-zero setting and an owner's explicit confirmation at publish.

Both kinds of bracket have cumulative upper limits. For example:

```json
[
  {"up_to_sf": 500, "unit_price": "10.00"},
  {"up_to_sf": 1000, "unit_price": "5.00"},
  {"up_to_sf": null, "unit_price": "2.00"}
]
```

The bands are 0 through 500, over 500 through 1,000, and over 1,000 square feet.
They work with fractional quantities, too: 500.25 includes 0.25 in the second
band. Only the last limit is null (unlimited). Cumulative limits make gaps and
overlaps impossible. Limits must be ascending whole numbers from 1 to 100,000,
with 1 to 20 bands. Prices are nonnegative decimals up to $100,000 with at most
two decimal places. Cushion bands use the same limits and a `percent` from 0 to
100 with at most two decimal places.

Price bands may have blank prices in a saved working copy. Fill every price band
or disable the item before publishing; incomplete items are unpriced in sample calculations and their
boundary previews appear once their prices are complete. A blank flat price stays
blank when the owner first adds price brackets.

| Quantity | Tiered at the example rates | Whole-job at the example rates |
| --- | --- | --- |
| 500 sq ft | $5,000 | $5,000 |
| 501 sq ft | $5,005 | $2,505 |
| 1,000 sq ft | $7,500 | $5,000 |
| 1,001 sq ft | $7,502 | $2,002 |

Tiered assigns each band's rate only to the square feet within it. Across rooms,
it fills the highest adjusted-cost rooms first (category and cabinetry
multipliers times waste), so adding work cannot shift expensive existing work
into cheaper bands and lower the job's price. Under the uncertainty method the
high end fills the bands again, highest grown cost first (adjusted cost times one
plus the room's hidden-damage percent), so neither end can drop as work is added. Lines split at band boundaries;
each names the mode and bracket. Rounding follows the item's cumulative exact
amount: a split line is the difference between the cumulative cents before and
after it. The lines therefore add to the item's rounded total without losing
cents when a band shifts between rooms. The high end reads each split line's exact
amount instead of its rounded share: the uncertainty method rounds each bracketed
item's grown amount once, and the cushion rounds once in total, so a cent moved
between rooms cannot lower the high end. Existing flat items keep their original
per-line rounding.

Whole-job chooses each item's bracket using the job's total square feet (each room
once plus typed square feet, flat-priced items included, before waste) and applies that rate
to all the item's square feet. For example, two items on separate 500 sq ft rooms
with a 750 sq ft boundary both take the over-750 rate, as does one bracketed item
on a 500 sq ft room when a flat-priced item covers another 500 sq ft room.
It can produce a lower price just above a boundary. The owner's mode is stored as optional `policy.bracket_mode` and
applies to both prices and cushions. An absent mode reads as tiered without
adding a field to existing tables or changing their content hash.

## Cushion

Optional `policy.range.brackets` holds the cushion bands. Without it, readers use
`first_sf`, `first_percent` and `beyond_percent` as two bands. Existing tables keep
their exact calculation and operation order; choosing custom bands explicitly
opts into the general calculation. The same two bands give the same cents.
Legacy two-step fields stay available in the editor and are unused while custom
cushion bands are present. **Use two-step cushion** returns to those saved fields.

Tiered cushions count all area-priced labor/material lines together, highest
price per square foot first, using each line's own counted area. As before, the
`demolition_with_waste` basis counts waste in a flat-priced line's area; other bases,
and every bracket-priced line, use the line's raw square feet. A bracket-priced line
counts the same square feet its price bands count, so added work cannot shrink the
area held by expensive bands and lower the high end. Each band's percentage applies to its share of those
dollars. Non-area labor takes the first band's percentage. In notation:

```
H = round_cents(L_area + sum(dollars_in_band * percent_in_band / 100)
                + L_other * (1 + first_percent / 100))
```

Whole-job selects one cushion percentage using the same job total square feet as
whole-job prices (each room once plus typed square feet, flat-priced items
included, before waste) and applies it to all labor/material dollars, labor hours included. A drop is allowed
at the boundary. Job charges, equipment, approved extras, minimums, after-hours,
overhead and tax keep their existing rules. The uncertainty method ignores the
cushion bands, as it ignores the legacy cushion; its calculation is unchanged.

## Preview, storage and exchange

The live preview shows isolated sample work one square foot below, at, and one
square foot above **every** boundary, plus 0.01 sq ft below and above to reveal
small drops that whole-foot samples would miss. Price previews use that item's rates and
the company policy, with minimum job charge and overhead/profit excluded so they
cannot hide a bracket drop. Cushion previews also exclude those settings and state a synthetic $1/sq ft scope to show
the percentage effect separately. Other items and saved jobs are excluded and
this is stated beside the samples; on a job, whole-job mode picks the band from the
job's total square feet before waste, each room once plus typed square feet. A whole-job drop in either estimate end is
flagged. Typed quantities above 100,000 sq ft are outside the job-input limit,
so that sample says it is unavailable. Multi-room samples can cross that limit.

Brackets are normalized server-side and included in the published content hash,
version diffs, full job pins and phone price cache. Publishing applies to new
jobs. Existing drafts retain their pins until the owner's usual one-draft
reprice review; signed sources and evidence never change. No new calculation
version is needed: tables without brackets retain their exact numbers, field
shape and hashes. A document's price basis records the full bracket schedules
for enabled items and the pinned cushion policy. Itemized lines also include the bracket
used, its mode and the actual rate. Unlimited limits remain explicit nulls when
documents serialize, including when optional document fields are omitted.

CSV/XLSX exports of a bracket-aware table add three columns to the existing v2
item template: `price_brackets`, `cushion_brackets` and `bracket_mode`. Bracket
columns contain JSON arrays. The cushion and mode repeat identically on each
row; mismatches are rejected. A bracket-template CSV may be up to 512 KiB, enough for
the largest valid table; other CSV templates keep their 256 KiB limit. On import, these two policy settings replace the
published values after the owner's review; all other published policy settings
are retained. The legacy 20-column template is still accepted and retains the
published policy. Old flat-table exports stay in that format. Unchanged imports preserve
absent optional defaults and do not manufacture a new price version. v1 is untouched.

Automated evidence: `tests/test_sqft_brackets.py` covers arithmetic, randomized
tiered monotonicity, the two-band legacy cushion, validation, CSV/XLSX and API
round trips, job pins, signed immutability and role checks.
`tests/browser/sqft-brackets.spec.js` covers owner editing, boundary drops,
save/reload, publish, offline controls and read-only roles in Chromium/WebKit.
These are synthetic checks; real-service and physical iPhone checks remain open.
