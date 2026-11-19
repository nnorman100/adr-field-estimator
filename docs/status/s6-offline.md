# Status: S6 offline work and photos

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

Nothing here is deployed to production: no live project exists yet (D-018). Earlier S6 steps (S6-3 field cache, #376) were merged before this batch.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Offline test harness and Safari/Firestore spike (S6-1) | yes (#339) | n/a | n/a | Offline Playwright suite in Chromium and WebKit |
| Offline field shell, manifest and service worker (S6-2) | yes (#345) | no (rebuild not live) | no | |
| iPhone tabs asked to save DryScope to the Home Screen, online only until then (D-025) | yes (#359) | no (rebuild not live) | no | Checked with desktop browsers using iPhone identities, not a real iPhone |
| Offline retention as one routine; bounded sync-gate waits (D-035) | yes (#388) | no (rebuild not live) | no | |
| Job screen edits saved on the phone first | yes (#407) | no (rebuild not live) | no | "Saved on this phone. Waiting to send." |
| Field edit journal in `ds-journal` (S6-4a) | yes (#439) | no (rebuild not live) | n/a | One shared IndexedDB wrapper |
| Sync chip and Can't save sheet (S6-4b) | yes (#460) | no (rebuild not live) | no | Save as new draft, Discard and Try again |
