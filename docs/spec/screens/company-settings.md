# Company settings

Part of [Screen specs](README.md). Address: `/sign-in/{address}/company`. Built in:
`web/src/app/(auth)/sign-in/[address]/company/page.tsx`, `company-screen.tsx` (sign-in check),
`company-form.tsx` (profile and letterhead), `documents-section.tsx` (document settings),
`ai-usage-section.tsx`; words and checks in `web/src/lib/profile/screen.ts`. Stages S5a-4, S5a-4b,
S7-4.

## Purpose

The owner sets what prints on the company's documents: the company profile (company address, phone,
email, CSLB licence, document sign-off), the letterhead lines (emergency phone, fax, website,
tagline, mailing address) and the document settings (proposal layout, the company's own clauses,
photo log, start-work authorization, payment terms). The two documents carry different parts. The
proposal's letterhead prints the name, tagline, address, mailing address, phone, emergency phone,
fax, email, website and CSLB licence, each line only when set (`letterheadLines` in
`web/src/lib/estimates/proposal.ts`). The scope defense letter builds its own header from the
company name, address, phone and CSLB licence only, so the tagline, mailing address, emergency
phone, fax, email and website do not print there, and it closes with the sign-off and the company
name (`web/src/engine/documents.ts`). The settings do different things too. The company's prep task
texts are the list the field picker offers on Check Scope (`web/src/lib/scope-lists/service.ts`);
the proposal letter prints the prep tasks recorded in each room, as submitted, not the company's list
(`web/src/lib/estimates/inputs.ts`, `web/src/engine/proposal-letter.ts`). "Show the previous price
on a revised estimate" is saved but changes nothing yet: the document reader does not pass it to the
engine, and Reprice, the revised estimate, is not built (see "Not built yet"). The company name is set by DryScope when the company is created and is shown, not
edited. A box at the top says whether documents can be issued and signed, or lists what is still
needed (the engine's setup check). Each company's identity prints exactly as entered here (AGENTS.md
rule 7).

## Who may see it and do what

| Role | Sees | Can do |
|---|---|---|
| Owner | the whole screen; "Prices" link while the company's prices are on; "AI use" (today and this month against the ceilings) | save the profile, letterhead and document settings |
| Estimator | "This screen is for the company owner" ("Only the owner of {company} can see and change the company settings."); the profile is never requested | nothing |
| Office | the same as an estimator | nothing |
| Superadmin support | nothing: no operator screen shows the profile | nothing |
| Different-company user | a sign-in from another tenant is signed out; the routes check the company from the sign-in | nothing |

The screen requests the profile only for `profile_manage`, the AI use only for `ai_usage_read`, and
shows the Prices link only when `GET /api/me` says the role can read prices (`pricesAccess`).

## States

- Sign-in not set up, checking, signed out ("Sign in to change the company settings"), unfinished
  sign-in, could not secure saved work, unavailable ("We could not open the company settings"): as
  on [Team](team.md).
- Ready: "Ready to issue and sign documents" or "Still needed before documents can be issued and
  signed" with the missing items.
- Saving, saved, refused: the server's message. A stale revision (another owner tab saved first) is
  refused with 409 `stale_revision` and the profile as saved: that saved profile replaces the whole
  form, the typed profile and letterhead fields and the document settings alike, so the owner must
  enter the edit again (`show` in `company-form.tsx`). Other refusals keep the typed values.
- AI use: "Loading the AI use…", or "We could not load the AI use…".

## Key actions and server routes

| Action | Route | Key |
|---|---|---|
| Who is signed in | `GET /api/me` | member |
| Read the profile and settings | `GET /api/companies/{id}/profile` | `profile_manage` |
| Save | `PUT /api/companies/{id}/profile` (with the read revision) | `profile_manage` |
| Read AI use | `GET /api/companies/{id}/ai-usage` | `ai_usage_read` |
| Open Prices | `/sign-in/{address}/prices` ([Prices](prices.md)) | `prices_read` |

Rules: `docs/access/company-profile.md`, `docs/access/ai-usage.md`.

## Not built yet

- Reprice and the revised estimate that "Show the previous price on a revised estimate" is for
  (S5b-6): the setting is stored and not used.
- Record retention days (`retention_manage`) and delivery settings (`delivery_manage`): keys exist
  in `web/src/lib/access/roles.ts`, no screen in `web/`.

## Mismatches to check

None found.
