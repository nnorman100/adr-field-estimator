# Data: Rebuilt app Postgres: core job tables

Part of [Data](../DATA.md).

`0010_core_job_tables` adds the job header, customer, claim and evidence registry tables and the company
profile columns (S5a-2, `docs/plans/S5.md`); the jobs routes (S5a-3, `docs/ACCESS.md`) read and write `jobs`, `job_customers` and `job_claims`, and the photo routes (S5a-5, `docs/ACCESS.md` "Photo routes") insert and read `evidence_objects`. All four tables hold a
company's rows only inside `withCompany`, with forced row-level security. A key between rows always carries
`company_id`, so a row can never point at another company's job or person.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `jobs` | One row per job, keyed `(company_id, id)` with `id` made on the phone (no server default): `created_by_actor_id`, `field_owner_actor_id` (empty until someone owns the field work), `status` (`draft`, `submitted`, `signed`, `archived`), `current_draft_id` (the Firestore field draft; one job per draft in a company), `property_address`, `archived_at` and `archived_by_actor_id` (set exactly when `status` is `archived`), `revision`, `last_change_id`, `request_digest` (SHA-256 of the create request) | `SELECT`, `INSERT`, and `UPDATE` of `field_owner_actor_id`, `status`, `current_draft_id`, `property_address`, `archived_at`, `archived_by_actor_id`, `revision`, `last_change_id` and `updated_at` only |
| `job_customers` | At most one row per job: `name`, `phone`, `email` | `SELECT`, `INSERT`, and `UPDATE` of those three and `updated_at` |
| `job_claims` | At most one row per job: `carrier`, `claim_number`, `policy_number`, `date_of_loss`, `loss_cause`, `adjuster_name`, `adjuster_email`, `adjuster_phone`, `deductible` (the fields the documents print) | `SELECT`, `INSERT`, and `UPDATE` of those columns and `updated_at` |
| `evidence_objects` | The registry of stored bytes: `job_id`, `object_id` (the photo's or signature's client id), `kind` (`photo`, `original`, `signature`), `object_name` in the evidence bucket, `generation`, `sha256`, `size_bytes`, `content_type`, `created_by_actor_id` | `SELECT`, `INSERT`; never changed or removed |

- `companies` gains `profile_address`, `profile_phone`, `profile_email`, `profile_license` and
  `profile_signoff`, empty until set, one line each. The runtime may `UPDATE` those columns of its own company
  and nothing else on the row: a trigger refuses a change to `status` or `auth_tenant_id` from a company's
  own transaction, and refuses a platform operator any change to the profile (the operator keeps 0006's
  status and sign-in tenant rights). That only the owner changes the profile is the route's rule
  (`profile_manage`, S5a-4).
