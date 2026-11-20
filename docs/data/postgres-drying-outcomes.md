# Data: Rebuilt app Postgres: drying log and outcomes

Part of [Data](../DATA.md).

`0020_drying_outcomes` adds the drying log, the job close and the estimate history, and the drying watch's decisions on
`job_coordination` (S5b-10 slice 10A, [S5b-10](../plans/S5/S5b-10.md)). No route reads or writes them yet: the routes
and screens are slices 10B and 10C. All three tables hold a company's rows only inside `withCompany`, with forced
row-level security. A key between rows always carries `company_id`, so a row can never point at another company's
job, agreement or person. A platform operator reads them only through `withOperator` with the company set, and every
write policy refuses an operator. The runtime has no `DELETE` or `TRUNCATE` on any of them.

| Table or column | What it holds | Runtime rights |
| --- | --- | --- |
| `drying_readings` | One drying-log entry, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `kind` (`air`, `material`, `thermal`), `room_id` and `room_label` (the room's stable field id and its label as captured, or neither for a whole-job or outside reading), `taken_at` (as sent), `received_at` (the database's clock), `payload` (exactly the fields of its kind: an air zone, temperature and relative humidity; a material label, moisture reading, meter unit, dry standard and affected flag; a thermal difference, pattern and boundary note; and a note of at most 500 characters), the server's air values for an air reading (`gpp`, `dew_point_f`, `dew_point_depression_f`, `vapor_pressure_inhg`, `enthalpy_btu_lb`), `request_digest`, `created_by_actor_id`, and the void: `voided_by_actor_id`, `voided_at`, `void_change_id`, `void_digest` (all four or none) | `SELECT`, `INSERT`, and `UPDATE` of `voided_by_actor_id`, `void_change_id` and `void_digest` only |
| `job_closes` | One close or correction of a signed job, keyed `(company_id, id)` with `id` the close request's uuid: `job_id`, `agreement_id` (the agreement it was confirmed against), `revision` (1, then one more per correction; unique per job), `request_digest`, `final_cents` (1 to 200,000,000), `actual_days` (0 to 365, or none), `note` (at most 300 characters), and the comparison it was classified by: `baseline_agreement_id`, `price_mode` (`range`, `single`), `baseline_low_cents`, `baseline_high_cents` (none for one price), `landed` (`inside`, `above`, `below`); `closed_by_actor_id`, `closed_at` (the database's clock) | `SELECT`, `INSERT`; never changed or removed |
| `estimate_history` | One sample per signed agreement, keyed `(company_id, job_id, agreement_id)`: `signed_at`, `price_mode`, `low_cents`, `high_cents` (none for one price), `labor_material_low_cents`, `room_categories` (each of `1`, `2`, `3`, `mold` once, in that order), `planned_days`, `area_sf` (each of the last four empty when the signed record does not have it), `recorded_at` | `SELECT`, `INSERT`; never changed or removed |
| `job_coordination.drying_watch` | Empty until the first watch action; then `{"revision": n, "receipts": [...]}`, with one receipt per accepted action: `action` (`mark_dry`, `extend`, `close`), `agreement_id`, `reason` (1 to 500 characters), `actor_id`, `at` (the database's clock, UTC), `request_id`, `request_digest`. At most 100 extensions and one closing action, which is last | `UPDATE` of `drying_watch` (beside the office columns of 0015); `INSERT` as before |

- **A reading is stored once.** Its id is made on the phone, so a reading resent after a lost response meets its own
  row (the primary key) instead of making a second one. Its raw fields never change; a trigger refuses any change but
  the void, even by the table owner. A void is set once, with who, its change uuid and the request's digest together,
  and the trigger stamps its time; a second void, even by another person, is refused, and one change uuid voids one
  reading. Removing a reading is a void, never a delete. Outside air belongs to no room.
- **A close is append-only.** Each correction is a new row with the next close revision of its job, taken under the
  job's row lock; the newest row is the job's close, and every earlier receipt stays readable by its request id. Both
  agreements a close names are agreements of its own job. Where the invoice landed is checked against the baseline as
  [Estimate assist](../estimate-assist.md) section 3 classifies it: a range is inside from its low end to its high end,
  both included; one price is inside at or under the price and above over it.
- **The baseline.** The owner's answer (2026-11-20, Q1 option A): the final invoice is compared with the first signed
  estimate for the job. The history baseline is the signed priced result after any approved S5b-8 named adjustment,
  multipliers and additions (`job_price_approvals`, [Submissions, estimates and agreements](postgres-submissions.md)), so
  approved extras sit inside it. The close keeps its baseline agreement apart from the agreement it was confirmed
  against, so a later change order does not move what the close was compared with.
- **History is kept.** Every sample stays; the old app's 300-row limit was on one Firestore document. A reporting
  window, if the product calls for one, is a query.
- **The watch stores decisions only.** Its current status (due, overdue, stalled, dry) is worked out from the signed
  facts, the live reading log and the clock, and is never stored. A watch change adds exactly one receipt and keeps every
  earlier one; nothing follows a closing action; the watch is never removed. A receipt names an agreement of its own job
  and an actor of its own company. A watch change leaves the office notes and the coordination revision (notes and
  field owner) as they are, and an office change leaves the watch. The first action on a job with no coordination row
  makes the row with its defaults; on conflict only the watch column changes.
- **Backups.** These are ordinary company tables, so the Cloud SQL backups hold them, and the restore drill
  (`infra/dryscope/scripts/restore-drill.sh`) counts the rows of every base table of the copy, these included, with no
  list to keep by hand ([Backups](../runbook/backups.md)).

## Personal and business data

| Where | What it is | Who will read it (the routes are slice 10B) |
| --- | --- | --- |
| `drying_readings` | Moisture and air measurements of a customer's property, a room label and free-text notes (`payload.note`, a thermal `boundary`), with who took and voided each | The job's people (owner, office, and the estimator who made the job, owns its field work or is assigned it); the platform operator through its read-only path only |
| `job_closes` | The company's final invoice amount for a customer's job, actual days, a free-text note, and the signed amounts it was compared with | Owner and office (`coordination`); an estimator on the job sees only whether it closed and when |
| `estimate_history` | The company's signed amounts and job figures (category, days, area); no customer name, address or contact | The owner, as aggregate accuracy numbers (`prices_manage`) |
| `job_coordination.drying_watch` | Staff reasons (free text) and who decided each watch action | The job's people, under the watch's own rules (slice 10B) |

None of these is part of a signed record, a document or a signing or document link payload; the agreement and its
bytes stay as signed. Slice 10B's plan keeps outcome contents out of public link and export payloads, and its logs and
audit rows to ids, revisions and counts.
