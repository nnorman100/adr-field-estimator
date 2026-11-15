# S5 plan correction: 2026-11-15, photo capture time (S5a-9c follow-up)

Part of [the S5 plan](../S5.md), section 12, "Corrections".

- **2026-11-15, photo capture time (S5a-9c follow-up).** The phone records `capturedAt` (client-clock ISO string) on `photo.field` when a photo is taken (`web/firestore.rules` checks string type, ISO format and length); no DB migration is needed. `photoLog()` orders each room or album by `capturedAt` (ties broken by photo id), leaving untimed records last in snapshot order, and omits `captured_at` from rows without `capturedAt` so companies with no timed photos receive byte-identical documents.
