# Review before signing

Part of [Screen specs](README.md). Address: `/sign-in/{address}/jobs/{id}/review`. Built in:
`web/src/app/(auth)/sign-in/[address]/jobs/[jobId]/review/` (`review-screen.tsx`,
`review-documents.tsx`, `signing.tsx`, `signature-pad.tsx`, `send-link.tsx`,
`document-links.tsx`, `reprice-banner.tsx`), `web/src/lib/estimates/screen.ts`,
`web/src/lib/estimates/reprice-screen.ts`, `web/src/lib/links/screen.ts`. Stages S5a-9, S5a-11,
S5a-11b, S5b-6.

## Purpose

Price the finished job from the company's own prices, show the four documents (the proposal, the
itemized claim with the priced line items, the scope defense letter that carries the claim form's
fields, the photo audit log) and the staff-only notes, then let
the customer sign on the phone or get a signing link. Signing, on the phone or by a link, makes both
document links (the homeowner's and the adjuster's) in the same step; their addresses come back in
the first successful signing answer only. A signed job opens read-only from the stored agreement
with the state of those links, but not their addresses. Prices and the mandatory wording come from the
server (`web/src/engine/`); this screen never computes a price. Online only.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | price, documents, staff notes (with the quantity-override note) | price ("Price this job"); once the documents are ready to sign (no "Not ready to sign" reason), confirm and sign on the phone or make a signing link; revoke a signing link; make, replace or revoke document links |
| Estimator | the same without the quantity-override note, on jobs they can see | price; once ready to sign, sign on the phone or make a signing link; revoke a signing link; make a document link for a set that has no "active" link (by stored state, see Mismatches) |
| Office | the estimate once priced, with the same staff-only notes as an estimator (summary of findings, suggestions, work with no price, pricing checks; no quantity-override note) and the "Not ready to sign" reasons, and a signed job's record | make, replace or revoke document links (`delivery_resend`); no pricing (403) and no signing |
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
- Being edited: "Not finished yet", with "Back to Finish and review". Finished, not priced: "Price this
  job" and "Pricing…", also with "Back to Finish and review"; so does a priced, unsigned job (ready or
  not ready to sign). A signed job has no such button.
- Pricing refused for an empty summary: "This job was finished without a summary of findings. Go back
  to editing, write it, then finish again." (`summary_missing`, checked after "scope not confirmed").
  The field app has no editor for the summary (see "Mismatches to check"), so a job finished with only
  Notes cannot get past this.
- Not ready to sign: "Not ready to sign" with each reason, in this order (`notReadyReasons` in
  `web/src/lib/estimates/screen.ts`): details changed after pricing ("…go back to editing, then
  finish and review."); a missing job detail ("{detail}. The documents are shown again once it is
  added on the job.", for example a post-pricing edit that blanks a required job detail, which also
  hides the rebuilt documents); missing company settings ("Company settings: {setting} is not filled
  in. The owner adds it on Company settings.", for example a priced proposal with an empty start-work
  authorization); "Some work has no price…"; "The scope has no priced work yet…". While any reason
  shows, neither signing path is offered: no "Before signing" box, no signature pad and no signing
  link (`review-screen.tsx`).
- Ready: "Before signing" with the box "I reviewed the proposal, the separate totals and the attached
  evidence with the homeowner or representative."; once ticked, "Customer signature" (the customer's
  full name, a signature pad, "Sign"; "Signing needs a connection.").
- Signed: "Signed", the stored proposal, who signed and when, the documents and a "Photo audit log",
  and the document links. Right after signing on this phone the two addresses are shown to share;
  after a reload or a retried signing (the same agreement, which answers no new tokens) only each
  link's status is listed: the stored state (active, revoked or expired), which does not recheck the
  maker, so a link can read "active" here while its recipient is refused because the maker lost the
  job, the key or the company's prices (see [Signing link](sign-link.md)). While the company's prices are on, the owner or office can then
  "Replace the link"; with prices switched off, a fresh load of Review stops at "Prices are not switched on" and the
  staff link routes answer 404, so nobody can list or replace a link until prices are back on (a
  Review already open when the switch is turned off keeps the link status or addresses it last
  loaded on screen, but listing and replacing are then refused); an estimator can "Make a link" only for a set with no "active" link, so an
  estimator who missed the first answer, or whose link only reads active, cannot replace it (see
  "Mismatches to check"). For a link signed by the homeowner, the
  addresses went to the homeowner's page, not this phone.
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

## Reprice this draft (owner, S5b-6)

With the owner's `job_reprice` key, on a job that is not signed, the screen reads
`GET /api/jobs/{id}/reprice`. When newer prices are published than the ones the job is pinned to, a
"Newer prices are published" banner says which prices version the job is priced from and offers
"Review and reprice". That opens a dialog, "Reprice this draft?", with the job's last submitted
scope priced at the pinned prices and at the newest, either of which may instead say why the record
cannot be priced from it (the action stays and the server decides), and what a reprice does.
Nothing is sent until "Reprice this draft" in the dialog; Cancel and Esc send nothing. The dialog
shows one preview, taken when it was opened, and its confirmation sends exactly that preview's
version and job revision, with a change id kept for a retry; the action is unavailable until a
refusal for a changed basis has shown its message and read the preview again. Review reads the job
and its estimate again, rather than keep what it shows, when the preview's job revision is not the
one Review loaded, when a reprice or the preview answers that the job moved (`stale_revision`),
was signed (`job_signed`) or is no longer reachable (403, 404, 410), and after a reprice: the old
estimate, its proposal and its signing actions are gone, and the scope must be confirmed again
through Back to editing and Finish. When the preview cannot be read, the screen says so (a status
note). The revised estimate's proposal shows its "Revised {date}" line under the heading (with the previous
price when the company's "Show the previous price on a revised estimate" was on when it was made),
and it needs a new signature. Estimator and office never see the banner.

## Not built yet

- Named adjustments (S5b-7).
- Corrections and change orders after signing (S5b-4, S5b-9).
- "Email me a copy" and emailing documents: hidden until email arrives (J7, S9).

## Mismatches to check

- The two document links' addresses are shown once, in the first successful signing answer
  (`web/src/lib/agreements/service.ts`). If it does not reach the phone, an estimator holding only
  `sign` has no way to get them (both links read active, so Make a link is not offered); the owner or
  office must replace them, which works only while the company's prices are on (with prices off,
  a fresh load of Review stops at "Prices are not switched on" and the staff link routes answer 404).
- A document link, or a pending signing link, is listed by its stored state, not by whether its recipient
  can still open it: the recipient's page also needs the maker to still be an active member with the
  key, the company active with prices on, and the job still visible to them (`sign-link.md`,
  `documents-link.md`). An estimator cannot replace an "active" document link that is really dead;
  the owner or office can, while prices are on. A document-link maker who moves from estimator to
  office keeps qualifying through `delivery_resend`, so losing `sign` alone does not end that link. A pending signing link can be replaced by anyone holding `sign` ("Make a
  new signing link").
- Finish does not require a summary, but pricing does, and the field app cannot write one (see
  [Check Scope](check-scope.md)): a technician can finish a job whose only text is Notes and then be
  refused at "Price this job" with `summary_missing`.

The screen's key checks match the routes in `docs/access/`.
