# Status: S4 TypeScript pricing engine

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| S4 TypeScript pricing engine (`web/src/engine/`) | yes | no (library only; no route, flag or deploy uses it; the Python code prices every estimate) | no | Port of the Python calculator, mandatory clauses, document builders and canonical proposal bytes. Stable entry `priceEstimate(table, job)` and the publish check `checkTable` (`web/src/engine/estimate.ts`, S4-1): plain JSON in and out, money as Decimal strings; hand-worked examples, exact clause text, carried-over document checks and seeded properties in `web/tests/unit/estimate-*.test.ts`, written from the plan rather than the old app's answers. The Python oracle tests and their stored answers (`tests/fixtures/pricing-oracle/`) were removed in S4-2; no A/B harness against live data. See `docs/pricing-source.md` and `docs/ARCHITECTURE.md` |
