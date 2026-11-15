# Data: Rebuilt app Postgres: submissions, estimates and agreements

Part of [Data](../DATA.md).

`0011_submissions_agreements` adds the submission, price pin, estimate and agreement tables and the worker's
lookup across companies (S5a-7, `docs/plans/S5.md`); the submission routes (S5a-8) and the estimate routes (S5a-9) use them, and the agreement routes (S5a-11) insert and read agreements. The four tables
hold a company's rows only inside `withCompany`, with forced row-level security, and every key between rows
carries `company_id`.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `job_submissions` | Submit's row, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `draft_id` (the Firestore field draft), `epoch` (server-made), `kind` (`original`, `change_order`), `parent_agreement_id` (set exactly for a change order), `status` (`pending`, `committed`, `aborted`), `request_digest`, `expires_at`, `snapshot_bytes` and `snapshot_sha256` (set exactly when committed; the hash is checked against the bytes), `marker_state` (`pending`, `done`), `created_by_actor_id`, `decided_at` | `SELECT`, `INSERT`, and `UPDATE` of `status`, `snapshot_bytes`, `snapshot_sha256` and `marker_state` only |
| `job_price_pins` | Which published version a job is priced from: `job_id`, `sequence` (1, 2, 3 per job), `version_id` (a version of the same company), `reason` (`first_price` for sequence 1, `owner_reprice` after), `pinned_by_actor_id`; the current pin is the highest sequence | `SELECT`, `INSERT`; never changed or removed |
| `job_estimates` | One priced estimate per committed submission and pin: `table_hash` and `engine_version` (those of the pinned version), `priced_result`, `proposal_bytes` and `proposal_sha256` (checked against the bytes), `created_by_actor_id` | `SELECT`, `INSERT`; never changed or removed |
| `agreements` | The signed record, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `submission_id`, `estimate_id`, `kind`, `parent_agreement_id`, `signer_kind` (`device`, `link`), `signer_name`, `signature_evidence_id` (a `signature` object of the job in `evidence_objects`), `proposal_sha256`, `priced_result`, `version_id`, `content_hash`, `engine_version`, `documents_bytes` (the documents as signed), `request_digest`, `created_by_actor_id`, `signed_at` | `SELECT`, `INSERT`; never changed or removed |

- A submission is made `pending` (a trigger refuses any other start) and moves once to `committed`, with its
  snapshot bytes and their SHA-256, or to `aborted`. The decision time is the database clock's, set by the
  trigger. From then on a trigger refuses every change to the row except `marker_state` going from `pending`
  to `done`, and it refuses a change to a pending row's job, draft, epoch, digest, expiry, kind, parent or
  creator. Unique per draft and epoch, and at most one `committed` row per draft, so of two commits for the
  same draft the first wins and the second is refused. The new column `marker_state` records that the draft's
  Firestore marker (`submitted` after a commit, back to `editing` after an abort) is written; the worker
  repairs a lost one.
- `job_submission_due_companies(max_companies, marker_grace_seconds)` is the worker's one lookup across
  companies, on the 0005 pattern: it returns company ids only, runs as the table owner with a setting that
  one SELECT policy needs, and only the runtime may call it. A company is due when it has a row still
  `pending` past `expires_at`, or a decided row whose marker is still `pending` after the grace period
  (0 to 86,400 seconds, so the request that just decided is not raced). Size 1 to 100.
- An estimate is made only from a `committed` submission and the job's current pin, and states that pin's
  version's content hash and engine version (a trigger checks both); one per submission and pin.
- An agreement restates its estimate (a trigger checks it): the estimate is for this submission, which is
  `committed` and has the same kind and parent; the proposal hash, priced result, content hash and engine
  version are the estimate's, the version is the estimate's pin's, and that pin is still the job's current one;
  the signature is a `signature` object of this job. A submission, an estimate and a signature object are
  signed once each, and a job has at most one `original` agreement; a change order is not counted and names
  its parent (an agreement of the same job).
- `job_price_pins` names a version of its own company (composite key), and a pin takes the job's next number.
- Sizes: a snapshot or proposal is 2 bytes to 8 MiB, the signed documents 2 bytes to 16 MiB.
- Personal data: `snapshot_bytes` (the job's field work, customer and claim as submitted), `proposal_bytes`
  and `documents_bytes` (the customer's name, address, claim details and prices as printed) and
  `signer_name`. The table columns holding ids, hashes, kinds and times are not personal data. Logs and audit
  details hold ids and counts only.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write
  policy refuses an active operator.
