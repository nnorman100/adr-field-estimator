---
version: alpha
name: DryScope
description: >-
  A phone web app a restoration technician uses to walk a water or mold loss once and leave with a
  priced, signable estimate. Plain, high-contrast, one-handed. DryScope's own look is the product
  default; each company's logo, name and letterhead replace it on that company's documents.
colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.205 0 0)"
  on-primary: "oklch(0.985 0 0)"
  accent: "oklch(0.97 0 0)"
  on-accent: "oklch(0.205 0 0)"
  input: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  line-faint: "oklch(0.145 0 0 / 0.2)"
  line-field: "oklch(0.145 0 0 / 0.4)"
  scrim: "rgb(0 0 0 / 0.4)"
  error: "oklch(0.444 0.177 26.899)"
  error-line: "oklch(0.505 0.213 27.518)"
  attention-line: "oklch(0.555 0.163 48.998)"
  signature-line: "oklch(0.551 0.027 264.364)"
  signature-ink: "#111827"
  paper: "#FFFFFF"
  launch-background: "#F6F8FA"
  brand-navy: "#0B2545"
  brand-water-blue: "#7CC4E8"
  brand-mold-green: "#9ED8A8"
typography:
  page-title:
    fontFamily: system-ui
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.333
  section-title:
    fontFamily: system-ui
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
  card-title:
    fontFamily: system-ui
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.556
  body:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-strong:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.429
  note:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.429
  button:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.429
  product-name:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.429
    letterSpacing: 0.025em
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  sheet: 16px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  tap-target: 44px
  tap-target-large: 48px
  panel-width: 384px
  form-width: 448px
  page-width: 672px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: "{spacing.tap-target}"
    padding: 16px
  button-primary-large:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: "{spacing.tap-target-large}"
    padding: 24px
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    height: "{spacing.tap-target}"
    padding: 16px
  button-outline-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
  text-field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "{spacing.tap-target}"
    padding: 12px
  field-error:
    textColor: "{colors.error}"
    typography: "{typography.label}"
  card:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px
  banner:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    padding: 16px
  dialog:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sheet}"
    padding: 24px
  signature-pad:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.signature-ink}"
    rounded: "{rounded.md}"
    height: 176px
---

# DryScope design guide

This file follows the [DESIGN.md format](https://github.com/google-labs-code/design.md): the front
matter above holds the tokens, and this text says why. Check it with
`npx @google/design.md lint docs/DESIGN.md` (a dev-only tool; it is not a dependency of the repo).
`npm run lint` also checks that the colours mapped in `scripts/check-design-tokens.mts` match the
`:root` properties in `web/src/app/globals.css`, which is the source of truth; change the stylesheet
first, then this file.

Every token is read from the app in `web/` (`web/src/app/globals.css`, the components under
`web/src/components/ui/` and `web/src/app/`, the Tailwind v4 defaults those classes resolve to, and
`web/public/icon.svg`). Where the app sets no value, this guide leaves the token out and says so
below instead of inventing one. The old app (`public/`, `app.css`, `sw.js`) is retired and is no
longer a source for anything here.

## Overview

DryScope is used by a restoration technician standing in a wet room, often with one hand free, wet
gloves, a bright window behind the screen and bad signal. A homeowner then reads and signs what the
technician made. So the interface is plain, high-contrast and quiet: large controls, short words, no
decoration that has to be understood before it can be used.

Principles that every screen keeps:

- **Phone first, one-handed, in the field.** One column at phone width. Large tap targets. Works
  with bad signal.
- **Show only what the app can prove.** A pending or failed result says so. A colour that looks like
  evidence is not evidence (colour emulation is not thermal evidence).
- **Plain words.** Say exactly what happened and what to do next. Use the terms in
  `docs/GLOSSARY.md`.
- **Prices and mandatory wording come from the server**, never from the screen or a model. The
  screen shows them; it does not make them up or drop them.

The job runs in three steps: Walk & Photo, Check Scope, Review & Sign. The web app's screens use the
name Check Scope for the middle step.

### One product, many companies

Each restoration company has its own isolated workspace. DryScope's own look (the navy, the logo,
the system type below) is the product default and is what a person sees before sign-in. After
sign-in, and on every printed or sent document, the company's logo, name, licence number, contact
details and letterhead replace it, exactly as the company entered them. There is no built-in
company logo: a company without a saved logo shows its name alone. This guide names no company.

