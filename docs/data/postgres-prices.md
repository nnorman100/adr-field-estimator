# Data: Rebuilt app Postgres: price tables

Part of [Data](../DATA.md).

`0009_price_tables` adds the company price tables (S4-5, `docs/plans/pricing.md`); the Prices API
(S4-6, `docs/ACCESS.md`) reads and writes them. Both hold a company's rows only inside `withCompany`, with forced row-level security.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `price_table_versions` | Every published table, whole: numbered `sequence` per company, `content` (`jsonb`), `content_hash` (64 lowercase hex), `engine_version` (`dryscope-v` and a number), `reason` (3 to 500 characters), `source` (`blank`, `import` or `restore`), `published_by_actor_id`, `published_at`, `publish_key` | `SELECT`, `INSERT`; never changed or removed |
| `price_table_working_copies` | The one table the owner is editing, one row per company (not a job draft): `base_sequence` (the version it started from, empty for a new company), `content`, `revision` | `SELECT`, `INSERT`, and `UPDATE` of `base_sequence`, `content`, `revision` and `updated_at` only |

- A company's current prices are its highest `sequence`. Keys per company: `sequence`, `publish_key`
  and `id` are each unique with `company_id`, so a later row (S5a's job price pins) names a version by
  company and id, or company and sequence, and can never name another company's. The publisher and the
  working copy's base version use the same composite keys.
- A trigger gives a version the company's next number (1, 2, 3, no gap, no repeat), so two publishes at
  once cannot both take number n: the second waits and is refused. A retried publish with the same
  `publish_key` is refused by the unique key, and the route answers it from the stored version.
- A trigger starts a working copy at revision 1 and lets each change raise it by exactly one, so a save
  from a stale copy is refused (the route's `WHERE revision = expected` finds no row; a blind save fails
  the check).
- The write policies refuse an active platform operator: an operator reads a company's prices through
  `withOperator` with that company set, and can never change them.
- `content` is `jsonb`, so SQL checks only that it is an object. The `PriceTableV3` schema checks the
  prices when a table is written and read, and the hash is checked again on read.
- The Check Scope item list (S6-8) is read from the current published row; its response is described in
  [Prices API](../access/prices.md).
