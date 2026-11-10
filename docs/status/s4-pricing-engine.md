# Status: S4 TypeScript pricing engine

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| S4 TypeScript pricing engine (`web/src/engine/`) | yes | no (library only; no route, flag or deploy uses it; the Python code prices every estimate) | no | Port of the Python calculator, mandatory clauses, document builders and canonical proposal bytes. Vitest (`web/tests/unit/pricing-oracle.test.ts`, `coercion-oracle.test.ts`) requires the same answers, accept/reject results and dumped values as the pinned oracle in `tests/fixtures/pricing-oracle/`. No A/B harness against live data yet. See `docs/pricing-source.md` and `docs/ARCHITECTURE.md` |
