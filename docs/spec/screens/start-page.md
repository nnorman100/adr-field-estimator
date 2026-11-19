# Start page

Part of [Screen specs](README.md). Address: `/`. Built in: `web/src/app/page.tsx`,
`web/src/app/remembered-sign-in.tsx`. Stage S3-13 (owner decision D5).

## Purpose

The bare address of the app. A phone that has opened a company's sign-in page before goes straight
back to it (`rememberedSignInAddress` in `web/src/lib/sign-in/remember.ts`). Otherwise the page
says "To sign in, open your company's sign-in link." There is no company list and no sign-in form
here: each company signs in at its own address ([Company sign-in](sign-in.md)).

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner, estimator, office | on a phone that remembers a sign-in page, that page; otherwise "DryScope" and the sentence above | open "Health check" |
| Superadmin support | the same; the operator signs in at `/operator/{tenantId}` ([Operator: companies](operator-companies.md)) | the same |
| Different-company user | the same: the page names no company | the same |
| Anyone, signed out | the same | the same |

## States

- Remembered sign-in page: replaced at once by `/sign-in/{address}`. That is a fresh visit to the
  [sign-in page](sign-in.md), so if the company has since been suspended or archived the person
  lands on "This sign-in link is not recognised" there, not on the inactive-company panel.
- None remembered: the title, the sentence and a "Health check" button.

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Health check | `GET /api/health` (opened as a page) | none |

## Not built yet

Nothing.

## Mismatches to check

None found.
