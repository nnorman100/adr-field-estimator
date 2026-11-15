# Data: Rebuilt app field database: Firestore rules

Part of [Data](../DATA.md).

## Rebuilt app field database (not deployed)

`web/firestore.rules` holds the rules for the rebuilt app's Firestore field database. They are
checked in the emulator (`web/tests/emu/rules/`); the test release workflow releases them to `dryscope-field-test`
(`docs/runbook/test-release.md`) and live is still released by the owner. The server writes the
company header and the access records (`web/src/lib/projection/`, S3-12); drafts are later work.
The rules deny every path they do not name. They read three server-written records:

| Path | Fields the rules read | Who may change it |
| --- | --- | --- |
| `companies/{companyId}` (company header) | `authTenantId`, the company's sign-in tenant | server only |
| `companies/{companyId}/access/{uid}` (access record) | `role` (owner, estimator or office) and `expiresAt` (a timestamp; the record stops working then) | server only |
| `companies/{companyId}/drafts/{draftId}`, its `rooms/{roomId}` and its `photos/{photoId}` | draft: `fieldOwnerUid` and `state` (editing, submitting or submitted); client data sits in one `field` map in each document. `fieldOwnerRevision` (S5b-1) is a server key the rules do not read | the draft's field owner changes only `field`, while the draft is `editing`; the server creates and removes drafts. `POST /api/jobs` (S5a-3) makes a job's first draft after its Postgres row, as `{ fieldOwnerUid, state: 'editing', field: {} }` (no `fieldOwnerUid` key while nobody owns the field work), and a retry makes it only if it is missing |

Every read or write needs a token whose `firebase.tenant` is the company's `authTenantId` and an
unexpired access record for that uid in that company. With both, owner and office read every draft
of the company and an estimator reads only drafts they own in the field. Only the field owner, as
owner or estimator, writes, and only the `field` map: of a draft, or of a room or photo reference
under it (created holding only `field`; no other collection and nothing deeper). The field owner
may also delete a room document of an editing draft (owner decision, 2026-11-13, S5a-6: the phone
removes the room from `roomOrder` in the same batch); a photo reference is never deleted by a
client. A draft that is `submitting` or `submitted` refuses every client write.

The draft's `fieldOwnerUid` is the server's copy of `jobs.field_owner_actor_id` in Postgres (S5b-1). An
office user's job starts with none, so nobody but the owner and office reads its draft and nobody writes
it. The first person who does field work and may see the job starts it (`POST /api/jobs/{id}/field-owner`):
Postgres records them once, then the server sets `fieldOwnerUid` in a Firestore transaction. When the
owner moves the field work (owner decision J5) the server sets it again, so the phone that held it is
refused from then on; its unsent changes stay on that phone (S6 offers Save as new draft). Each set also
writes `fieldOwnerRevision`, the job's coordination revision (`job_coordination.revision`) it was made at, and a set carrying an older revision changes
nothing, so a slow request never puts back an earlier owner. A client can change neither key: the rules
let it change only `field`.

Each `field` map follows field map v2 (S5a-1, room inputs S5a-10, `web/src/lib/field/schema.ts`), and the rules refuse
a key it does not name, a value of the wrong type, and a text, number or list outside its size. Every
key is optional; clearing a value deletes its key.

| Document | `field` keys |
| --- | --- |
| Draft | `yearBuilt`; `roomOrder` (room ids, at most 30, no repeats); `notes` (up to 40,000 characters) and `summary` (the written summary of findings, up to 6,000); `scopeConfirmed`; equipment counts `airMovers`, `dehumidifiers`, `airScrubbers`, `woodFloorSystems` with `dryingDays` and `woodFloorDays`; job charges `emergencyCalls`, `monitoringHours`, `haulLoads`, `hepaFilters`, `matterportScans`, `dumpTruckLoads`, `equipmentDecon`, `powerDistribution`, `laborHours`, `isAfterHours` |
| Room | `name`; `roomTypeId` (a room type of the job's price version; absent is Other); `category` (1 to 3, or `mold`); `waterClass` (1 to 4) and `ceilingHeightFt` for a water room, `moldCondition` (1 to 3) and `affectedSf` for a mold room; `unfinishedSf`, `finishedSf`, `floorSf`, `wetFloorSf`, `wastePercent`; `items` (a map of price-list item id to typed quantity, at most 50); `prepTasks` (at most 10 texts of up to 300 characters: a company template's words, copied when picked, or the estimator's own); `findings` (the room's findings note, up to 2,000 characters) |
| Photo reference | `roomId`, `shotTag` (overview, source, surface, meter, contents or equipment), `capturedAt` (client-clock ISO 8601 datetime when taken, up to 40 characters) |

`notes`, `summary`, a room's `prepTasks` and `findings` are free text and may hold personal details,
so they are personal data. The rules cannot loop over a list, so they check each `roomOrder` entry
by joining and splitting it (a string id of `[A-Za-z0-9_-]{1,64}`, at most 30, no repeats), and a
room's `items` and `prepTasks`, which have a fixed largest size, entry by entry. Room and photo
document ids must match the same shape. Collection counts cannot be capped in rules; Submit reads
a bounded number of rooms and photo references (`docs/ACCESS.md`, "F5 draft safety bounds").
Whether a room type or item is in the job's price version is the server's check at Submit
(and the estimate's again). The server also checks `roomOrder` when it reads the draft
(`toInspection` in `web/src/lib/field/inspection.ts` maps a draft and its rooms to the engine's
inspection JSON). Each write reads the company header, the access record and, for a room or photo,
the draft: three documents of the 10 a write may read. A batched write may read 20 in all; counted
write by write, that is the draft update (two reads) and six room or photo writes (three each).
