# Screen specs (rebuilt app, `web/`)

One spec per screen of the rebuilt app, written from the code as it is built today. Every page under
`web/src/app/` has a spec: the jobs and field-work screens (first slice), the office and team
screens (second slice) and the platform and settings screens (third slice). This is the
per-screen companion to [docs/spec.md](../../spec.md), the approved feature spec, which describes the
retired app's screens and the rebuild's accepted target (its section 6). Where this folder and the
code disagree, the code wins and the spec is fixed. Where a screen and the access rules disagree,
the spec flags it under "Mismatches to check" and the code is left alone.

Sources used for every spec: the screen's files under `web/src/app/`, the role table in
`web/src/lib/access/roles.ts`, the access matrix in [docs/ACCESS.md](../../ACCESS.md) and its
files under `docs/access/`, and for "not built yet" [docs/STATUS.md](../../STATUS.md) and the
stage plans in `docs/plans/` (STATUS.md's files track both apps; the web app's screens are also tracked
by step in `docs/plans/S3.md`, `S5.md`, `S6.md`, `S7.md` and `S8.md`).

## Roles used in every spec

| Role | Who | How they reach a screen |
|---|---|---|
| Owner | the company's owner | the company's sign-in page, authenticator-app second step required |
| Estimator | field technician | the company's sign-in page; second step optional |
| Office | coordinator | the company's sign-in page, second step required |
| Superadmin support | the platform operator (not a company role, `docs/access/superadmin.md`) | a separate operator sign-in; in the web app the operator has its own screens under `/operator/...` and no company job screen |
| Different-company user | a signed-in member of another company | their own company's sign-in; every job route checks the company from the sign-in, so another company's job answers 404 |

Capability keys per role: `BASE_CAPABILITIES` and `PRICE_CAPABILITIES` in
`web/src/lib/access/roles.ts`, mirrored by [docs/access/roles.md](../../access/roles.md).

## Screen inventory

Every page under `web/src/app/` (`page.tsx`), and the views of the one field page. The field app is
one page, `/field`, whose views are picked by the address (`web/src/lib/field/views.ts`).

| Area | Screen | Address | Spec |
|---|---|---|---|
| Jobs and field work | Field app shell | `/field` | [field-shell.md](field-shell.md) |
| Jobs and field work | Jobs lists (Company jobs, My jobs, Archived drafts) | `/field`, `/field?list=mine\|company\|archived` | [jobs-list.md](jobs-list.md) |
| Jobs and field work | New job | `/field?view=new-job` | [new-job.md](new-job.md) |
| Jobs and field work | Check Scope (with Start field work) | `/field?job={id}` | [check-scope.md](check-scope.md) |
| Jobs and field work | Customer and claim | `/field?job={id}&view=customer` | [customer-and-claim.md](customer-and-claim.md) |
| Jobs and field work | Photos | `/field?job={id}&view=photos` | [photos.md](photos.md) |
| Jobs and field work | Job coordination | `/field?job={id}&view=coordination` | [job-coordination.md](job-coordination.md) |
| Jobs and field work | Job actions: archive, restore, copy | under every job view | [job-actions.md](job-actions.md) |
| Jobs and field work | Finish and review | `/sign-in/{address}/jobs/{id}/finish` | [finish.md](finish.md) |
| Jobs and field work | Review before signing (signing on the phone, signing link, document links) | `/sign-in/{address}/jobs/{id}/review` | [review.md](review.md) |
| Jobs and field work | Review and sign your estimate (homeowner link) | `/sign#token` | [sign-link.md](sign-link.md) |
| Jobs and field work | Signed estimate documents (document link) | `/documents#token` | [documents-link.md](documents-link.md) |
| Office and team | Team and invitations | `/sign-in/{address}/team` | [team.md](team.md) |
| Office and team | Accept invitation | `/sign-in/{address}/invitations/{invitationId}` | [invitation.md](invitation.md) |
| Platform and settings | Start page | `/` | [start-page.md](start-page.md) |
| Platform and settings | Company sign-in, second step and dashboard | `/sign-in/{address}` | [sign-in.md](sign-in.md) |
| Platform and settings | Company settings | `/sign-in/{address}/company` | [company-settings.md](company-settings.md) |
| Platform and settings | Prices | `/sign-in/{address}/prices` | [prices.md](prices.md) |
| Platform and settings | Operator: companies (and operator sign-in) | `/operator/{tenantId}` | [operator-companies.md](operator-companies.md) |
| Platform and settings | Operator: one company | `/operator/{tenantId}/companies/{companyId}` | [operator-company.md](operator-company.md) |
| Platform and settings | Operator: a company's team | `/operator/{tenantId}/companies/{companyId}/team` | [operator-team.md](operator-team.md) |

## Each spec's sections

Purpose; Who may see it and do what (one row per role above); States (empty, loading, error,
offline where relevant); Key actions and the server route each calls; Not built yet; Mismatches to
check. Wording in quotes is the screen's own text.

## Mismatches found

Each is flagged for the owner or a later fix; no code was changed.

1. No Check Scope action opens Finish and review. It is reached from the sync chip's "Changes not
   saved" sheet (only for a write refused because the draft was locked, being finished or finished,
   online, once the job reads: `web/src/app/field/sync-chip.tsx`) and from Review's "Back to Finish
   and review" button (before pricing and on a priced unsigned job); otherwise a technician must type
   `/sign-in/{address}/jobs/{id}/finish`. See [finish.md](finish.md).
2. Customer and claim: the screen offers Save to every estimator who can open the job, but the
   server (rightly, owner decision J3) lets an estimator save only while they own the job's field
   work, so an assigned estimator who does not own it fills the form and is refused. See
   [customer-and-claim.md](customer-and-claim.md).
3. `docs/ACCESS.md` names `CAPABILITIES` in `backend/workspaces.py` and `can()` in
   `public/workspaces.js` (the retired app) as the source of truth; for the web app the table is
   `web/src/lib/access/roles.ts`, held to `docs/access/roles.md` by `web/tests/unit/access.test.ts`.
4. `docs/access/superadmin.md` describes read-only support access to any company's jobs,
   documents and photos. In the web app no operator route reads a job (`web/src/app/api/platform/`);
   that is step S5b-5 (`docs/plans/S5/S5b-5.md`), not built.
5. Resolved: [docs/STATUS.md](../../STATUS.md) now has rows for the web app's screens (PRs #314 to
   #471 were added on 2026-11-19, for example "Job screens on the phone (S5a-6)" in
   `docs/status/s5-core-workflows.md`).
6. No field screen edits the draft's summary of findings, which Finish checks (S5 decision J1). Notes
   on Check Scope is a different key. An empty summary blocks pricing (`summary_missing`: Review says
   go back and write it, and nothing in the field app can). See [check-scope.md](check-scope.md),
   [finish.md](finish.md) and [review.md](review.md).
7. The signed documents' links are shown only in the first successful signing answer. A signer who
   misses it cannot recover the addresses; see [review.md](review.md).
8. Estimators and office hold `prices_read` while the company's prices are on, but no screen links
   to Prices for them: the only link is on Company settings, which only the owner opens. They must
   type `/sign-in/{address}/prices`. See [prices.md](prices.md) and [sign-in.md](sign-in.md).
9. After "Back to editing" answers 503 once the new draft ID is committed and the new draft is
   missing, an estimator who owns the field work gets the Start field work recovery, but a company
   owner who owns it does not: Check Scope and Photos show "The field work of this job is not there
   yet. Try again in a moment." and the owner's retry is "Back to editing" again. See
   [check-scope.md](check-scope.md) and [finish.md](finish.md).
