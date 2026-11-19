# Review and sign your estimate (signing link)

Part of [Screen specs](README.md). Address: `/sign#token`. Built in: `web/src/app/sign/page.tsx`,
`sign-screen.tsx`, `web/src/lib/links/screen.ts`, `web/src/lib/agreements/screen.ts`. Stage S5a-11b.

## Purpose

The homeowner's page from a signing link the technician made on [Review](review.md): read the same
documents the technician's phone shows (the proposal with the company's start-work authorization and
payment terms, the itemized claim, the scope defense letter, the photo audit log), then sign once.
After signing it shows the signed record and, once only, the links to the signed documents. The
token is only in the address's fragment, which the browser never sends, so no server log holds it;
the page sends it in a header. No sign-in, not indexed, no referrer, not kept for offline use.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Holder of the link (homeowner, adjuster or other signer) | the company's name, the link's end date, the documents for that one estimate | sign once; after signing, see the signed record for 30 days |
| Owner, estimator, office | the same as any holder; no company sign-in is used | the same |
| Superadmin support | the same as any holder | the same |
| Different-company user | the same as any holder: the token alone decides | the same |

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
  them now: they are shown only this once."
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
