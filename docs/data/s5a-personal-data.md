# Data: Rebuilt app S5a: personal data at a glance

Part of [Data](../DATA.md).

Where the rebuilt app's job, photo, signing and link features (S5a, `docs/plans/S5.md`) hold personal data, who can read
it, and what proves the company boundary for it (S5a-12). Each row points at the file with the full detail; this page adds
no rule of its own. "The job's people" means the company's owner and office user, and the estimator who made the job or
owns its field work ([Jobs routes](../access/jobs.md)); another estimator of the same company, and every person of another
company, gets 404. No platform operator route reads any of it.

| Where | Personal data | Who reads it | Detail |
| --- | --- | --- | --- |
| Postgres `jobs` | `property_address` | The job's people | [Core job tables](postgres-jobs.md) |
| Postgres `job_customers` | `name`, `phone`, `email` | The job's people | [Core job tables](postgres-jobs.md) |
| Postgres `job_claims` | `adjuster_name`, `adjuster_email`, `adjuster_phone`, carrier, claim and policy numbers, `loss_cause`, `deductible`, `date_of_loss` | The job's people | [Core job tables](postgres-jobs.md) |
| Postgres `job_submissions` | `snapshot_bytes` (the field work, customer and claim as submitted) | The job's people, through the estimate | [Submissions, estimates and agreements](postgres-submissions.md) |
| Postgres `job_estimates` | `proposal_bytes` (the customer's name, address, claim details and prices as printed) | The job's people; the homeowner holding the job's signing link | [Submissions, estimates and agreements](postgres-submissions.md) |
| Postgres `agreements` | `documents_bytes` (the documents as signed), `signer_name`, `signer_role` | The job's people; the holder of one of its document links (that set only) | [Submissions, estimates and agreements](postgres-submissions.md), [Signing links](postgres-documents-and-links.md) |
| Postgres `signing_links`, `document_links` | None: ids, the SHA-256 of the token, states, times and counters | The job's people (never a token) | [Signing links](postgres-documents-and-links.md) |
| Postgres `companies` profile columns | None beyond the company's own business details and wording, printed on its documents | The owner, through the profile route; printed on the company's documents | [Core job tables](postgres-jobs.md), [Company documents](postgres-documents-and-links.md) |
| Postgres `evidence_objects` | None: object names of ids, hashes, sizes and types | The job's people | [Core job tables](postgres-jobs.md) |
| Evidence bucket (`dryscope-evidence-<env>`) | Photo, full-size original and signature image bytes under `companies/<company>/jobs/<job>/…` | The job's people through the photo route; a link holder sees that record's photos and signature only | [Photo routes](../access/photos.md), [Signing links](../access/signing-links.md) |
| Field database (`dryscope-field-<env>`) drafts | `notes`, `summary`, a room's `prepTasks` and `findings` (free text) | The company's owner and office user, and the draft's field owner; never another company's tenant | [Field rules](field-rules.md) |
| Link tokens | The token itself is a bearer secret | Only the person it was sent to; it is in no table, log or audit row, and travels in the page address's fragment and the `X-Link-Token` header | [Signing links](../access/signing-links.md) |

Logs and audit rows of these features hold ids and counts only.

## What proves the company boundary

The company-isolation gate (`npm run test:isolation`, [Company isolation gate](../access/isolation-gate.md)) gives both test
companies every record in the table above through the real routes, then:

- calls every S5a route, found from the generated route list, as the other company's owner, estimator and office user with
  the company's real job, link, photo and signature ids, and with the other company's own live link tokens: refused, with
  no id, hash, name or token of the company in any answer and nothing changed;
- reads every Postgres table with a company column, found from the catalog, as the runtime role in the other company's
  context (none of its rows shows), and tries to insert, change, move and delete its rows (refused or no row reached);
- tries the field rules with two sign-in tenants on fenced, submitted and next drafts with field map v2 rooms and photo
  references (every read, list, query and write refused).

The real bucket, field database, Cloud Run service and a real iPhone are the owner's
[S5a real-service checks](../runbook/s5a-real-service-checks.md).