## Colors

The interface today is neutral. `web/src/app/globals.css` defines eight grey tokens (`background`,
`foreground`, `primary`, `on-primary`, `accent`, `on-accent`, `input`, `ring`) and the screens use
those plus a few Tailwind palette colours. Navy and the two logo tints exist as brand values but are
not yet applied to the interface chrome; this guide records them as brand tokens and does not claim
the screens use them. There is no dark theme: `globals.css` defines only the light values.

- **Background / Foreground** `{colors.background}` on `{colors.foreground}`: the page and its text,
  about 19.8:1.
- **Primary / On primary**: the filled button and its label, about 17.2:1. `Accent` is the pressed
  and hover tint (about 18.2:1 under foreground) and the fill of the "not saved" banner.
- **Faint and field lines.** Card and divider borders use foreground at 20% (`line-faint`); text
  fields use foreground at 40% (`line-field`); `input` is the border of the outline button and the
  dialogs.
- **Error** `{colors.error}` (about 8.4:1 on white) is the colour of an error message. It always
  sits beside words; an error is never colour alone. `error-line` is the border of an error box.
- **Attention line** is the border of the "not ready to sign" box. **Signature line** is the dashed
  border of the signature pad, which is drawn in `signature-ink` on `paper`.
- **Brand navy** `{colors.brand-navy}` is the DryScope header colour: the phone's theme colour, the
  Home Screen icon and the installed app's title bar. White on navy is about 15.4:1.
- **Brand water blue and mold green** are the logo's two tints (`web/public/icon.svg`). They exist
  for the WATER and MOLD tags (see Components). Both are too light to carry text on white (about
  1.9:1 and 1.6:1), so a tag using them always has its word, set in dark text.
- **Launch background** `{colors.launch-background}` is the installed app's start-up colour in the
  web manifest.

Rules for colour:

- **Green never means success.** A success state shows a navy check mark with words. Mold green means
  mold and nothing else.
- Colour never carries meaning alone. Every state has words (and an icon where one helps).
- Printed documents use words only: no tints, no tags in colour.

## Typography

