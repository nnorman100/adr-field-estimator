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
- `revision` starts at 1 and each change raises it by exactly one (a trigger), so a save made from an older
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
