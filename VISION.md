# Vision

`adr-field-estimator` exists so that a restoration technician can walk a water or mold loss once, talking and photographing as they go, and leave with an estimate the company can sign, defend and carry out.
It serves Alert Disaster Restoration first, and other restoration companies in any state as paying subscribers in isolated company workspaces.
It turns a confirmed inspection - rooms, measurements, categories, equipment, photos and the walkthrough recording - into four documents: a proposal with a low-high estimate, an itemized claim, a scope defense letter and a photo moisture log.
It owns exactly one thing: the path from one water or mold loss inspection to a signed, priced, evidence-backed agreement, delivered to the people who need it and scheduled into drying work.

## Prices come from the company's sheet

Each company prices from its own estimating workbook; ADR's is the `Residential Estimate Tool` sheet, traced cell by cell in `docs/pricing-source.md`.
A subscribing company uploads its own workbook, and the server turns it into that company's price book with the same cell-traced formulas; until it does, it prices from ADR's workbook (not built yet; today there is no workbook upload and every company prices from ADR's `Residential Estimate Tool` sheet, per `docs/pricing-source.md`).
When a workbook and convention disagree, the company owner decides and the code mirrors the sheet, as ADR did with the $47.46 after-hours labor rate.
The server computes every workbook-priced line in Decimal; a model never overrides a workbook total or removes required wording.
Each company sets its state, and the server inserts that state's mandatory notices, which the subscribing company maintains; ADR's California notices stay exact.
Work the workbook does not cover may carry a model-suggested price, labeled AI-suggested; every suggested price needs the technician's explicit acceptance (not built yet; today a model never supplies a price and unpriced work blocks signing, per `AGENTS.md`).

## AI does the typing; the technician attests

Gemini coaches the walkthrough, reads meter photos, drafts documents and fills the form from what the technician says.
Values the technician speaks during Live are priced as they are filled, and the technician reviews the whole proposal once at Finish and review before anything is signed.
Pending or failed recognition stays unverified, and work is described as proposed; recording dated, itemized completed work is a future feature, not built yet.
A provider failure produces a retry error, never a signable fallback.
The app never claims more than it can show: color emulation is not thermal evidence, an interrupted or delayed capture says so, and homeowner photos are marked as homeowner-supplied.

## A signature is a record

Audits and signatures bind to a saved revision and proposal hash, and any later edit to the scope or prices invalidates both.
A homeowner may sign on site or from their own phone through a link, under the same revision and hash binding (the link signs as the technician who sent it, works once, expires after 7 days and stops working on any edit; it is shared by QR code, copied link or the phone's share sheet, and the server sends no email or text, per `docs/firebase-isolation.md`).
Success is shown only after a durable server receipt.
After signing, office staff may correct address, name and contact fields without re-signing, and each correction is recorded in an audit entry naming who changed what.
Everything else in a signed agreement, its documents, its evidence and the walkthrough recording never changes; later coordination lives in separate sidecars.

## The agreement reaches everyone it involves

Through the signing link, the homeowner can also upload photos and video of the loss, which join the photo log as evidence (not built yet; today the signing link is read-and-sign only, and the technician adds all photos).
After signing, the homeowner receives the signed proposal and photo log by email, the crew lead receives a job summary by text, and the adjuster receives the ESX file, itemized claim and scope defense letter (not built yet; today the app sends no email or text and has no delivery step after signing, as `README.md` says, and the ESX file does not exist: it exports ADR-scope-code JSON and makes no ESX compatibility claim, per `AGENTS.md`).
Office staff schedule the drying setup and monitoring visits on a crew calendar, technicians get reminders, and readings are logged per visit against the job (not built yet; today there is no crew calendar, reminder or per-visit reading log, and saving does not dispatch technicians, per `README.md`).

## Field work is never silently lost

The app runs on any phone or tablet browser as an installable web app, not as a native app for one platform.
Drafts save on the device first and sync when online; a conflict preserves local work and asks.
With no signal, capture continues on the device and is processed once back online, marked as delayed in the transcript.
Sign-out, app updates, reloads and reconnects stop before discarding unsynced work, and every gap is counted instead of hidden.

## Private, isolated and bounded

Everything lives in the dedicated `alert-disaster-field-2026` project; peer sites and shared databases are never touched, and every deploy is target-scoped.
Browsers never reach the database or the model directly; the backend checks identity, company membership and job access on every call.
Each company sees only its own jobs, recordings and uploaded prices.
Owners may see how their prices compare with anonymized aggregates drawn from five or more companies, never another company's name or jobs (not built yet; today the app computes no cross-company aggregates or price comparisons).
ADR's superadmin, or a support role ADR assigns, may open a subscriber's jobs read-only to diagnose a problem; every access is logged and visible to that company's owner (superadmin read-only support access with an audit log is built, per `docs/company-workspaces.md`; a separate support role and showing the log to the company's owner are not built yet).
The walkthrough is recorded from the start of Live, the signed proposal carries the recording notice, and the audio and frames are kept in the private evidence bucket, bound to the signed agreement (not built yet; today Live audio and offline voice notes are transcribed without the audio being stored, and the proposal has no recording notice, per `docs/firebase-isolation.md`).
Logs carry allowlisted fields only, never prompts, transcripts, emails, tokens or user paths.
Every AI call is capped per user per day, so a bug or a stolen session cannot run up the bill.
The frontend stays a static web app with no build step and same-origin vendored dependencies.

## Proven before it is claimed

Every fix lands with a test that fails without it.
Mock results, real-service checks and physical device observations are recorded separately, and a device behavior stays open until it is observed on a device.
Every merge that passes CI is deployed automatically: the backend is staged and verified, then promoted, then only `hosting:alert-disaster` is deployed, with automatic rollback on a failed health check (not built yet; today every release is staged, checked and promoted only on the owner's explicit approval, per `RELEASES.md`).
Firestore rules, indexes, secret bindings and IAM grants are declared in the repo and applied by the same pipeline, never by hand in the console.
Each release carries its source commit, and `RELEASES.md` is the one record of what is serving (partly built; today releases made by the stamping scripts carry their commit, but several older `RELEASES.md` rows show `unknown`, per `docs/firebase-isolation.md`).

## Scope

It estimates water and mold losses only; fire, smoke and other loss types are out of scope.
It is not a native iOS or Android app.
It is not ADR's public website; `alertdisaster.com` stays separate.

A change aligns when it makes one water or mold inspection faster, more complete or more defensible, or carries the signed result to the homeowner, crew, adjuster or drying schedule, while keeping workbook prices on the server and AI-suggested prices labeled.
A change aligns when it closes a gap between what the app claims and what it can prove, with a test or a device observation to show it.
A change should be resisted when it lets a model override a workbook price, changes a signed agreement's scope or prices, shows one company another company's jobs or identifiable prices, or weakens the dedicated-project boundary.
A change should be resisted when it ties the app to one phone platform, extends it beyond water and mold losses, or claims device, provider or production behavior that nobody has observed.
