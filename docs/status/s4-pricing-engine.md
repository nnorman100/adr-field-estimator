# Status: S4 TypeScript pricing engine

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| S4 TypeScript pricing engine (`web/src/engine/`) | yes | no (rebuild not live; the estimate route (#381) and Prices API (#340) use it in `web/`) | no | Port of the Python calculator, mandatory clauses, document builders and canonical proposal bytes. Stable entry `priceEstimate(table, job)` and the publish check `checkTable` (`web/src/engine/estimate.ts`, S4-1): plain JSON in and out, money as Decimal strings; hand-worked examples, exact clause text, carried-over document checks and seeded properties in `web/tests/unit/estimate-*.test.ts`, written from the plan rather than the old app's answers. The Python oracle tests and their stored answers (`tests/fixtures/pricing-oracle/`) were removed in S4-2; no A/B harness against live data. See `docs/pricing-source.md` and `docs/ARCHITECTURE.md` |
| Category rows and Mold in the price table, `dryscope-v3` (S4-4a) | yes (#317) | no (rebuild not live) | n/a | |
| Room inputs, per-room items, size tiers and room types (S4-4b) | yes (#320) | no (rebuild not live) | n/a | |
| Per-item pricing flags, trade minimums and materials share (S4-4c) | yes (#322) | no (rebuild not live) | n/a | |
| Per-room item quantities with `room:typed` (S4-4d) | yes (#386) | no (rebuild not live) | n/a | |
| Estimate high end priced like the low end, in whole cents | yes (#334) | no (rebuild not live) | n/a | |
| Cushion bands priced in one walk (large tables no longer quadratic) | yes (#455) | no (rebuild not live) | n/a | |
| Company names with dollar-sign pairs printed exactly in the standard clauses | yes (#463) | no (rebuild not live) | n/a | |
| Price table versions and working copies (S4-5) | yes (#333) | no (rebuild not live) | n/a | Migration `0009_price_tables` |
| Prices API: working copy, preview, publish, versions, CSV export (S4-6) | yes (#340) | no (rebuild not live) | n/a | |
| Price list import onto the working copy (S4-7) | yes (#344) | no (rebuild not live) | n/a | Needs `prices_manage` |
| Prices screens for owner editing and read-only viewing (S4-8) | yes (#380) | no (rebuild not live) | no | |
