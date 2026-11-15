# Data: Rebuilt app Postgres: company documents, signing links and document links

Part of [Data](../DATA.md).

`0013_company_documents` adds the letterhead lines and the document settings to `companies` (S5a-4b,
`docs/plans/S5.md`; the profile routes read and save them, `docs/ACCESS.md` "Company profile API"). It only
adds: no table, and no row is changed or seeded.

- `profile_emergency_phone`, `profile_fax`, `profile_website`, `profile_tagline` and
  `profile_mailing_address`: empty until set, one line each (no padding, no control characters), at most
  80, 80, 200, 150 and 500 characters.
- `profile_documents`: `jsonb`, an object under 64 KiB of its text form, `'{}'` until set (every setting at
  its neutral default). SQL checks only that; the Zod schema in `web/src/lib/profile/settings.ts` checks its
  shape when it is written and read, as `PriceTableV3` checks a price table.
- The runtime's column-level `UPDATE` and 0010's trigger split cover the six columns: a company's own
  transaction changes them, a platform operator never does (the trigger refuses it), and only the owner's
  route writes them (`profile_manage`).
- Personal data: none beyond 0010's. They are the company's own business details and wording, printed on its
  documents; the audit row holds a count, never a value.

`0014_signing_links` adds the remote signing link and the document links (S5a-11b, `docs/plans/S5.md`; the link
routes are in `docs/ACCESS.md` "Signing links and document links"). Both tables hold a company's rows only inside
`withCompany`, with forced row-level security, and every key between rows carries `company_id`.

| Table | What it holds | Runtime rights |
| --- | --- | --- |
| `signing_links` | One link that signs one estimate, keyed `(company_id, id)` with `id` made on the phone: `job_id`, `estimate_id`, `token_sha256` (the hash only, unique across companies), `status` (`pending`, `used`, `revoked`, `voided`), `request_digest`, `created_by_actor_id`, `token_issued_at`, `expires_at` (7 days after creation), `ended_at`, `ended_by_actor_id`, `agreement_id` and `used_at` (set exactly when used), `sign_attempts`, `read_window_start`, `read_count` | `SELECT`, `INSERT`, and `UPDATE` of the token hash, status, end and use columns and the counters only |
| `document_links` | One link that reads one set of one signed agreement: `job_id`, `agreement_id`, `document_set` (`homeowner`, `adjuster`), `token_sha256`, `status` (`active`, `revoked`), `request_digest`, `created_by_actor_id`, `token_issued_at`, `expires_at` (30 days after creation), `ended_at`, `ended_by_actor_id`, `read_window_start`, `read_count` | `SELECT`, `INSERT`, and `UPDATE` of the token hash, status, end columns and the read counters only |

- `agreements` gains `signing_link_id` (set exactly when `signer_kind` is `link`, unique, naming the link with the
  estimate it signed) and `signer_role` (`homeowner`, `adjuster` or `other`; required for a link signature, empty for
  one signed on a device). Rows signed before 0014 keep both empty.
- At most one `pending` signing link per job and one `active` document link per agreement and set (partial unique
  indexes); a newer link revokes the older one in the same transaction. A link's identity never changes, an ended
  link changes only its read counters, and a trigger on each table holds which columns may change; a column added
  later is frozen until the trigger names it.
- `signing_link_company(token_sha256)` and `document_link_company(token_sha256)` are the lookups before a company is
  known, on 0004's pattern: a token's hash to its company id and nothing else. Every other read runs inside
  `withCompany`.
- Personal data: none held directly. Only the SHA-256 of a token is stored (the token is in no table, log or audit
  row); the other columns are ids, hashes, states, times and counters. The signer's name and role are on the
  agreement. Logs and audit details hold ids and counts only.
- A platform operator reads a company's rows through `withOperator` with that company set, and every write policy
  refuses an active operator.
