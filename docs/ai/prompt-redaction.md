# What AI prompts leave out, and what can still get through

Every AI request's job facts pass through one shared builder before they leave the server: `web/src/lib/ai/prompt-facts.ts`. It runs before Model Armor's screen and before the model (docs/plans/S7.md section 3: no customer name, address or coordinates in any prompt). The owner decided the rules on 2026-11-17 (S7-6 review). This page says what the builder removes, and what it cannot catch.

## Where the text comes from

The server never puts the job's saved customer record or property address into a request. It reads them only so the builder can remove them where a technician typed them. The facts that do go out are the technician's own words and numbers:

- the draft's notes;
- room names, findings and prep tasks;
- walkthrough turns that passed screening;
- voice notes the technician reviewed.

Any of these can hold personal details, so every string in them is cleaned.

## What is removed

Each match is replaced by `[removed]`. Matching ignores case, and a match must be a whole word or number.

- **The saved customer name.** The builder removes:
  - the full name, also written "Last, First";
  - the surname after a title (Mr, Mrs, Ms, Miss, Mx, Dr);
  - each of these with a possessive ('s).

  A name word on its own is kept. For a customer named Mary Hall, "the hall" stays.
- **The saved property address.** Each comma-separated part is removed in its common spellings:
  - street words and their short forms (Street or St, Avenue or Ave, Road or Rd, Lane or Ln, and the others in the file);
  - unit words (Unit, Apt, Suite, Ste, No, #);
  - house numbers with or without # or leading zeros;
  - any case, punctuation or spacing.

  The street without its house number or its unit is removed, and so is the ZIP code on its own.
- **Any email address.**
- **Any phone number.** This covers North American numbers (with or without +1, area code in brackets or not, or ten digits run together), seven-digit numbers written with a separator, and numbers starting with +.
- **Anything shaped like coordinates:**
  - a decimal pair where one value is signed, or both have two or more decimals;
  - latitude or longitude words with a number;
  - a number with a degree sign (temperatures such as 70°F are kept);
  - degrees with minutes;
  - a pair with compass letters, whole or decimal ("37N 122W");
  - any decimal with four or more decimals.

The route test `web/tests/db/summary-draft-api.test.ts` sends each kind through the summary draft route. It checks that the variant reaches neither Model Armor's input nor the model request. Unit tests in `web/tests/unit/summary-draft.test.ts` cover the spellings and the words that must stay.

## What can still get through

These are known gaps. The owner has accepted them for now.

- **Names typed before the customer is saved.** The builder only knows the saved name. A name typed into a note before the customer record exists, or a name that differs from the saved one, is not removed. The same applies to other people's names, such as a tenant or a neighbour.
- **A first name or surname used on its own.** "Mary called" stays, and so does "Hall's dog" without a title. This is deliberate, so that ordinary words are never lost.
- **Unusual address spellings.** A misspelled street, a street name without its suffix word ("on Oak"), a house number written in words, or a cross street is not matched. The same goes for a nearby landmark or business name, and for a city or ZIP that is not in the saved address.
- **Coordinates in rare formats.** Examples are a pair with one decimal place and no sign, a grid reference, or a plus code.
- **Other contact details.** A street address that is not the job's own (the customer's mailing address, a supplier's) is not matched. Nor is a phone number in an unusual international format.
- **Some false removals.** A number range written like a seven-digit phone number ("100-2000"), any ten-digit number (such as a claim number), and any number with a degree sign that is not a temperature are removed.

Nothing else screens personal data in a prompt before the model. The Model Armor templates are not changed for this (owner decision, 2026-11-17: no Sensitive Data Protection and no template change in S7-6). Model Armor's own checks run on what the builder lets through.

## Changing the rules

Each change to `prompt-facts.ts` needs a test of the new case through the route, as above. It applies to every AI feature that uses the builder (S7-6 now; S7-7, S7-10 and the Live admit facts when they are built). Re-run the affected AI evaluation, because a removal can change what the model sees.
