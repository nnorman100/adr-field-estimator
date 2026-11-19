# Review and sign your estimate (signing link)

Part of [Screen specs](README.md). Address: `/sign#token`. Built in: `web/src/app/sign/page.tsx`,
`sign-screen.tsx`, `web/src/lib/links/screen.ts`, `web/src/lib/agreements/screen.ts`. Stage S5a-11b.

## Purpose

The homeowner's page from a signing link the technician made on [Review](review.md): read the same
documents the technician's phone shows (the proposal with the company's start-work authorization and
payment terms, the itemized claim, the scope defense letter, the photo audit log), then sign once.
After signing it shows the signed record and, once only, the links to the signed documents (both are
made at signing, and their tokens are in the first successful signing answer only: if that answer does
not reach the signer, a reload shows the record but not the links). The
token is only in the address's fragment, which the browser never sends, so no server log holds it;
the page sends it in a header. No sign-in, not indexed, no referrer, not kept for offline use.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Holder of the link (homeowner, adjuster or other signer) | the company's name, the link's end date, the documents for that one estimate | sign once; after signing, see the signed record for 30 days |
| Owner, estimator, office | the same as any holder; no company sign-in is used | the same |
| Superadmin support | the same as any holder | the same |
| Different-company user | the same as any holder: no company sign-in is used | the same |

The token is necessary but not enough. Every read and the signing act as the person who made the
link, as they are now (`actingFor` in `web/src/lib/links/signing.ts`): they must still be an active
member holding `sign`, the company must be active with prices on (`price_books`), and they must still
see the job. An estimator who made a link and is then unassigned, or a removed member, makes it
"This link is not available" even before its end date. A job no longer submitted, or whose estimate was
replaced or changed after pricing, voids it (`stateOf`).

## States

- Opening: "Opening the estimate…".
- No token, or an unusable link: "This link cannot be used" with "This link is not available. It may
  have expired or been replaced. Ask your restoration company for a new link."; other refusals:
  updated after sending ("Ask your restoration company for a new link."), too many tries, not ready
  ("…has been asked to finish its settings; try again later.").
- Pending: "Review and sign your estimate", "From {company}. This link works until {date}…", the
  documents, then "Sign": the boxes "I reviewed the proposal, the separate totals and the attached
  evidence." and "I agree to sign electronically and to receive this signed record electronically.
  I can print or save a copy from this page.", "Your full name", the role (Homeowner, Adjuster,
  Other), and a signature pad. "Tick both boxes to sign." if one is missing.
- Signed: "Your signed estimate", with the document links: "Each works for 30 days. Copy or share
  them now: they are shown only this once." Only the first successful signing answer carries them;
  later reads of the signed record (30 days, while the maker still has access) show no links.
- No connection: "We could not reach DryScope. Check your connection, then try again."

## Key actions and server routes

| Action | Route | Who |
|---|---|---|
| Read the page | `GET /api/sign` | the link |
| Show one photo | `GET /api/sign/photos/{photoId}` | the link |
| Send the drawn signature | `PUT /api/sign/signature/{signatureId}` | the link |
| Sign | `POST /api/sign` | the link |
| Show the signature after signing | `GET /api/sign/signature` | the link |

Rules: `docs/access/signing-links.md`, `docs/access/non-role-access.md`.

## Not built yet

- "Email me a copy" (J7: hidden until email arrives, S9).
- Homeowner photo upload through the link (not planned).

## Mismatches to check

None found.
