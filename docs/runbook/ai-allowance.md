# Company AI allowance and reserved holds

Only an authorized platform operator changes AI allowances; the owner page is
read-only. Use the dedicated `alert-disaster-field-2026` project and its private
Firestore `(default)` database. This procedure is separate from job prices,
per-user quotas and agreement records.

- The code default is $10 per UTC calendar month. A missing
  `_company_ai_budgets/{company_id}` document follows that default, including later
  code-default changes; ordinary AI calls never materialize it.
- To set an approved company override, use the Firestore console to set the
  **integer** field `monthly_cap_microusd` on that exact company's private budget
  document. Dollars multiply by 1,000,000: $10 is `10000000`. Record the company ID,
  previous value, approved new value, reason and operator in the operator's change
  record. No app endpoint or owner control writes this document. To return to the
  code default, record and remove only that company's explicit budget override
  document; do not leave an existing document with an invalid/missing cap field.
- To investigate allowance that remains reserved, inspect
  `_company_ai_months/{company_id}_{YYYY-MM}` for its `spent_microusd` and
  `reserved_microusd`. In `_company_ai_reservations`, query `company_id` equal to
  the company, then inspect rows whose `month` equals that UTC month and `state`
  equals `reserved`. Inspect `operation`, `amount_microusd` and `live`; reservation
  documents contain no prompts, photos or transcripts. Filter month/state locally
  if the console requests an index; this investigation needs no new index.
- A crash, missing usage or failed settlement can retain a full hold. There is no
  elapsed-time refund: age does not prove no billable request happened. Never delete
  a hold or edit monthly totals to free capacity. Confirm provider usage and arrange
  an audited reconciliation through the idempotent ledger settlement path, or apply
  an approved cap override. A late settlement belongs to its original month. A
  provider HTTP error normally settles zero; a settlement outage may still leave
  its reservation unconfirmed.

The owner display includes both spent and reserved estimates. Check provider
billing independently before reconciling a hold; physical-device and real Vertex
billing acceptance remain open. No automatic refund, TTL, invoice reconciliation
or data migration is part of this feature.
