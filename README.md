# DryScope

DryScope is a phone web app for water and mold restoration companies. The goal is for a technician to document a loss in one walkthrough, review the scope and turn it into a priced, signable estimate backed by inspection evidence. Each company works in its own isolated workspace and uses its own prices.

The current app lives in [`web/`](web/). The rebuilt app runs in the test environment, with live rollout tracked in the [go-live plan](docs/plans/S8.md). The [runtime runbook](docs/runbook/where-things-run.md) lists its environments and addresses and explains how to identify the version serving each environment.

## Company workspaces

Access is by invitation. Owners manage their company and team, estimators work on their own or assigned jobs, and office staff coordinate jobs and access documents according to their role. See the [access matrix](docs/ACCESS.md) for role permissions.

## Inspection workflow

Technicians capture rooms, measurements, photos and walkthrough notes, then confirm the scope before generating documents. The server prices the estimate from the company's published price book. The intended result of a confirmed inspection is a proposal, an itemized claim, a scope defense letter and a photo moisture log. A homeowner can sign on site or through a private link. Signing binds the agreement to the saved revision.

Current limitation: pricing requires a separate summary of findings, and no field screen writes one yet. A technician can confirm the scope and finish a job that has only Notes, then be refused at "Price this job" with `summary_missing`. See the [review screen spec](docs/spec/screens/review.md) for details.

Field draft edits are kept on the phone only when the phone is set to keep them. That needs the company's trusted-phone storage choice (not "Online only") and, on iPhone, DryScope opened from the Home Screen rather than a Safari tab. Otherwise an edit not yet acknowledged by the server is lost if the window closes. See [core workflow status](docs/status/s5-core-workflows.md), [offline and photo status](docs/status/s6-offline.md) and [AI and live voice status](docs/status/s7-ai.md) for feature availability and phone acceptance.

Older documents may link to this section for the retired app's photo locations or homeowner email checkbox. For historical GPS guidance see [GPS stamp in the roadmap](docs/roadmap.md), and for document delivery see [Document delivery](docs/company-workspaces.md#document-delivery).

## Code and verification

The TypeScript app uses Next.js and Zod, with PostgreSQL for workspace and job records and Firestore for field drafts. See the [architecture](docs/ARCHITECTURE.md) and [product rules](docs/architecture/product-rules.md).

From the repository root, install dependencies with `npm ci`. The root checks are `npm run format:check`, `npm run lint` and `npx vitest run`.

For the app, run these commands from the repository root:

```bash
cd web
npm ci
cp env.example .env.local
npm run dev
```

The local app listens on `http://localhost:3100`, with health at `/api/health`. For local setup, the Java 21+ emulator requirement, Playwright browser installation and the per-package check commands, see the Commands section of [AGENTS.md](AGENTS.md#commands-what-ci-runs); for workflow details, see the [CI runbook](docs/runbook/ci.md). The [test release runbook](docs/runbook/test-release.md) covers releases for the rebuilt app.

## Retired app history

The previous app in `backend/` and `public/` used the `alert-disaster-field-2026` project. It was switched off on November 10, 2026. [RELEASES.md](RELEASES.md) records its historical releases, and the [legacy infrastructure notes](docs/firebase-isolation.md) document its former operation.

### Offline notes for bad reception — deployed, acceptance pending

In the retired app, technicians could queue voice notes on the phone during poor reception and review the transcripts after syncing. The [legacy infrastructure notes](docs/firebase-isolation.md) describe that workflow and its storage rules.
