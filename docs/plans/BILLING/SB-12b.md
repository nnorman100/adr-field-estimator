# Billing plan, step SB-12b

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-12b Read-only in the field database rules (S, High: `firestore.rules`).** Slice: rules.
- FS: `canEdit` also requires that the access record's `readOnly` is not true. `canRead` is unchanged.
- CI: the rules reach the test copy through the existing rules release job (S5a-R).
- Tests (emulator): with `readOnly` true every draft, room and photo write is refused and every read is allowed; with it false or absent the existing rules suite passes unchanged; the rules stay inside their expression and lookup limits (the S5a-1 measurement, repeated); a record written by the old projection (no field) still works.
- Needs: SB-12. Merged together with or after SB-13, so that no phone meets the rules refusal before it knows how to keep its work.
