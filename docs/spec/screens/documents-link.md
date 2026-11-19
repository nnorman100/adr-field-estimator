# Signed estimate documents (document link)

Part of [Screen specs](README.md). Address: `/documents#token`. Built in:
`web/src/app/documents/page.tsx`, `documents-screen.tsx`, `web/src/lib/links/screen.ts`. Stage
S5a-11b.

## Purpose

A read-only page of one signed job's documents, for 30 days or until the company revokes the link.
There are two sets (`SET_NAMES`): "Homeowner's documents" (the signed proposal, who signed, their role
when given, when and how, the signature and the photo log) and "Adjuster's documents" (the price, the
itemized claim and the scope defense letter, with no photos). The token is only in the address's
fragment and goes to the link routes in a header. No sign-in, not indexed, no referrer, not kept for
offline use.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Holder of the link (homeowner or adjuster) | that link's set | read it; nothing else |
| Owner, estimator, office | the same as any holder; links are made and revoked on [Review](review.md) | read it |
| Superadmin support | the same as any holder | read it |
| Different-company user | the same as any holder: the token alone decides | read it |

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
| Show the signature (homeowner's set only) | `GET /api/documents/signature` | the link |
| Show one photo (homeowner's set only) | `GET /api/documents/photos/{photoId}` | the link |

Rules: `docs/access/signing-links.md`, `docs/access/non-role-access.md`.

## Not built yet

- Emailing the documents to the homeowner or adjuster (S9; J7).

## Mismatches to check

None found.
