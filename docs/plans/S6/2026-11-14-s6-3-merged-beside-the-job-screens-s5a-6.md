# S6 plan correction: 2026-11-14: S6-3 merged beside the job screens (S5a-6)

Part of [the S6 plan](../S6.md), section 12, "Corrections".

S5a-6 landed first with its own memory-cache Firestore client on the company app (`web/src/lib/field/session.ts`) and job screens (`field-app.tsx`) in the field shell. To merge S6-3 without changing those screens, the shell now shows S6-3's phone-storage section (`field-store.tsx`: the keep-jobs question, the window lock, the persistent per-person cache and the sync gate) with the job screens beside it. **Open, for the next S6 step (S6-4 or a follow-up):** move the job screens onto `src/lib/field-db.ts` (its client from `useFieldClient()`, every write through `fieldWrite()`), so their edits use the persistent cache, the sync gate and the unsent marks. Until then the job screens' edits are online only, as S5a-6 built them.
