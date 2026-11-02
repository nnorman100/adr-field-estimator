# Design guide

Facts below come from `README.md` (Branding) and `public/app.css`. Anything in brackets needs the owner.

## Principles
- Phone first, one-handed, in the field. Large tap targets. Works with bad signal.
- Show only what the app can prove. Pending or failed recognition says so; color emulation is not thermal evidence.
- Plain words. Say exactly what happened and what to do next.

## Visual
- Static app, no build step; tokens in `public/app.css`.
- Palette: navy `#0B2545`, water blue `#7CC4E8`, mold green `#9ED8A8`.
- Success states use a navy check mark, never green. Green never means success.
- Room cards tagged WATER, MOLD or both in tints; printed documents use words only.
- Fonts: Lato (interface), EB Garamond (documents); hosted locally with licenses in `public/fonts/`.
- Logo: droplet and spore cluster in a moisture-meter ring (`public/brand/`). A company's own logo always replaces it. No built-in company logo.
- Header: navy bar with the white DryScope lockup, Help and Account. Below it, the company name, logo and contact details.

## Layout
- Step bar: 1 Walk & Photo · 2 Check Scope · 3 Review & Sign.
- Mobile job header: **← Jobs**, title with save status, **More**.
- Desktop and print keep tables; phones use line-item cards.

## Required on every screen
- Loading, empty, error and offline states.
- Labels on inputs, visible focus, contrast AA, keyboard reachable.
- New or changed front-end files added to the `sw.js` precache with a shell version bump.
- A Help how-to for each role that sees the feature.

## Copy
- Use the terms in `docs/GLOSSARY.md`.
- [Tone guidance for customer-facing documents — owner to confirm.]
