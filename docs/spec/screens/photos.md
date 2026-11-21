# Photos

Part of [Screen specs](README.md). Address: `/field?job={id}&view=photos`. Built in:
`web/src/app/field/photos-view.tsx`, `web/src/lib/field/api.ts` (`sendPhoto`, `photoAddress`).
Stages S5a-5, S5a-6, S6-5, S5b-11.

## Purpose

Take photos of the loss with the phone's camera, each with a room ("No room" or one of the job's
rooms) and a shot tag, and see the job's photos. The photo's bytes go to the server; its room and
tag are then written to the job's field draft.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the job's photos | take photos only once they own the job's field work and the draft is being edited |
| Estimator | the photos of a job whose field work they own (the Photos tab lists the photos from the job's draft, which an estimator may read only while they own it); on a job another person owns, opened afresh, only "Another person owns this job's field work, so it is not shown here. The company owner can move it to you."; after the app records a move away, the open job keeps the photos it had loaded, read only, under "This job's field work is no longer yours…" (reopening the job in the same field shell remounts the thumbnails, which fetch the retained photo references again, so they show only while the person still has job access: an estimator who made the job keeps it, and one who was assigned and then unassigned has lost it and gets 404); a fresh page shows the ownership notice if they still have job access, or 404 if they lost it ([Check Scope](check-scope.md)) | take photos on jobs whose field work they own, while the draft is being edited |
| Office | the job's photos, read only | nothing (no `photos`) |
| Superadmin support | nothing | nothing |
| Different-company user | nothing: 404 | nothing |

"Take a photo" shows only when the job is editable for this person, they hold `photos` and the phone
is online (`canTake` in `photos-view.tsx`). The server also refuses a person who does not own the
field work, a draft that is being submitted or is submitted, a signed job and a job past the photo
cap (`docs/access/photos.md`).

## States

- Empty: "No photos yet.".
- Offline: "Needs a connection to send photos. Keep this window open until every photo is sent."
- Per photo being sent: "Sending the photo…", "Saving its room and tag…", "Not sent yet.", with a
  send-again button.
- Failures: "The photo is stored but its room and tag were not saved. Save again."; refused or
  changed on another device (see the sync chip's "Can't save" and "Changed on another device"); "Not
  sent: this job is archived."; "Not sent: another person now owns this job's field work."; "This
  picture could not be read. Take the photo with the camera."
- Photo cap reached: no more photos (the draft holds at most `MAX_PHOTO_REFS`, 300).
- Readiness on ([Check Scope](check-scope.md), "Ready to review?"): with a room chosen, "Photos still
  needed in {room}" lists the baseline shots (overview, affected surface, moisture meter) the
  readiness check lacks for it; each button selects that shot tag and moves focus to the camera. A
  Fix link from [Finish](finish.md) opens this tab with the room and shot already chosen.

## Key actions and server routes

| Action | Route or store | Key |
|---|---|---|
| Send a photo's bytes | `PUT /api/jobs/{id}/photos/{photoId}?kind=photo` | `photos`, field owner |
| Save its room and tag | the field database draft, checked by `web/firestore.rules` | field owner |
| Show a photo | `GET /api/jobs/{id}/photos/{photoId}?kind=photo` | `jobs_read` |

"Start field work" can appear on this tab too, on a job nobody owns. A job that names this person but whose current draft is not there or does not name them yet shows no prompt: the job read gets it ready (the draft life-cycle redesign, slice 6: the read syncs the job's drafts from Postgres when they fell behind or the current draft is missing) and the screen shows "Getting this job's field work ready…" while it reads the job again (1, 2, 4, 8 and 8 seconds), then "This job's field work is not ready on this phone yet. Try again in a moment." with Try again (see [check-scope.md](check-scope.md)). Meanwhile no photo is taken or sent: a send already under way when it starts is held as its upload answers ("Not sent: this job's field work is being got ready. Send it again in a moment."). Only the draft waits: Customer and claim and Job coordination stay as they are, and the job is read again only while Check Scope or Photos is open.

The photo-by-ID route uses job access (`jobs_read`), but the tab needs the draft's photo references, so
it shows no photos to an estimator who cannot read the draft. The photos retained after a move are
those the open job already loaded, or the retained photo references when the job is reopened in the same field shell (whose thumbnails are fetched again, 404 only for an estimator who lost job access, such as one unassigned from a job they did not make); a fresh page does not show them.

Rules: `docs/access/photos.md`.

## Not built yet

- Sending a photo's full-size original later on Wi-Fi from this screen: the route
  (`?kind=original`) exists, the queue on the phone is S6 work (J9 in `docs/plans/S5.md`).
- Taking photos with no signal: the screen needs a connection to send each photo.
- Meter-photo reading (`ocr`, S7) and homeowner photo upload (not planned).

## Mismatches to check

None found.
