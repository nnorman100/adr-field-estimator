# Signed estimate documents (document link)

Part of [Screen specs](README.md). Address: `/documents#token`. Built in:
`web/src/app/documents/page.tsx`, `documents-screen.tsx`, `web/src/lib/links/screen.ts`. Stage
S5a-11b.

## Purpose

A read-only page of one signed job's documents, for 30 days or until the company revokes the link.
Both sets open with the company's name, the signer's name and role (when given), the signing date and
the link's end date (`documents-screen.tsx`; the API also sends the signing method to both). There are
two sets (`SET_NAMES`): "Homeowner's documents" (the signed proposal, the signature image, how it was
signed, the proposal's SHA-256 and the photo log) and "Adjuster's documents" (the price, the itemized
claim of priced line items, the scope defense letter, which carries the claim form's filled-in fields (for example the claim number and
adjuster contact, the carrier, policy number, dates and deductible), and a "Scope JSON" export of the priced line items; no signature image, no signing method shown
and no photos). The scope JSON is built in the browser from the itemized claim rows (`ScopeJson`). The
token is only in the address's
fragment and goes to the link routes in a header. No sign-in, not indexed, no referrer, not kept for
offline use.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Holder of the link (homeowner or adjuster) | that link's set, under the shared signer header | read it; adjuster: also copy ("Copy the scope JSON") or download ("Download the scope JSON", `scope.json`) the scope JSON |
| Owner, estimator, office | the same as any holder; links are made and revoked on [Review](review.md) | read it |
| Superadmin support | the same as any holder | read it |
| Different-company user | the same as any holder: no company sign-in is used | read it |

The token is necessary but not enough. Every read acts as the person who made the link, as they are
now (`resolve` in `web/src/lib/links/documents.ts`): they must still be an active member holding
`sign` or `delivery_resend`, the company must be active with prices on (`price_books`), and they must
still see the job. Losing any of these makes the link "This link is not available" before its end
date (for example an estimator who made the link and then lost the job, or lost both keys; a maker moved
from estimator to office still holds `delivery_resend`, so losing `sign` alone does not end the link;
one who made the job keeps seeing it after being unassigned). The owner or office can replace it
while the company's prices are on; with prices off, a fresh load of Review stops at "Prices are not switched on" and
the staff link routes answer 404 (a Review already open keeps what it last loaded, but listing and replacing are refused). [Review](review.md)
lists a link as "active" by its stored state and expiry, which does not recheck the maker, so staff can
see an active link that the recipient is refused.

## States

- Opening: "Opening the documents…".
- No token, or an expired, revoked or unknown link: "This link cannot be used" with "This link is not
  available. It may have expired or been replaced. Ask your restoration company for a new link."
- Ready: "Signed estimate documents" with the set's sections.
- No connection: "We could not reach DryScope. Check your connection, then try again."

## Key actions and server routes

| Action | Route | Who |
|---|---|---|
| Read the set | `GET /api/documents` | the link |
| Copy or download the scope JSON (adjuster's set only) | in the browser, from the itemized claim's priced rows already read (no claim-form fields); no route | the link |
| Show the signature (homeowner's set only) | `GET /api/documents/signature` | the link |
| Show one photo (homeowner's set only) | `GET /api/documents/photos/{photoId}` | the link |

Rules: `docs/access/signing-links.md`, `docs/access/non-role-access.md`.

## Not built yet

- Emailing the documents to the homeowner or adjuster (S9; J7).

## Mismatches to check

None found.
