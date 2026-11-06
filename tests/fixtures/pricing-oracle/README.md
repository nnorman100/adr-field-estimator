# Pricing oracle

The pinned answers of today's Python pricing and document code, for a synthetic corpus. A future
rewrite (the TypeScript port in the rebuild plan) must reproduce these answers with zero
unexplained differences before it prices any live estimate. Nothing here is customer data.

## What is pinned

- `cases/<id>.json`: one case each. `input` is the stored input; `expected` is what the code at
  the pinned backend commit produced from it. `title` and `tags` say what the case checks.
- `manifest.json`: every case file with its SHA-256, the corpus SHA-256 (over each file name and
  file SHA-256, in name order), the calculation versions covered, the frozen clock values, the
  backend commit and tree that produced the answers, and the Python version, dependency lock hash
  (`backend/requirements.txt`), pydantic versions and decimal context used.

The existing `tests/golden/v1-documents.json` is separate and unchanged.

### Input

`calculation` names the price model (`adr-residential-v1` rate book or `dryscope-v2` owner table;
any other value, including `null`, a number, a list or a wrong-case name, is an unknown version,
and a case without the key is a stored price version that lacks the field). `data` is the raw inspection JSON as a client sends it, so
an absent field stays absent, an integer stays an integer and `-0.0` stays `-0.0`. `rates` (v1) or
`table` (v2, before normalization, with optional `acknowledgements`) is the company's price book.
`photos`, `ai` (the saved model result), `identity`, `customer_name`, `claim`, `history` (signed-job
rows for the advisory warning), `company_id`, `version_id`, `sequence`, `inspection_id`, `revision`
and `signing` complete what an audit and a signature read. `pinned: false` is the single-company
rollback path, which prices from rates without a job pin.

### Expected, in pipeline order

1. `normalized_inspection`: the stored inspection record (`inspection_payload`). Everything after
   it prices that record reloaded (`InspectionData.model_validate`), as the audit does, so a
   default the save writes (for example `drying_days`) is priced.
2. `pin` and `price_basis`: the first job pin, built as `ensure_pin` builds it (the company's
   stored version, as its only published version, through `effective` and `_book_for_job`, then
   `_pin_body`), and the basis `basis_for` returns; for v2 the pin carries the normalized table
   and its `content_sha256`. A stored version whose calculation version is unknown, malformed or
   missing is refused there, at `pin`.
3. `pricing`: `lines` (every price line the engine returns), `itemized_total`, `buckets`
   (v2: fixed, equipment and labor/material sums with their taxable parts; v1: the job,
   labor/material and equipment sums and affected square feet the estimating-sheet range reads),
   `totals` (v2 engine totals: each end's subtotal, after-hours, minimum, overhead and profit, tax
   and total, labor/material low and high, explanations, uncertainty numbers), `low` and `high`.
4. `warnings`: `engine` (the v2 engine's own warnings) and `advisory` (the draft warnings).
5. `documents`: the full audit documents, including all four: `adr_estimate` (proposal),
   `xactimate_scope` (itemized claim), `iicrc_defense_letter` and `photo_audit_log`.
6. `proposal`: the canonical proposal bytes the audit hashes (`canonical()` of data, photos,
   documents and revision), base64-encoded, with their length and SHA-256 (the proposal hash).
7. `signing`: present when the documents are signable. The on-site and homeowner-link payloads
   and the SHA-256 each signing route stores as `payload_sha256`.

A rejected input stops at the stage that refused it: `rejected.stage` is `inspection` (pydantic
validation; `errors` lists each location and error type), `save_checks` (the save's room-name
and override checks, and the audit's override check on the reloaded record), `table`, `pin`,
`pricing` or `documents`, with the error type and message. Stages before it are still recorded.

Engine `Decimal` values are written as their exact Python `str()` text, keeping trailing zeros and
exponents; floats and integers are JSON numbers as Python wrote them (`1e-05`, not `0.00001`).
The canonical bytes sort object keys by Unicode code point and escape non-ASCII as `\uXXXX`,
non-BMP characters as surrogate pairs; the `*-serializer-keys-and-exponents` cases pin keys that
sort differently by UTF-16 unit. The proposal date is frozen at `11-06-2026`
(America/Los_Angeles) and the pin's `priced_at` at `2026-11-01T17:00:00Z`; nothing else reads a
clock. Every case runs under the `C` locale; the code reads no locale (dates print as
`%m-%d-%Y` digits, numbers through format specs, `Decimal` `str()` and `json.dumps`). The
manifest's `frozen` block records all of these.

Files are ASCII JSON with sorted keys; containers four levels down print on one line so each file
stays under 1,000 lines. A reader parses them; the layout is not part of the contract. The
contract for the canonical proposal is the decoded bytes of `canonical_bytes_base64`, compared
exactly: never parse and re-serialize them, and never normalize two outputs through one new
serializer before comparing.

## Checking

`python -m pytest tests/test_pricing_oracle.py -q -p no:cacheprovider` re-runs every stored input
through the current code and fails on the first differing byte, naming the JSON path. The same
check runs as `python scripts/pricing_oracle.py --check`. A failure means the code changed what
it produces for a pinned input: fix the code. The environment fields in `manifest.json` are
provenance; the check compares answers, not interpreter versions.

## Regenerating

These files are under the Test guard's protected `tests/fixtures/**`, so any change needs the
owner's approval label on the pull request. Regenerate only to add owner-approved cases or after
an owner-approved change to a legacy answer, on a committed backend tree:

```bash
python scripts/pricing_oracle.py --write
```

The corpus is built by `scripts/pricing_oracle_cases.py` and `scripts/pricing_oracle_cases_v2.py`
(named boundaries plus seeded jobs with fixed seeds). The generator refuses to write while
`backend/` has uncommitted changes, and records the backend commit and tree it ran on.

**A new candidate must never regenerate its own answers.** A port or rewrite reads each `input`,
produces its own outputs, and compares them with `expected` here; it never writes to this folder,
and changing its code never changes these files. Report every mismatch with the case id, first
byte offset, JSON path and the smallest input that shows it.

## Not covered here

Features that are not built yet (neutral adjustments, additions, change orders) get their own
cases with their own calculation version when they exist. Request checks that sit in the API
routes rather than the pricing and document code (unconfirmed scope, open voice notes, quotas,
access) are covered by the route tests, not this oracle.
