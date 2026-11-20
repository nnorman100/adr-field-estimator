# Data: Rebuilt app Postgres: submissions, estimates and agreements

Part of [Data](../DATA.md).

`0011_submissions_agreements` adds the submission, price pin, estimate and agreement tables and the worker's
lookup across companies (S5a-7, `docs/plans/S5.md`); the submission routes (S5a-8) and the estimate routes (S5a-9) use them, and the agreement routes (S5a-11) insert and read agreements. The four tables
hold a company's rows only inside `withCompany`, with forced row-level security, and every key between rows
carries `company_id`.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `job_submissions` | Submit's row, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `draft_id` (the Firestore field draft), `epoch` (server-made), `kind` (`original`, `change_order`, and since `0019_price_approvals` `revision`), `parent_agreement_id` (set exactly for a change order or a revision), `status` (`pending`, `committed`, `aborted`), `request_digest`, `expires_at`, `snapshot_bytes` and `snapshot_sha256` (set exactly when committed; the hash is checked against the bytes), `marker_state` (`pending`, `done`), `created_by_actor_id`, `decided_at` | `SELECT`, `INSERT`, and `UPDATE` of `status`, `snapshot_bytes`, `snapshot_sha256` and `marker_state` only |
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
  signed once each, and a job has at most one `original` agreement; a change order or a revision (S5b-9: a
  revised estimate after signing that supersedes the agreement it names) is not counted and names its parent
  (an agreement of the same job).
- `job_price_pins` names a version of its own company (composite key), and a pin takes the job's next number.
- Sizes: a snapshot or proposal is 2 bytes to 8 MiB, the signed documents 2 bytes to 16 MiB.
- Personal data: `snapshot_bytes` (the job's field work, customer and claim as submitted), `proposal_bytes`
  and `documents_bytes` (the customer's name, address, claim details and prices as printed) and
  `signer_name`. The table columns holding ids, hashes, kinds and times are not personal data. Logs and audit
  details hold ids and counts only.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write
  policy refuses an active operator.

## Proposals and approvals (`0019_price_approvals`)

`0019_price_approvals` adds `job_price_approvals` (S5b-8, pricing plan S5b-3, spec.md 6.1) and the kind
`revision` above (the kind and parent checks of `job_submissions` and `agreements` are replaced by wider ones
under the same names; no stored row changes). No route uses the table yet.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `job_price_approvals` | What the estimator proposes on a submitted job and the owner approves, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `submission_id`, `pin_id`, `table_hash`, `job_revision` (what it is bound to), `kind` (`named_adjustment`, `line_multiplier`, `hourly`, `unit`, `flat`), `adjustment_id` (a named adjustment of the pinned table), `item_id` and `room_id` (a custom multiplier's line; no room for a job-wide item), `multiplier` (above 1, at most 3, two decimal places), `description`, `quantity` (hours for `hourly`, 0.25 to 200), `unit`, `price` (the hourly rate, the unit price or the flat amount, above 0 to 100,000, to the cent), `taxable` (unit and flat only), `request_digest`, `proposed_by_actor_id`, `proposed_at`, `approved_by_actor_id`, `approved_at`, `ended_by_actor_id`, `ended_at`, `ended_reason` (`edited`, `replaced`) | `SELECT`, `INSERT`, and `UPDATE` of `approved_by_actor_id`, `ended_by_actor_id` and `ended_reason` only |

- Each kind holds exactly its own fields (a check). Decimals are refused, not rounded, past two places.
- A row is bound to the job's committed submission of its current draft, the job revision, the job's current
  pin and that pin's version's content hash. A trigger refuses a proposal, an approval or an end unless the job
  is `submitted` at that revision and pin and no estimate has been made from that submission and pin: after
  the estimate, a change goes through Back to editing and Finish (owner decision D1, 2026-11-20).
- What a row says never changes. It is approved once and ended once, in separate changes, and the database
  sets both times. An edit ends the row (`edited`) and proposes a new one with no approval, so an approved
  hourly rate stays as saved. Approving a named adjustment while another is approved first ends that one
  (`replaced`); only an approved named adjustment is replaced.
- One open custom multiplier per line (item and room, or job-wide item) per submission and job revision; at
  most one approved named adjustment in force per submission and job revision.
- Personal data: `description` (as typed, printed on the proposal). The other columns are ids, kinds,
  amounts, hashes and times.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write
  policy refuses an active operator. No `DELETE`, no `TRUNCATE`.
