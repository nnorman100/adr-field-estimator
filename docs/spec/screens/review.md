# Review before signing

Part of [Screen specs](README.md). Address: `/sign-in/{address}/jobs/{id}/review`. Built in:
`web/src/app/(auth)/sign-in/[address]/jobs/[jobId]/review/` (`review-screen.tsx`,
`review-documents.tsx`, `signing.tsx`, `signature-pad.tsx`, `send-link.tsx`,
`document-links.tsx`), `web/src/lib/estimates/screen.ts`, `web/src/lib/links/screen.ts`. Stages
S5a-9, S5a-11, S5a-11b.

## Purpose

Price the finished job from the company's own prices, show the four documents (the proposal, the
itemized claim, the scope defense letter, the photo audit log) and the staff-only notes, then let
the customer sign on the phone or get a signing link. A signed job opens read-only from the stored
agreement, with links to the signed documents. Prices and the mandatory wording come from the
server (`web/src/engine/`); this screen never computes a price. Online only.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | price, documents, staff notes (with the quantity-override note) | price ("Price this job"), confirm and sign on the phone, make or revoke a signing link, make, replace or revoke document links |
| Estimator | the same without the quantity-override note, on jobs they can see | price, sign on the phone, make or revoke a signing link, make a document link for a set that has no working link |
| Office | the estimate once priced, and a signed job's record | make, replace or revoke document links (`delivery_resend`); no pricing (403) and no signing |
| Superadmin support | nothing | nothing |
| Different-company user | signed out of this company's page, or "This job could not be found" | nothing |

The screen decides by keys from `GET /api/me`: pricing by `audit`, signing and signing links by
`sign` (`reviewerOf`), document links by `sign` (make one) and `delivery_resend` (replace, revoke)
(`linkRightsOf`).

## States

- Loading: "Reading the job…". Signed out, sign-in unfinished, not found: as on
  [Finish](finish.md).
- Prices off for the company (the estimate route answers 404): "Prices are not switched on".
- No connection: "We could not open this job" ("Review needs a connection…") with "Try again".
- Being edited: "Not finished yet", with a link back to Finish. Finished, not priced: "Price this
  job" and "Pricing…".
- Not ready to sign: "Not ready to sign" with each reason (details changed after pricing: "…go back
  to editing, then finish and review."; "Some work has no price…"; "The scope has no priced work
  yet…").
- Ready: "Before signing" with the box "I reviewed the proposal, the separate totals and the attached
  evidence with the homeowner or representative."; once ticked, "Customer signature" (the customer's
  full name, a signature pad, "Sign"; "Signing needs a connection.").
- Signed: "Signed", the stored proposal, who signed and when, the documents and a "Photo audit log",
  and the document links.
- Errors: the server's message with "Try again", "Try signing again" or "Reload"; signing link
  errors such as "This job is already signed." and "That link has ended. Make a new one."

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Who is signed in | `GET /api/me` | member |
| Read the job | `GET /api/jobs/{id}` | `jobs_read` |
| Read the estimate | `GET /api/jobs/{id}/estimate` (404 with prices off) | `jobs_read` |
| Price this job | `POST /api/jobs/{id}/estimate` | `audit` |
| Send the signature image | `PUT /api/jobs/{id}/photos/{signatureId}?kind=signature` | `sign` |
| Sign on the phone | `POST /api/jobs/{id}/agreements` | `sign` |
| Read the signed record | `GET /api/jobs/{id}/agreements` | `jobs_read` |
| Make, read or revoke a signing link | `POST`, `GET`, `DELETE /api/jobs/{id}/signing-link` | `sign` |
| Make a document link | `POST /api/jobs/{id}/document-links` | `sign` or `delivery_resend` |
| List document links | `GET /api/jobs/{id}/document-links` | `jobs_read` |
| Revoke a document link | `DELETE /api/jobs/{id}/document-links/{linkId}` | `delivery_resend` |

Rules: `docs/access/estimate.md`, `docs/access/signing.md`, `docs/access/signing-links.md`.

## Not built yet

- Reprice (owner) and named adjustments (S5b-6, S5b-7).
- Corrections and change orders after signing (S5b-4, S5b-9).
- "Email me a copy" and emailing documents: hidden until email arrives (J7, S9).

## Mismatches to check

None found. The screen's key checks match the routes in `docs/access/`.
