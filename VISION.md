# Vision

`adr-field-estimator` exists so that a restoration technician can walk a water or mold loss once, talking and photographing as they go, and leave with an estimate the company can sign, defend and carry out.
It serves water and mold restoration companies in any state as paying subscribers, each in its own isolated company workspace.
It turns a confirmed inspection - rooms, measurements, categories, equipment, photos and the walkthrough transcript - into four documents: a proposal with a low-high estimate, an itemized claim, a scope defense letter and a photo moisture log.
It owns exactly one thing: the path from one water or mold loss inspection to a signed, priced, evidence-backed agreement, delivered to the people who need it and scheduled into drying work.

## Prices come from the company's own price book

The first company's current rates come from its own estimating workbook, which stays out of this repository; every other company prices from a template its owner fills in.
A subscribing company enters its own prices in a pricing template the owner fills in, and the server turns it into that company's price book; until it does, it cannot price an estimate. The first company's Excel workbook is never used for another company, and arbitrary workbook upload is not built (a fixed-template company price editor is built behind the default-off `PRICE_BOOKS_ENABLED` flag, and without that flag only the first company can price an estimate, per `docs/pricing-source.md`).
When a workbook and convention disagree, the company owner decides and the code mirrors the sheet, as the first company did with its after-hours labor rate.
The server computes every workbook-priced line in Decimal; a model never overrides a workbook total or removes required wording.
Each company sets its state, and the server inserts that state's mandatory notices, which the subscribing company maintains; the California notices stay exact.
Work the workbook does not cover is priced by hand through the manual, owner-approved path in [priced additional work](docs/priced-extras.md); the owner does not want AI-suggested prices for now, and none are built.

## AI does the typing; the technician attests

Gemini coaches the walkthrough, reads meter photos, drafts documents and fills the form from what the technician says.
Values the technician speaks during Live are priced as they are filled, and the technician reviews the whole proposal once at Finish and review before anything is signed.
Pending or failed recognition stays unverified, and work is described as proposed; recording dated, itemized completed work is a future feature, not built yet.
A provider failure produces a retry error, never a signable fallback.
The app never claims more than it can show: color emulation is not thermal evidence, an interrupted or delayed capture says so, and homeowner photos are marked as homeowner-supplied.

## A signature is a record

Audits and signatures bind to a saved revision and proposal hash, and any later edit to the scope or prices invalidates both.
A homeowner may sign on site or from their own phone through a link, under the same revision and hash binding (the link signs as the technician who sent it, works once, expires after 7 days and stops working on any edit; it is shared by QR code, copied link or the phone's share sheet, delivery behavior is described in [document delivery](docs/company-workspaces.md#document-delivery)).
Success is shown only after a durable server receipt.
After signing, office staff may correct address, name and contact fields without re-signing, and each correction is recorded in an audit entry naming who changed what.
Everything else in a signed agreement, its documents, its evidence and the walkthrough transcript never changes; later coordination lives in separate sidecars.

## The agreement reaches everyone it involves

Through the signing link, the homeowner can also upload photos and video of the loss, which join the photo log as evidence (not built yet; today the signing link is read-and-sign only, and the technician adds all photos).
After signing, the homeowner receives the signed proposal and photo log, the crew lead receives a job summary, and the adjuster receives the itemized claim, scope defense letter and scope-code JSON export. The owner-approved plan uses private links by email, with crew-lead texting later and no ESX claim; see Phase 2 in `docs/roadmap.md`. Current implementation and remaining recipient steps are recorded in [document delivery](docs/company-workspaces.md#document-delivery).
Office staff schedule the drying setup and monitoring visits on a crew calendar, technicians get reminders, and readings are logged per visit against the job (not built yet; today there is no crew calendar, reminder or per-visit reading log, and saving does not dispatch technicians, per `README.md`).

## Field work is never silently lost

The app runs on any phone or tablet browser as an installable web app, not as a native app for one platform.
Drafts save on the device first and sync when online; a conflict preserves local work and asks.
With no signal, capture continues on the device and is processed once back online, marked as delayed in the transcript.
Sign-out, app updates, reloads and reconnects stop before discarding unsynced work, and every gap is counted instead of hidden.

## Private, isolated and bounded

The rebuilt app uses dedicated DryScope projects. Each release targets its own environment, and peer sites and shared databases are never touched. See [where things run](docs/runbook/where-things-run.md).
Browsers never reach the database or the model directly; the backend checks identity, company membership and job access on every call.
Each company sees only its own jobs, recordings and uploaded prices.
Owners may see how their prices compare with anonymized aggregates drawn from five or more companies, never another company's name or jobs (not built yet; today the app computes no cross-company aggregates or price comparisons).
DryScope's superadmin, or a support role DryScope assigns, may open a subscriber's jobs read-only to diagnose a problem; every access is logged and visible to that company's owner (superadmin read-only support access with an audit log is built, per `docs/company-workspaces.md`; a separate support role and showing the log to the company's owner are not built yet).
The walkthrough is not recorded: Live audio and offline voice notes are transcribed and the audio is not kept, and the screened transcript is the record, bound to the signed agreement through the submitted draft (S7 decision V8 A, 2026-11-12). Keeping the audio would need a lawyer's review of California Penal Code 632 first.
Logs carry allowlisted fields only, never prompts, transcripts, emails, tokens or user paths.
Every AI call is capped per user per day and per company per month, so a bug or a stolen session cannot run up the bill.
The frontend stays a static web app with no build step and same-origin vendored dependencies.

## Proven before it is claimed

Every fix lands with a test that fails without it.
Mock results, real-service checks and physical device observations are recorded separately, and a device behavior stays open until it is observed on a device.
The retired legacy app is off and its project is never deployed to or changed (`docs/architecture/product-rules.md`). Its historical release record is `RELEASES.md`. DryScope releases use the [rebuilt app release workflow](docs/runbook/test-release.md).
Firestore rules, indexes, secret bindings and IAM grants are declared in the repo and applied by the same pipeline, never by hand in the console.
Each release carries its source commit, and what is serving the rebuilt app is read as `docs/runbook/where-things-run.md` describes. `RELEASES.md` is the historical record of the retired old app (several of its older rows show `unknown`, per `docs/firebase-isolation.md`).

## Scope

It estimates water and mold losses only; fire, smoke and other loss types are out of scope.
It is not a native iOS or Android app.
It is not a company's public website; any company's public site stays separate.

A change aligns when it makes one water or mold inspection faster, more complete or more defensible, or carries the signed result to the homeowner, crew, adjuster or drying schedule, while keeping workbook prices on the server.
A change aligns when it closes a gap between what the app claims and what it can prove, with a test or a device observation to show it.
A change should be resisted when it lets a model override a workbook price, changes a signed agreement's scope or prices, shows one company another company's jobs or identifiable prices, or weakens the dedicated-project boundary.
A change should be resisted when it ties the app to one phone platform, extends it beyond water and mold losses, or claims device, provider or production behavior that nobody has observed.