- `revision` starts at 1 and each change raises it by exactly one (a trigger; since 0015 a change of the field owner alone keeps it), so a save made from an older
  copy is refused and a blind save fails the check (the jobs routes compare it under the job's row lock); a job
  starts as a `draft`.
  `last_change_id` is the client's id for the latest change, so a retry that carries it again is not a
  conflict; the routes decide that, and the same job id with another body is told by `request_digest`.
- An `evidence_objects.object_name` must sit under `companies/<company id>/jobs/<job id>/` and use only
  letters, digits and `. _ - /` (no uid, no person's name, no dot segments), so a row can never register
  another company's or job's bytes. Unique per job, object and kind, and per object name, so a retried
  receipt finds its row. `(company_id, id)` is a unique key so a later agreement can name its signature.
- The photo routes register a photo and its full-size original as two rows of one `object_id`, named
  `companies/<company id>/jobs/<job id>/photos/<photo id>` and `.../originals/<photo id>` (no hash, type or
  extension in the name: one photo id is one object, and a second upload of it is refused by the bucket's
  create-only precondition). `sha256` is the hash the server computed, `generation` the bucket's, and
  `content_type` one of `image/jpeg`, `image/png`, `image/webp`, told from the bytes. The object carries its
  own `sha256` in its metadata, so a first attempt that stored the bytes and lost its place is registered by
  the retry. The row is inserted once and never changed.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write
  policy refuses an active operator, so an operator never changes a job, its customer or claim, the registry
  or a company's profile.
- Personal data: `jobs.property_address`, `job_customers` (`name`, `phone`, `email`) and `job_claims`
  (`adjuster_name`, `adjuster_email`, `adjuster_phone`, the carrier, claim and policy numbers, `loss_cause`,
  `deductible`, `date_of_loss`). `evidence_objects` holds object names made of ids, hashes and sizes only.
  The company profile columns are the company's own business details, printed on its documents. Logs and
  audit details hold ids and counts only.

## Office jobs, assignment and the field owner (`0015_office_jobs`, S5b-1)

`0015_office_jobs` adds three tables (S5b-1, `docs/plans/S5.md`); nothing earlier changes. The routes over the
first two are under "Office jobs routes" in `docs/access/jobs.md`; `agreement_corrections` is for S5b-4,
which adds its routes. Each holds a company's rows only inside `withCompany`, with forced row-level
security, a company policy, keys that carry `company_id`, no `DELETE` or `TRUNCATE` for the runtime, and
the read-only operator policy (an operator reads through `withOperator`; every write policy refuses one).

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `job_assignments` | An estimator assigned to a job: `id` made on the phone, `job_id`, `estimator_actor_id`, `request_digest` (SHA-256 of the assign request), `assigned_by_actor_id`, `assigned_at`, and `ended_at` with `ended_by_actor_id` once unassigned. At most one active row per job and estimator | `SELECT`, `INSERT`, and `UPDATE` of `ended_at` and `ended_by_actor_id`; a trigger keeps every other column as made, lets an active row end once (the time from the clock) and freezes an ended row |
| `job_coordination` | At most one row per job: `office_notes` (up to 4,000 characters; line breaks and tabs, no other control character), `revision` (the coordination revision: 1 when the row is made, up by one with each note or field owner change), `last_change_id` | `SELECT`, `INSERT`, and `UPDATE` of `office_notes`, `revision`, `last_change_id` and `updated_at` |
| `agreement_corrections` | A correction of a signed job's `property_address`, `customer_name`, `customer_phone` or `customer_email` beside its agreement (same job): `id` made on the phone, `field`, `value` (one line, the corrected column's limits), `request_digest`, `created_by_actor_id`, `created_at` | `SELECT`, `INSERT`; never changed or removed, and the agreement it sits beside never changes |

- Who owns a job's field work is `jobs.field_owner_actor_id` (0010): empty on an office user's job until the
  first capture (`POST /api/jobs/{id}/field-owner`), then set once; only the owner moves it (owner decision
  J5). The Firestore draft's `fieldOwnerUid` is the server's copy of it (`data/field-rules.md`). A change of
  the field owner alone keeps the job `revision` (0015 lets the revision trigger allow exactly that) and
  moves the coordination revision instead, as a note does, so neither voids a reviewed estimate or a
  signing link.
- Personal data: `job_coordination.office_notes` is free text the office writes and may hold personal
  details (a gate code, a phone number); `agreement_corrections.value` holds the corrected address, name,
  phone or email. `job_assignments` holds ids and times only. Audit details hold ids and revisions only.

## Draft claims (`0016_job_drafts`, security audit F1)

`0016_job_drafts` adds one table; nothing earlier changes. `job_drafts` claims each Firestore field draft id
once per company for one job: `company_id`, `draft_id` (made on the phone), `job_id`, with the
key on company and draft id. The server claims a draft id in the same transaction that puts a job on it (a
new job, a copy, Back to editing), after the job row, and a draft id already claimed, by another job or by
an earlier draft of the same job, or named by any submission, is 409 `conflict`. So no job takes another
job's draft, even one that job submitted and moved on from, including one the previous version (still
serving while a release migrates) put a job on without claiming it. A retry of a create, copy or Back to editing
holds its draft id for the job in the table (claimed by the job, or claimed for it now when no job has
claimed it and no other job's submission names it) in a transaction that commits before it touches the
field database, and only then stamps the job id on a draft made before drafts carried it, so a lost answer
from that stamp never leaves the draft stamped without its claim. The first capture and the owner's move name the
field owner only on drafts the table gives the job: the drafts of its own submissions and its current draft
that no job has claimed are claimed for the job first, a submitted draft another job claimed is left out,
and a current draft another job claimed is 409. The
runtime has `SELECT` and `INSERT` only, under forced row-level security with company policies and the
read-only operator policy, so a claim never moves or goes away.

The file fills the table from each job's current draft and the draft of each of its submissions, reading the
jobs and submissions as their owner with row-level security unforced for that one transaction and forced again
before it ends. Before the fill it checks the existing data (security audit F1, step 5) and stops, changing
nothing, with an error naming each job by company and job id, when a draft id is named by more than one job,
or when a job in status `draft` is on a draft that was already submitted (a committed submission of its
current draft; Submit writes the Firestore draft's `submitted` state from that record, so the check reads
the record in Postgres rather than Firestore). Which job keeps a draft, and how a stuck job moves on, are the
owner's decisions, made before the file runs again. The table holds ids only.
