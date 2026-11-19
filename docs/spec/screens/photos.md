# Photos

Part of [Screen specs](README.md). Address: `/field?job={id}&view=photos`. Built in:
`web/src/app/field/photos-view.tsx`, `web/src/lib/field/api.ts` (`sendPhoto`, `photoAddress`).
Stages S5a-5, S5a-6, S6-5.

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

## Key actions and server routes

| Action | Route or store | Key |
|---|---|---|
| Send a photo's bytes | `PUT /api/jobs/{id}/photos/{photoId}?kind=photo` | `photos`, field owner |
| Save its room and tag | the field database draft, checked by `web/firestore.rules` | field owner |
| Show a photo | `GET /api/jobs/{id}/photos/{photoId}?kind=photo` | `jobs_read` |

"Start field work" can appear on this tab too: on a job nobody owns, or as the recovery prompt on a job that names this person but whose current draft does not (the first Start or an owner's move, to this estimator or to the owner themself, committed and its draft step did not finish; or, for the field owner (an estimator or the company owner), a "Back to editing" answered 503 after the new draft ID was committed and the draft is missing). The recovery prompt also appears to an estimator named as field owner of a job whose first draft was never made, where Start answers 503 again: it can only rebuild from a last submission, so the repair is to send the original New job, Copy or Save as new draft again with its original IDs. A company owner named as field owner of such a job gets no prompt, only "The field work of this job is not there yet. Try again in a moment.". See [Check Scope](check-scope.md) for every trigger and what Start can repair.

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
