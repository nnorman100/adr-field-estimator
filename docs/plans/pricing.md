# Pricing: owner-set prices for every estimate (plan)

Approved plan for owner-set pricing in the rebuilt app (`web/` only). Planned 2026-11-10 on `master` at `9d1be042`; the owner approved it the same day with the answers in section 9 ("accept all"). Each step is one pull request with a test that fails without it; every step is **High** risk (pricing, isolation). A pull request is checked against this file; plan changes go under "Corrections" at the end, in the same pull request as the work that needs them ([README](README.md)).

## 1. Summary

- The owner's words (2026-11-10): "owners need to be able to set their own pricing in each category area and room" and "The pricing set by the owner needs to be used to create the dryscope estimates of repairs".
- Read as, and now decided (section 9): each company owner publishes one versioned price table; every estimate is priced only from it, by the server, in Decimal. A price can differ by **category** (water Category 1, 2, 3, or Mold), by **size** (square-foot brackets, and room-size tiers for per-room items). A price by **room type** is possible but **off by default**; room types are mainly labels with a suggested item list. Water class and mold condition are room inputs that suggest quantities and filter which items apply; they are not price axes. Per-job room price changes were not asked for and are not planned.
- The merged engine (`web/src/engine/`, PR #263) already prices per item, per water category (eligibility and multipliers) and per size bracket. **Missing:** Mold as a category value, per-room items and size tiers, room types as labels with item lists, per-item after-hours / no-O&P / materials-share flags, per-trade minimums, any storage, routes or screens.
- **Kept:** the pricing rules and the four documents. **Replaced:** the layer that copied Python's number and text quirks for byte-for-byte parity, and the old ADR rate book (`adr-residential-v1`). Exact match with the old Python prices is no longer required; each owner sets their own prices (decision D-017).
- **Steps:** 10 in S4 (engine in three parts, price tables, Prices screens), 3 in S5a (pins, priced estimate, Check Scope) and 4 in S5b (reprice, then spec 6.1's named adjustments, approvals and change orders, outlined only). Three are database jobs (S4-5, S5a-1, S5b-3). All build on the same versions.
- All 25 owner questions (Q1 to Q15 and M1 to M10) are answered (section 9). Only the details inside a step remain, and each step says so.

## 2. What exists today (evidence)

| Fact | Where |
| --- | --- |
| Table = items + policy. An item has a group (7 fixed groups that feed the range buckets), a unit, a quantity source, a unit price, waste %, water-category eligibility `categories`, and optional per-item `price_brackets`. | `web/src/engine/table.ts:15`, `:76-94` |
| Policy: water-category multipliers 1/2/3, cabinetry multiplier, tiered or whole-job brackets, range cushion or "uncertainty" high end, minimum charge, overhead and profit, sales tax on the taxable share, after-hours multiplier, range or single price. | `table.ts:96-119`, `totals.ts:284-285` |
| A room line's price is the item price times the water-category multiplier (and cabinetry). There is no room type anywhere: a room has a free-text name, water category and areas. | `price-v2.ts:154-176`, `inspection.ts:20-37`; old app `backend/contracts.py:31-47` |
| Brackets: tiered (each sq ft at its band; across rooms, the dearest rooms fill the cheaper bands first) or whole-job (the job's total sq ft picks one band). | `price-v2.ts:220-266`, `docs/sqft-brackets.md` |
| Parity layer: pydantic lax-mode coercion, Python string rules, Python float text, CPython decimal text, prices carried as JS floats between steps. | `coerce.ts:1`, `pystr.ts`, `json.ts:18`, `price-v2.ts:139-143` |
| `adr-residential-v1` and ADR's own rates are in engine code; the pin's `priced_at` is frozen for the oracle. | `price-v1.ts`, `pin.ts:20`, `:46-68` |
| Three `web/` tests read the stored answers: `pricing-oracle.test.ts` (208 cases), `coercion-oracle.test.ts` (68 probes), `engine-normalization.test.ts` (13 cases), all from `tests/fixtures/pricing-oracle/` (8.8 MB). `tests/golden/v1-documents.json` is read only by the old Python `tests/test_claims_documents.py:37`, so it is not part of this plan. | `web/tests/unit/`, fixtures `README.md:89-97` |
| Postgres holds identity tables only (`0001` to `0004`; `0005` is open in https://github.com/nnorman100/adr-field-estimator/pull/296). Hand-written SQL migrations hold every check; `schema.ts` is a Drizzle typed view. Every table has forced row-level security, guarded by a test. The runtime has no `DELETE` anywhere. | `web/src/db/schema.ts:18-20`, `docs/DATA.md` (0003), `web/tests/db/row-security-guard.ts` |
| `prices_read` (all roles) and `prices_manage` (owner) exist only when the price flag is on; today the request path hard-codes it off. Per-company `price_books` flag and `requireFlag()` are in https://github.com/nnorman100/adr-field-estimator/pull/293. | `web/src/lib/access/can.ts:38-46`, `web/src/lib/auth/identity.ts:100` |
| Authority: published price tables, working copies, job pins and approvals live in Postgres; phones get dated read-only copies; Firestore and client totals are never authoritative. | `docs/data-ownership.md:9-10` |
| Old app behaviour this plan keeps: one working copy per company, preview, publish with a change reason, versions, restore into the working copy, CSV template, drafts pinned at first price and moved only by the owner's explicit reprice, signing checks the pin. Not kept: the old starter list's contents and any export of old prices into the new app (Q12, Q13). | `backend/price_book_store.py:107-121`, `:1558-1653`, `:1820-1887`; `backend/price_table_starter.py` |
| Stage definitions: S4 closes "Pricing and documents"; S5a is core records and the exactly-once handoff (before S7 Live), S5b the remaining workflows. No S4, S5 or S6 plan file exists yet. | `docs/ARCHITECTURE.md:80-82`, `:94`; `docs/STATUS.md` |

## 3. How an estimate picks its prices

1. **One table per company, versioned.** The owner edits one working copy. **Publish** checks it, saves it as the next numbered version (whole content, content hash, engine version, reason, who, when) and never changes it again. **Restore** copies an old version into the working copy; publishing it makes a new version. "Current prices" means the highest version number.
2. **No prices, no estimate.** A company with no published version cannot price; the job shows "prices not set" (spec 6.1, D-010).
3. **Pin at first price** (Q7). The first estimate on a draft pins it to the current version. Later publishes never move it. Only the owner's explicit **Reprice this draft** moves an unsigned draft to the current version (spec 6.1 Q8); that clears the audit and the scope confirmation.
4. **Line price (precedence).** Rooms carry inputs; the owner's table turns them into a price in a fixed order.
   - **Room inputs.** Each room has: a **category** (Cat 1, Cat 2, Cat 3, or **Mold**; the estimator marks a room Mold for its removal and cleaning lines, M10); a **room type** (a label, Q3/Q5); its areas, which give a **size tier** (S, M, L or XL, from thresholds the owner sets in square feet); for water rooms the **water class** (1 to 4); for Mold rooms the **mold condition** (S520 Condition 1, 2 or 3) and the **affected square feet**. The category stays editable until signing, and pricing reads it at estimate time.
   - **Class and condition are not price axes.** Water class suggests equipment counts and drying days (a function of room volume and class, confirmed by the technician) and may offer Class 4 specialty-drying items. Mold condition and affected square feet decide which mold items apply (eligibility) and which containment item applies (by affected area: up to 10, 10 to 100, over 100 sq ft). Neither changes a unit price.
   - **Default row.** Every item keeps a required default row: one unit price, or its own square-foot brackets. For an item whose unit is **per room**, the row holds four prices, one per size tier (S/M/L/XL), instead of a single price.
   - **Category rows.** The owner may add a row that names a category (Cat 1, 2, 3 or Mold). The row is used as set; the multiplier does not apply to it. The default row gets the water-category multiplier (1/2/3) and the cabinetry multiplier for water rooms; the multiplier never applies to Mold rooms. The item's category filter decides whether a line exists; rows only decide its price, and a row may not name a category the filter excludes.
   - **Room-type rows (off by default).** A company setting, "Price varies by room type", is off for a new company. When the owner turns it on, a row may also name a room type. The most specific matching row wins: **room type plus category, then room type, then category, then the default row.** With the setting off (the default), there are no room-type rows and the order is **category, then default**. A room whose type the pinned version does not know uses the item's rows without a room type. A warning for "Other" on an item with room-type prices appears only when the setting is on.
   - **Brackets count per row.** In tiered mode, only the rooms priced by a row count toward that row's bands; in whole-job mode, the item's total sq ft picks the band in each row's own list. Shared counting across rows can lower a total when square feet are added (worked counterexample in section 6), so it is ruled out. Size tiers pick a price per room and are not brackets: they never count square feet across rooms.
   - **Room types and item lists.** A room type is a label (up to 30 per company, seeded with Kitchen, Bathroom, Bedroom, Living room, Hallway, Laundry, Garage and Other; Other always exists) plus an optional **suggested item list**. Choosing a type on Check Scope pre-fills that list for the estimator to confirm; it does not change any price while room-type rows are off.
   - **One document line per item and row**, for example "Kitchen, Cat 3: Drywall removal", so the owner can see which price was used.
   - Waste, tax, the range and the rest work as today with these changes, all set in section 9: **after-hours** applies only to items the owner flags (M5); **overhead and profit** is off by default, is its own line when on, and skips items flagged "no O&P" (M6); a **minimum charge** may be set per trade heading as well as for the job (M7); **tax** applies to each item's materials share (M9). Rows change only the unit price before the bucket sums, and `group` stays per item. Job-level lines (trip charge, equipment days, labor hours) do not depend on room type. The uncertainty high end varies quantities only, never a room's category or type, so high stays at or above low.
   - **Equipment and monitoring (M4).** Equipment items are priced per unit per 24 hours with a size in the item (standard, large, XL); setup, takedown and daily monitoring are a separate hourly item. The proposal estimates drying days; actual days from the drying log come in later as a change order (S5b-4).
5. **Engine version.** The pin records the engine version (`dryscope-v3`, Q11). Once a signed job uses a version, its formulas never change; new formulas get a new version, and an unknown version is refused (`docs/pricing-source.md:15`).
6. **Signed records never change.** Signing stores the priced result, the documents, the version id, content hash and engine version, in the immutable agreement (S5a). Showing a signed job never runs the engine. A later publish, reprice or engine release cannot change it.
7. **Phones.** The phone gets the published table, dated, read-only, to show the item list, room types and suggested lists offline (S6). It never computes a total; every total comes from the server.
8. **What DryScope produces (M2).** A signed customer proposal and an itemized claim in DryScope's own scope codes (no ESX claim, AGENTS.md section 2). Each item may carry an optional free-text **"matches Xactimate line"** note, typed by the owner for the office's use; DryScope ships no Xactimate codes or prices.

## 4. Changes by layer

| Layer | Change |
| --- | --- |
| Screens | **Prices** (owner edits; office and estimator read; hidden with the flag off): trade headings, room types with suggested item lists, items by heading, price rows per category (and per room type when turned on), size tiers, brackets, estimate settings with plain examples, preview on sample jobs, publish with reason, versions, restore, CSV export and import. **Check Scope:** a room type, category, size and, where they apply, water class, mold condition and affected area on each room; the item list from the pinned version. **Review:** range and lines naming the row used. **Draft banner** (owner): "Newer prices published", with Reprice. |
| Frontend | Next.js pages under `web/src/app/`, shadcn/ui forms validated by the same Zod schema as the server; editor tested in Chromium and WebKit at phone width; the table is cached on the phone in S6. |
| Server routes | `web/src/app/api/prices/**` (read, working copy, preview, publish, versions, restore, export, import) and `web/src/app/api/jobs/[id]/estimate`, `.../reprice`. Each uses `memberRoute` plus `requireFlag('price_books')`, Zod at the boundary, `withCompany`, and one audit row in the same transaction as each write. The company comes only from the sign-in token. |
| Engine | Zod table schema v3, Decimal strings end to end, category rows including Mold, size tiers, optional room-type rows, per-item flags, per-trade minimums, `dryscope-v3`; v1 and the parity layer removed (section 5). |
| Database | New tables only, so every migration is additive (add first, switch, remove later; nothing renamed or dropped): `price_table_working_copies`, `price_table_versions` (S4-5); `job_price_pins` (S5a-1); price columns on S5a's agreement table (S5a-2); `job_price_approvals` (S5b-3). Each has forced row-level security, a company policy and composite company keys. |
| Firestore | Nothing priced. The draft's `field` map gains `rooms[].roomTypeId`, mold fields and typed item quantities; the rules check type and size only (S5 field checks); the server checks that the ids exist when it prices. |
| Tests | Section 6. |

## 5. Engine: kept, changed, removed

| Part | Decision | Why |
| --- | --- | --- |
| Rules in `price-v2.ts`, `totals.ts` (room lines, waste, eligibility, multipliers, cabinetry, brackets, cushion, uncertainty high end, minimum, overhead, tax, after-hours, single price) | **Keep**, with the section 3.4 changes | The owner-approved rules; the range is monotone by design (cushion over the dearest square feet, tax at bucket level). |
| `documents.ts` (four documents, mandatory wording), `sizing.ts`, `warnings.ts`, `text.ts` | **Keep** | Mandatory clauses must stay exact (AGENTS.md 4); covered by new exact-text tests. |
| `decimal.ts` | **Keep** | Tested Decimal type with no new dependency. |
| `table.ts` checks | **Change** into one Zod schema (`PriceTableV3`) used by the editor, routes, import and engine. | One schema everywhere. |
| `coerce.ts`, `pystr.ts`, float handling in `json.ts`, float `PriceLine` fields | **Replace** with Zod and Decimal strings | Kept only for byte parity, which the owner dropped (D-017). |
| `price-v1.ts`, v1 parts of `pin.ts`, ADR's rates in code | **Remove** | Clean start, nothing migrates; ADR's owner enters ADR's prices fresh like any company (Q12). Removes ADR's proprietary rates from source (D-010). |
| `evaluate.ts` and the three oracle tests | **Remove in S4-2**, after S4-1's replacements pass | Only the oracle uses them. |

## 6. Replacement tests (written from the spec, not from the old answers)

- **Worked examples** (Vitest, S4-1): about 20 small jobs with hand-worked numbers for each rule: quantity times price, waste, eligibility, water-category multiplier, tiered and whole-job brackets, cushion and uncertainty, minimum charge, overhead and profit, tax on the taxable share only, after-hours, single price, a blank price blocking publish, a zero price needing a confirmation, cents rounded once. Added with the later steps: category row used as set, default row with multiplier, Mold room with no multiplier, mold containment by affected area, a per-room item at each size tier, room-type rows when turned on and ignored when off, after-hours only on flagged items, a no-O&P item, a per-trade minimum, tax on the materials share. The owner reads the table in plain words (Kun: tests a human vouches for).
- **Exact text** of every mandatory clause (pre-1978 notice and finding, protective equipment, additional materials, exclusions, insurance repricing, 30-day validity) with the issuing company's name.
- **Properties** (seeded random loop, no new dependency): with every room's type and category fixed, adding square feet or a quantity never lowers the low or high total (changing a room's category or type may legitimately lower it); high is never below low; the total equals the lines plus adjustments; the same input gives the same content hash. Plus the shared-counting counterexample as a fixed test: row A is 0.10 per sq ft flat; row B is 10 per sq ft up to 100 sq ft, then 1 per sq ft. Under shared counting, adding 100 sq ft to a room priced by A adds 10 there but pushes B's 100 sq ft into its 1 per sq ft band, 900 less, so the total would fall by 890.
- **Schema:** refuses negative prices, more than 2 decimals, unknown room type or category ids, duplicate ids or codes, cells starting with `= + - @`, a row naming a category the item's filter excludes, size-tier thresholds out of order, and lists over their limits.
- **Database (throwaway Postgres):** the guard test covers each new table; as the runtime, a version cannot be updated or deleted; company B reads none of A's working copies, versions or pins; a pin cannot name another company's version (composite key); two publishes at once give versions n and n+1 or one stale-copy refusal, never two version n; a retried publish with the same key returns the same version.
- **Routes:** estimator and office get 403 on every write and can read; the platform operator reads a company's prices read-only, each view writing an audit row (spec 2.4), and cannot write; flag off gives 404; a refused request writes nothing, including no audit row; the route-rule test passes; every new route joins the S3-17 isolation matrix (company A's ids as company B: 403 or 404).
- **Pins and signing:** a draft pinned to version 1 still prices from version 1 after version 2 is published; an estimator cannot reprice; reprice clears the audit; after signing, a publish or reprice leaves the agreement's bytes and proposal hash unchanged.
- **Import and export:** exporting, then importing, gives the same content hash; import writes only the working copy.
- **Browser** (Chromium and WebKit, phone width): owner edits, previews and publishes; estimator sees no edit control; room type picker; "prices not set".

## 7. Ordered steps

"UI / FE / BE / DB" are the screen, frontend, server and database changes. A step marked **(DB job)** adds a migration and waits its turn in the single database lane; every other step has DB: no. Every step also passes the eight checks (`docs/roadmap.md`), which for pricing mean:

| Check | For these steps |
| --- | --- |
| Rules and indexes | No Firestore index or price data; Postgres keys and unique indexes live in the step's migration. |
| Older records | Nothing migrates. A pinned version always prices the same; a signed job is never repriced. |
| Offline | Estimate, publish, import and reprice are online only; the dated read-only table copy is S6's. |
| Who may use it | `prices_read`, `prices_manage`, new `job_reprice`, checked on the server; `docs/ACCESS.md` updated in the same pull request. |
| App cache | No service worker in `web/` yet; S6 adds it. |
| Help and docs | In-app help for each role that sees Prices or room types; `docs/pricing-source.md` rewritten for `dryscope-v3` in S4-4a; `STATUS.md`, `DATA.md` (new tables) and `ACCESS.md` in the step that changes them. D-017 is recorded with this plan. |
| Privacy and logs | Prices are not personal data; logs and audit details hold ids and counts only. |
| Phone check | Prices read-only view, Check Scope room inputs and Review on a real iPhone, recorded apart from mock results. |

### S4: engine and company price tables (no jobs needed)

**S4-1 Worked examples and a stable engine entry (guardrails).** UI none. FE none. BE: `priceEstimate(table, job)` over today's engine, plain JSON in and out, money as Decimal strings, so the tests survive S4-3. DB no. Checks: section 6 worked examples, exact clause text and properties, all passing on today's engine; the useful cases of `engine-normalization.test.ts` (claim date, addressee, photo log, room overrides) carried over. Depends on nothing.

**S4-2 Retire the oracle tests.** UI, FE, BE none. DB no. Removes the three oracle tests, `evaluate.ts` and `tests/fixtures/pricing-oracle/`; keeps `tests/golden/` (old app, retired in S8). The Test guard blocks this until the **owner adds `test-change-approved`**; agents never add it. Depends on S4-1 merged.

**S4-3 Zod table schema and Decimal strings; no v1.** UI, FE none. BE: `PriceTableV3` Zod schema; engine inputs and lines in Decimal strings; parity layer, `price-v1.ts` and ADR's rates removed; content hash over the canonical JSON of the parsed table. DB no. Checks: S4-1 tests unchanged and green. Depends on S4-2.

**S4-4a Category rows and Mold.** UI, FE none. BE: the category list gains Mold; an item may carry rows that name a category beside its required default row; the multiplier applies to the default row of water rooms only; per-row bracket counting; version `dryscope-v3`; rewrite `docs/pricing-source.md`. DB no. Checks: one worked example per precedence step and per bracket mode with two rows on one item, a Mold room without multiplier, a monotone scan with rows. Depends on S4-3.

**S4-4b Room inputs, per-room items, size tiers, room types.** UI, FE none. BE: room inputs (category, size tier, water class, mold condition, affected square feet); the `per room` unit with four tier prices; owner-set tier thresholds; mold-condition eligibility and containment by affected area (M8); room types as labels with suggested item lists; the "Price varies by room type" setting (off by default) and room-type rows with the section 3.4 order; equipment-count suggestions from class and room volume (a pure function; the technician confirms in S5a-3); a room whose type is not in the pinned version falls back, with an advisory warning only when room-type rows are on. DB no. Checks: a worked example per size tier, per mold condition and per containment band, room-type rows on versus off, a removed type falls back, monotone scan. Depends on S4-4a. Details to settle in the pull request: how a room's tier is derived when a room has several areas, and the default tier thresholds shown as blank.

**S4-4c Item flags, per-trade minimums, materials share.** UI, FE none. BE: per-item after-hours flag (the job-wide after-hours multiplier now applies only to flagged items, M5); per-item "no O&P" flag, O&P off by default and printed as its own line (M6); optional minimum per trade heading beside the job minimum (M7); per-item materials share for tax (M9); optional "matches Xactimate line" note carried to the itemized claim, never the proposal (M2). DB no. Checks: one worked example each, exact-text tests unchanged. Depends on S4-4a (may run beside S4-4b).

**S4-5 Price tables (DB job).** UI, FE none. BE: Drizzle view. DB: `price_table_working_copies` (named so it is not confused with job drafts; one row per company: base version, content `jsonb`, revision; runtime `SELECT, INSERT, UPDATE`) and `price_table_versions` (company, sequence unique per company, content `jsonb`, content hash, engine version, reason, source blank/import/restore, published by, published at, publish key unique per company; runtime `SELECT, INSERT` only). Forced row-level security, a company policy and composite keys on both; checks on hash length, reason length and engine version. Checks: the database tests in section 6; the migration applies on a database holding every earlier file. Depends on S3-4, and on the database lane being free (S3-9, S3-11b and S3-12 first).

**S4-6 Prices API.** UI, FE none. BE: `GET /api/prices` (current version and working copy), `PUT .../working-copy` (stale revision gives 409), `POST .../preview` (prices built-in sample jobs, writes nothing), `POST .../publish` (reason, zero-price confirmations, expected revision, publish key; fresh sign-in, Q10; the owner's range choice, Q14), `GET .../versions[/:id]`, `POST .../versions/:id/restore` (into the working copy), `GET .../export` (CSV); the operator's audited read-only view (needs S3-9). A new company's working copy is the starter list of industry items and units with **blank prices**, starter trade headings and room types, and neutral settings (Q13, Q14). Audit row per write. Updates `docs/ACCESS.md`. DB no. Checks: route tests. Depends on S4-4a to S4-4c, S4-5, S3-7, S3-8, S3-11a.

**S4-7 Template import.** UI none. FE none. BE: `POST /api/prices/import` writes only the working copy, needs `prices_manage` (the old app's `prices_read` gap, `docs/ACCESS.md:45`, is closed), refuses formula-leading cells; CSV first (Q9). DB no. Checks: round trip; estimator refused. Depends on S4-6.

**S4-8 Prices screens.** UI: the Prices page (section 4); each item shows one price until the owner turns on "Price varies by water category" (or, in company settings, "Price varies by room type"), plus a "what does this room pay?" preview. FE: the pages and forms; read-only view for estimator and office; hidden with the flag off. BE none. DB no. Checks: browser tests. Depends on S4-6, S4-7, S3-13 (sign-in screens).

### S5a: pins and the priced estimate (with the core records)

**S5a-1 Job price pins (DB job).** UI, FE none. BE: Drizzle view. DB: `job_price_pins` (company, job, sequence, version, reason first price/owner reprice, by, at; runtime `SELECT, INSERT` only; key `(company, version)` to versions and `(company, job)` to S5a's jobs table; unique per job and sequence). Depends on S4-5 and S5a's jobs migration.

**S5a-2 Estimate route, and price data in signing.** UI: Review shows range and lines naming the row used. FE: review screen. BE: `POST /api/jobs/:id/estimate` loads the submitted revision, pins on first price inside the job's row lock, prices, returns lines, totals and warnings; "prices not set" with no version. S5a's audit and signing steps store the priced result with version id, content hash and engine version, and signing refuses if the pin changed since the audit. DB: these columns on S5a's agreement table, in that step's migration (not a separate job). Checks: section 6, pins and signing. Depends on S5a-1, S4-6.

**S5a-3 Room inputs and item list on Check Scope.** UI: on each room, a room type picker (preselected Other, Q5), category (Cat 1, 2, 3 or Mold), water class or mold condition and affected area where they apply; the suggested item list for the room type; the suggested equipment counts, which the technician confirms. FE: Check Scope; the field map's `rooms[].roomTypeId`, mold fields and item quantities. BE: submit checks the ids against the pinned version. DB no. Firestore: field checks for the new fields in S5's rules work. Live voice may suggest a type or category; the estimator confirms. Depends on S5a-2 and S5's field-map step.

### S5b: owner reprice, then spec 6.1

**S5b-1 Reprice this draft.** UI: owner banner and a before/after preview. FE: banner and dialog. BE: `POST /api/jobs/:id/reprice` (owner only, new capability `job_reprice` in `web/src/lib/access/` and `docs/ACCESS.md`; refused on a signed job; writes a pin row, clears the audit, one audit event). DB no (uses S5a-1). Depends on S5a-2.

**S5b-2 Named adjustments** (spec 6.1 Q2). UI: an adjustments section in the Prices editor. FE: its forms. BE: definitions in the version content; the engine applies an approved one. DB no.

**S5b-3 Proposals and approvals on a job** (spec 6.1 Q2 to Q4: named adjustments, custom multipliers, project additions). UI: estimator proposes, owner approves. FE: job dialogs. BE: propose and approve routes, approval bound to job revision and price hash, cleared by any edit. **DB job:** `job_price_approvals`.

**S5b-4 Change orders** (spec 6.1 Q5; also where actual drying days from the drying log are billed, M4). UI: change-order flow on a signed job. FE: its screens. BE: prices only the added work from the pin; minimum and trip charge are off unless the owner selects them (Q15). DB: parent link on S5b's agreement migration (not a separate job). S5b-2 to S5b-4 get detailed steps as a correction to this plan when S5b is planned.

**Turning it on:** after S4-8 and S5a-3, the platform operator turns `price_books` on for one company at a time (D12). Turning on new pricing is owner-only, so it waits for the owner's word.

## 8. What can run in parallel

| Wave | Steps | Waits on |
| --- | --- | --- |
| A (now) | S4-1 | nothing |
| B | S4-2, then S4-3 | owner's label; S4-1 |
| C | S4-4a, then S4-4b and S4-4c together | S4-3 |
| D | **S4-5 (DB job)** | the database lane after S3-9, S3-11b, S3-12 |
| E | S4-6, then S4-7 and S4-8 | S4-4a to S4-4c, S4-5; S3-11a, S3-13 |
| F | **S5a-1 (DB job)**, then S5a-2, S5a-3 | S5a's jobs and agreements migrations; S5 field map |
| G | S5b-1; S5b-2; **S5b-3 (DB job)**; S5b-4 | S5a; spec 6.1 open items |

Engine steps S4-1 to S4-4c touch no database and no route, so they run beside the remaining S3 work. S4-4b and S4-4c both edit the table schema, so the second to merge rebases onto the first. Migration numbers are taken at merge time; one database job at a time.

## 9. Owner decisions (2026-11-10)

On 2026-11-10 the owner answered "accept all" to the plan: Q1 as the owner stated it, Q2 to Q15 as recommended and as updated by the web research (section 10), and M1 to M10 as recommended. The owner actions that remain are listed after the table.

| # | Decision |
| --- | --- |
| Q1 | Price categories are **water Category 1, 2, 3 and Mold**. Trade categories (drywall, flooring, mold work...) are owner-named headings that group items; they carry no price, except an optional per-trade minimum (M7). |
| Q2 | "Area" means size: square-foot brackets (built) and finished/unfinished. No service regions now. Do not let "one table per company" block a second table for a multi-branch company later. |
| Q3 | Room types are the **owner's own list** (up to 30, seeded Kitchen, Bathroom, Bedroom, Living room, Hallway, Laundry, Garage, Other; Other always exists). A room type is a **label plus a suggested item list**. Price rows by room type exist but are **off by default** (company setting). |
| Q4 | Precedence: **category row, then default row**; with room-type pricing turned on, **room type plus category, room type, category, default**. A category row is used as set; only the default row gets the water multiplier. Square feet count toward brackets separately for each row. The editor previews "what does a Cat 3 kitchen pay?". |
| Q5 | Every room has a type, preselected **Other**. Because a type changes no price while room-type rows are off, the warning for Other appears only when they are on. Live voice may suggest a type; the estimator confirms. |
| Q6 | "Estimates of repairs" means the **mitigation work** DryScope prices today. Rebuild (installing drywall, flooring) is not priced; the required reconstruction exclusion stays. Rebuild would be its own decision and wording change. |
| Q7 | A draft is pinned at its **first estimate**. |
| Q8 | **Only the owner reprices** a draft, only on explicit review (spec 6.1). |
| Q9 | Template import and export are **CSV first**; Excel when an owner asks (it needs a new library). |
| Q10 | **Fresh sign-in (15 minutes) before publishing** prices, the same rule as team changes. |
| Q11 | Engine version name **`dryscope-v3`**. |
| Q12 | No old ADR rate book in the new app. **The owner's company enters its prices fresh in the new app; nothing is exported or imported from the old app.** Recorded as D-017, which supersedes D-010 and D-011 for the rebuild. |
| Q13 | A new company's first table is the **starter list of industry items and units with blank prices**, plus starter trade headings and room types; every item editable. Items use plain descriptions and DryScope scope codes: no Xactimate codes, no prices. |
| Q14 | **The owner chooses the range setting at first publish** (no silent default). The itemized claim stays a single-valued figure whatever the range setting; the customer range comes from drying days and the hidden-damage allowance the owner sets. |
| Q15 | Spec 6.1 open items as recommended: adjustments on bracket lines **yes**, by explicit item choice; minimum or trip charge again on a change order **off** unless selected; a parent column on the agreement for the change order's link. |
| M1 | "Room" means **per-room unit items plus room-size tiers (S/M/L/XL)**, not room-type prices. A price by room type stays possible but off by default. |
| M2 | DryScope produces the **signed proposal and an itemized claim in its own scope codes**, with an optional per-item "matches Xactimate line" note for the office. No ESX claim; no Xactimate codes or prices shipped. |
| M3 | **Water class is recorded, not priced.** It suggests equipment counts and drying days; the technician confirms. Class 4 specialty drying is priced as its own items. |
| M4 | **Equipment is priced per unit per 24 hours by size**; setup, takedown and monitoring are a separate **hourly** item. The proposal estimates drying days; actual days arrive later as a change order. |
| M5 | **After-hours is a per-item flag** (extraction and setup, never equipment days), not a job-wide markup. |
| M6 | **Overhead and profit is off by default on mitigation**; the owner may turn it on per estimate, it prints as its own line, and a per-item "no O&P" flag exempts items such as equipment rental. |
| M7 | A **job minimum plus an optional minimum per trade heading** (drywall, flooring, mold). |
| M8 | **Mold scope by condition** (Condition 3: removal plus cleaning; Condition 2: cleaning only); **containment by affected square feet** (up to 10, 10 to 100, over 100); **clearance testing is a separate item**. |
| M9 | **Tax applies to each item's materials share** (California construction contractors are generally consumers of the materials they install, Regulation 1521). The owner confirms the rate and the treatment with an accountant; this is not tax advice. |
| M10 | A **mold room**: the estimator marks the room **Mold** for its removal and cleaning lines; drying equipment is priced at **job level**. A room cannot be both Cat 3 and Mold; if the owner later needs both on one room, a separate "mold present" flag per room is the alternative (a second axis, to be asked first). |

**Owner actions that remain:** add `test-change-approved` on S4-2; review the worked-example table in S4-1; approve every merge; give the word to turn `price_books` on for a company; confirm the tax treatment with an accountant before a company's first tax setting is published.

## 10. Industry research

A web scout on 2026-11-10 compared the plan with how the restoration industry prices. Structure only; no price data or Xactimate codes are copied here. Not confirmed: the text of the paid S500 and S520 standards (handouts and summaries were used), and the price-list internals of competing tools (not public).

- **Category changes which items apply.** The industry has separate Category 3 versions of tear-out and extraction items and a Category 2 add-on, so a category price used as set matches practice ([Reets Drying Academy](https://reetsdryingacademy.com/blog/xactimate-line-items-for-water-mitigation/)).
- **Class sets equipment, not unit price.** IICRC's dehumidifier formula divides room cubic feet by a factor that depends on class and unit type ([IICRC](https://iicrc.org/wp-content/uploads/2024/04/US-Imperial-Initial-Dehumidification-Recommendation-Factors-and-Formulas.pdf)); making class a price axis would double-charge.
- **Mold condition sets scope; affected area sets containment.** S520 Conditions 1 to 3 ([ANSI summary](https://blog.ansi.org/ansi/ansi-iicrc-s520-2024-professional-mold-remediation/)); containment level follows affected area ([EPA mold course, chapter 6](https://www.epa.gov/mold/mold-course-chapter-6)). Contractors price mold per affected square foot with a minimum job charge; clearance testing is usually separate ([RestoreAdvisor](https://www.restoreadvisor.com/mold-remediation/cost-per-sq-ft)).
- **No tool I read prices by room type.** A room changes price through per-room items and room-size tiers (contents, block-and-pad), which is why room types became labels with item lists. This is an absence in what I found, not proof.
- **Equipment is billed per unit per 24 hours with a size in the item; monitoring is hourly; after-hours is its own item** ([Reets](https://reetsdryingacademy.com/blog/xactimate-line-items-for-water-mitigation/)).
- **Minimums are per trade** ([Verisk, labor minimums](https://www.verisk.com/49f39b/siteassets/media/downloads/property-estimating/how-to-calculate-labor-minimums-in-xactimate.pdf)). **O&P on mitigation is disputed** and often not allowed under three trades, so it defaults off.
- **An estimate is tied to one price list and date**, and Verisk treats price as agreement between buyer and seller ([Verisk methodology](https://www.verisk.com/4aa3b7/siteassets/media/downloads/property-estimating/pricing-research-methodology.pdf)); this supports owner-set prices and pinning at first estimate.
- **Mitigation and rebuild are billed separately**, and auditors object to stacked markups ([J.S. Held](https://www.jsheld.com/insights/articles/five-common-mistakes-in-t-m-mitigation-invoicing-strategies-to-avoid-them)), which supports Q6 and M6.
- **Tax** ([CDTFA Regulation 1521](https://cdtfa.ca.gov/lawguides/vol1/sutr/1521.html)) supports tax on the materials share (M9).
- **Every field tool I checked hands the final estimate to Xactimate**, which is why M2 adds an optional "matches" note instead of an ESX export.

## 11. Risks

| Risk | Effect | Handling |
| --- | --- | --- |
| Too many price rows to understand; owners will not guess the precedence. | Wrong estimates. | Editor shows one price per item until the owner turns on "Price varies by water category"; room-type rows are off by default; a "what does this room pay?" preview; the line text names the row used; at most 4 category rows per item (plus 4 x room types when turned on). |
| An owner with a 1.5 multiplier types a Cat 3 price expecting it to be multiplied. | Underpriced Cat 3 work. | The item shows "this category price replaces the multiplier"; multipliers sit under advanced settings and start at 1. |
| Category and size tier now move money. | A wrong category or tier changes the price. | Treated like square feet: Live may suggest it, the technician confirms it, the server prices it. |
| A water loss with mold growth cannot be Cat 3 and Mold on one room. | Mold lines priced from the wrong rows. | The estimator marks the room Mold for those lines; drying equipment stays at job level (M10); a second flag is the later alternative. |
| Removing the oracle removes a wide net. | A rule change goes unnoticed. | S4-1 lands first; exact-text and property tests; two independent reviews per step. |
| A version is `jsonb`, so SQL cannot check prices. | A bad row stored. | One Zod schema at write and read; the hash is rechecked on read; versions cannot be updated. |
| An engine change alters pinned drafts. | Prices move without the owner. | Version dispatch: once a version prices a signed job, its formulas never change; new formulas get a new version. |
| No S5 plan exists yet. | S5 steps here may move. | The S5 plan includes S5a-1 to S5b-4, or corrects this file. |
| Phone shows stale prices offline. | Confusion. | The copy is dated and read-only; totals only from the server. |
| Tax on a materials share set wrongly. | Wrong tax on proposals. | Blank by default; the owner confirms with an accountant (M9); the editor shows a plain example. |

## 12. Corrections

A pull request that needs this plan to change adds a dated entry here saying what changed and why.

- **2026-11-10, S4-1.** (a) The property "adding square feet or a quantity never lowers the low or high total" is checked with tiered brackets only. Whole-job mode prices a job just above a band boundary lower by design (`docs/sqft-brackets.md`; worked example W10), so it cannot hold there; the other properties run in both modes. (b) Beside `priceEstimate`, S4-1 adds `checkTable(table, acknowledgements)`, the publish check, because a blank price and an unconfirmed zero price are refused at publish, before any job is priced. (c) From `engine-normalization.test.ts`, the claim-date, addressee, photo-log and room-override cases are carried over; the cases that only pin Python's spellings (float versus integer text, a whitespace-only carrier line, approval-time text) are not, per D-017.
