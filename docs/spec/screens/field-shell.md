# Field app shell

Part of [Screen specs](README.md). Address: `/field` (every field view lives in this one page).
Built in: `web/src/app/field/page.tsx`, `field-shell.tsx`, `field-store.tsx`, `field-app.tsx`,
`banners.tsx`, `sync-chip.tsx`, `home-screen-sheet.tsx`. Stages S5a-6, S6-2, S6-3, S6-4.

## Purpose

The page a technician opens from the Home Screen, with or without signal. The server renders
nothing of a person's into it, so the service worker keeps one copy for everyone
(`web/src/app/field/page.tsx`). It starts from what was saved at the last online sign-in (`ds-me`),
asks once whether to keep jobs on this phone, then shows the field views (jobs lists, New job, the
job views) with a sync chip for changes not yet saved.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the shell, the company name, the sync chip | everything the views below allow |
| Estimator | the same | the same |
| Office | the same | the same |
| Superadmin support | nothing: the operator has no company sign-in, so the shell shows "Sign in to continue" | nothing |
| Different-company user | only their own company's shell: what is saved on the phone is kept per company and person (`meKey(tenantId, uid)`); another sign-in starts the screens afresh | nothing in this company |

## States

- Opening: "Opening…", then "Opening your jobs…".
- Nothing saved on this phone yet: "Sign in to continue" with "The first time on this phone needs a
  connection…" and a "Go to sign in" link to the remembered company sign-in address.
- Phone storage cannot be opened: the same sign-in text plus the "Not saved on this phone" banner.
- Phone storage stopped answering twice: "Reopen the app".
- The company has no field database yet: "The field database is not set up for this company yet."
- A sign-in saved before the person's id was kept: "Open this app once with a signal to finish
  setting it up."
- Signed out or sign-in lost: "Sign in again to see your jobs." with "Go to sign in".
- First open with storage: "Keep jobs on this phone?" with "Keep jobs on this phone" or
  "Online only" (`field-store-text.ts`).
- Offline banners (`banners.tsx`): "No signal: your work is saved on this phone"; with Online only,
  "No signal: jobs are not kept on this phone, so you need signal to work."; in a Safari tab, "No
  signal: in Safari, DryScope works online only. Save it to your Home Screen to work with no
  signal."
- Other gates (`field-store-text.ts`): open in another window ("Open DryScope in one window"), a
  browser without the locks needed ("This browser can't keep work offline"), sign-in too old for
  offline work ("Open the app once online to continue"), access off, company not active, sign in
  again to send, and kept changes removed or hidden after 30 days with access off.
- Sync chip: shown while the signed-in person's screens are; its sheet "Changes not saved" lists
  refused or changed edits with "Send again", "Discard changes" and "Save as new draft" (the last
  only for a role with `jobs_create` and `scope`).

## Key actions and server routes

| Action | Route or store |
|---|---|
| Learn who is signed in and their keys | `GET /api/me` (`web/src/lib/field/field-sync.ts`, `journal-sync.ts`) |
| Keep or not keep jobs on the phone | the phone's Firestore cache and journal only, no server route |
| Send again a refused change | the field database (Firestore) write again |
| Save as new draft (unsaved changes on a job that moved or locked) | `POST /api/jobs` with a new job and draft id, then the field database |
| Read a job named by an unsaved change | `GET /api/jobs/{id}` |

## Not built yet

- Any live voice walkthrough, voice notes or meter-photo reading in the field app (S7 steps,
  `docs/plans/S7.md`).
- Address suggestions and a job map (`places`, J9 in `docs/plans/S5.md`: needs a Maps key).

## Mismatches to check

None found for this screen.