The app loads no web font. Text is the platform's system font (the Tailwind default stack:
`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, Roboto and so on), so the tokens name `system-ui`.
The old app's Lato and EB Garamond are not used by the web app and are not tokens here. Whether the
web app takes up a brand face, and a serif for documents, is an owner decision that is not made; the
guide will gain tokens when it is.

Sizes and weights in use: 24 px, 20 px, 18 px, 16 px and 14 px, in weight 400, 500 and 600. A page has
one title (`page-title`, weight 600); sections use `section-title`; cards use `card-title`.

- **Body is 16 px, and text fields are 16 px.** iOS Safari zooms the page into any field set smaller
  than 16 px, which throws the layout off for a technician wearing gloves.
- **Labels and notes are 14 px** and are used for the visible label of a field, a hint and a status
  line. Never smaller.
- Use no more than three weights on a screen. Bold is for the one thing to read first.
- The product name `DryScope` above a panel is set small and tracked (`product-name`).

## Layout

One column and 16 px page gutters. Sign-in and settings panels are 384 px wide at most and centred;
forms stay under 448 px; wider content (a price list, a signed record) stops at 672 px. Spacing is
Tailwind's 4 px unit: 4, 8, 12, 16 and 24 px cover the gaps and padding the screens use.

- **Tap targets are at least 44 px** (`tap-target`): buttons, text fields and inline links in the
  field shell. A primary action that ends a step may be 48 px (`tap-target-large`).
- **Sticky action bar.** A long form keeps its save action in a bar stuck to the bottom of the screen
  with a faint top line, so a thumb reaches it without scrolling.
- Desktop and print keep tables; phones show line items as cards. (The web app has no desktop table
  layout of its own yet; this stays the rule when it does.)
- The viewport is the device width, with no fixed zoom. The page is never wider than the screen.

## Elevation & Depth

The interface is flat. Depth is a 1 px line, never a shadow: `line-faint` around a card, `line-field`
around a field, a faint top line on the sticky action bar. A dialog and the Home Screen sheet sit
above a 40% black `scrim`; they are not lifted with shadow. Nothing uses blur, gradient or glass.

## Shapes

Corners are small and uniform. Buttons, fields, cards and the signature pad use `rounded.md` (6 px);
a dialog or bottom sheet uses `rounded.sheet` (16 px). `rounded.sm` (the default small corner) and
`rounded.lg` are the smaller and larger steps the app uses in a few places. Do not mix sharp and
rounded corners on one screen.

## Components

- **Buttons.** The filled button (`button-primary`) is the one most important action on the screen.
  The outline button (`button-outline`) is every other action. Both are 44 px high with a 14 px
  medium label; the large size is 48 px. Disabled buttons fade to half strength and stop taking taps.
  Focus is a 2 px ring in `ring`, shown for keyboard use.
- **Text fields.** `text-field` is 44 px tall, 16 px text, a 40% foreground line. A field always has
  a visible label above it, not a placeholder standing in for one. An error message sits directly
  under the field in `field-error`, linked to the field so a screen reader reads it with the field.
- **Cards.** A room, a price item or a record is a `card`: a faint line, 12 px padding, rounded
  corners, one idea.
- **Banners.** No signal and "not saved on this phone" banners sit at the top in `banner`, state what
  is true in plain words, say what to do next, and announce themselves to a screen reader.
- **Dialogs and the Home Screen sheet** use `dialog`: a 16 px corner, 24 px padding, a scrim behind,
  and focus kept inside until it is closed.
- **Signature pad.** White, a dashed 2 px border, 176 px tall, ink `signature-ink`. It does not scroll
  or select text while a finger draws on it.
- **WATER and MOLD tags.** A room, and the on-screen review, is tagged WATER, MOLD or both from the
  room's loss type, in the water-blue and mold-green tints, always with the word. The web app has
  not built the tinted tag yet (a room's loss type is a plain choice today), so there is no tag
  component token; this is the rule it follows when built. Printed documents carry the words only.
- **Success.** A success state is a navy check mark and words (for example, saved, sent, signed).
  See "Known departures" for where the app does not yet follow this.

## Required on every screen

- **Loading, empty, error and offline states.** Each says what is happening and what to do next. No
  blank screen, no bare spinner without words.
- **Labels on inputs, visible focus, keyboard reachable.** Every control can be reached and used
  without a pointer, in a sensible order, with a visible focus ring.
- **Contrast AA.** 4.5:1 for text under 24 px (or 18.66 px bold), 3:1 for large text and for the
  lines a person needs to see to use a control.
- **A Help how-to for each role that sees the feature.** A technician, an office user and an owner
  each get help written for what they do.
- **Customer-facing wording.** Prices and the mandatory wording, including the California pre-1978
  and estimate clauses, come from the server and print exactly as written in `docs/ARCHITECTURE.md`.
  A company's name, licence number and sign-off print exactly as the company entered them.
  [Tone guidance for customer-facing documents: owner to confirm.]

## Do's and Don'ts

- Do keep every target at least 44 px, and put the main action where a thumb reaches it.
- Do give every state words: what happened and what to do next.
- Do use a navy check for success. Don't use green for it; green means mold.
- Don't carry meaning by colour alone, and don't use colour in a printed document.
- Do keep field text at 16 px or more. Don't use a placeholder as a label.
- Do show the company's own logo, name and letterhead on its documents. Don't show DryScope's logo as
  a company's, and don't print a price or clause the server did not supply.
- Don't add a shadow, gradient or blur; depth is a line.
- Do keep pending and failed results visibly pending or failed. Don't present a guess as proof.

## Known departures from this guide (follow-ups, not fixed here)

This guide was written from the code as it stands. Where the code does not yet follow a rule, the
rule stays and the gap is listed so nothing here is false:

- The signed record boxes (`documents-screen.tsx`, `review/signing.tsx`) use a **green** border
  (Tailwind green-800) for a signed state. The rule is a navy check, never green.
- The focus ring `ring` (about 2.6:1 on white) and the text-field line `line-field` (about 2.7:1)
  are below the 3:1 non-text contrast in WCAG 2.2 (1.4.11). The `input` line (about 1.3:1) used by
  the outline button, dialogs and banners is lower still.
- Navy, water blue, mold green and the WATER and MOLD tags are not applied in the interface yet.
