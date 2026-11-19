# Prices

Part of [Screen specs](README.md). Address: `/sign-in/{address}/prices`. Built in:
`web/src/app/(auth)/sign-in/[address]/prices/page.tsx`, `prices-screen.tsx` (sign-in check and the
reader view), `prices-editor.tsx` (the owner's working copy), `item-card.tsx`, `price-form.tsx`,
`price-list.tsx`, `room-pays.tsx`, `settings-sections.tsx`, `publish-panel.tsx` (preview, publish,
versions, price-list file), `ui.tsx`; logic in `web/src/lib/prices/`. Stages S4-6 (API), S4-7
(file), S4-8 (screen).

## Purpose

Each company sets its own prices; DryScope supplies none ("DryScope supplies no prices: every price
here is yours."). The owner edits a working copy (items by heading, per-row prices and bands, "What
does this room pay?", settings), previews it on sample jobs, and publishes it as the next version.
New estimates use the newest version; an estimate already priced keeps its version. With no
published version, no estimate can be priced (AGENTS.md rule 3). Estimators and office see the
current version read only.

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the editor: "Estimates use version {n}, published {date}." (or "No prices are published yet…"), Items, What does this room pay?, Settings, Publish, Versions, Price-list file | save or undo the working copy, preview, publish (sign-in under 15 minutes), restore a version into the working copy, download and import the CSV price list |
| Estimator | "Version {n}, published {date}. Only the owner can change the prices." with the items and room pays read only; or "The owner has not published any prices yet, so estimates cannot be priced." | nothing |
| Office | the same as an estimator | nothing |
| Superadmin support | nothing here; the operator's read-only prices route has no screen yet | nothing |
| Different-company user | a sign-in from another tenant is signed out; every prices route uses the company of the sign-in | nothing |

All roles above need the company's `price_books` switch on (`PRICE_CAPABILITIES` in
`web/src/lib/access/roles.ts`). With it off the screen shows "Prices are not available" ("Prices
are not open for {company} yet.") and asks nothing about prices.

## States

- Sign-in not set up, checking, signed out ("Sign in to see the prices": "The prices are for the
  team of {company}…"), unfinished sign-in, could not secure saved work, unavailable ("We could not
  open the prices"): as on [Team](team.md).
- Prices switched off (or switched off since `/api/me` answered, a 404): "Prices are not available".
- Editor: "You have changes that are not saved." / "All changes are saved."; a field marked "Use a
  whole number" holds something else; stale working copy: "Reload the saved prices".
- Publish: "Check the prices before publishing", then "Not ready to publish: {reason}" or the form
  ("What changed (kept with the version)", 3 to 500 characters; the first publish also asks whether
  estimates show "A price range (low to high)" or "One price"); sign-in too old: "Sign in again" ("Save
  your changes before you sign in again.").
- Versions: "No version is published yet."; restore asks first ("This replaces the working copy…").

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Who is signed in | `GET /api/me` | member |
| Read prices | `GET /api/prices` (the owner also gets the working copy) | `prices_read` |
| Save changes | `PUT /api/prices/working-copy` | `prices_manage` |
| Preview on sample jobs, check before publishing | `POST /api/prices/preview` | `prices_manage` |
| Publish these prices | `POST /api/prices/publish` | `prices_manage`, sign-in under 15 minutes |
| List versions | `GET /api/prices/versions` | `prices_manage` |
| Restore a version | `POST /api/prices/versions/{id}/restore` | `prices_manage` |
| Download the price list | `GET /api/prices/export` | `prices_manage` |
| Import a price list | `POST /api/prices/import` | `prices_manage` |

Rules: `docs/access/prices.md`; pricing source `docs/pricing-source.md`.

## Not built yet

- Reprice and its preview (S5b-6), named adjustments (S5b-7).
- The operator's read-only prices view (`GET /api/platform/companies/{id}/prices` exists; no
  operator screen calls it).

## Mismatches to check

- Estimators and office hold `prices_read`, but no screen links here for them: the only link is on
  [Company settings](company-settings.md), which only the owner can open, and the
  [sign-in page](sign-in.md) has none. They must type the address.
