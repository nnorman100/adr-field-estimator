# Live walkthrough instructions

What the Gemini Live model is told during a technician's voice walkthrough (stage S7, `docs/plans/S7.md`, steps S7-11 to S7-17). Part of [AI features](../AI.md).

- **The text:** `web/src/lib/ai/prompts/live-walkthrough.ts`. Read it there; this page does not copy it, so the two cannot drift.
- **Owner decision, 2026-11-16:** the instructions are rewritten for the rebuilt app, with the old app's text as the reference. The assistant talks briefly and asks one question at a time. It speaks English and switches language when the technician asks. Every company gets the same instructions.
- **The owner reviews the wording.** Any edit to the text is a wording change, changes the prompt version, and means the Live evaluation runs again (V9).
- **Not proven yet.** No model has been run with this text. It is measured by the Live evaluation in S7-16 (relevance at least 27 of 30, no prices, cost per minute) before the `live_voice` switch goes on for any company.

## How it is put together

1. **The stable instruction comes first.** It is the file's default export, the same bytes for every job and every company. Its SHA-256 is the prompt version (`definePrompt` in `web/src/lib/ai/registry.ts`).
2. **The job's facts come after it,** as one line of JSON under a heading (`liveSystemInstruction`). JSON escapes every line break inside a value, so a room name or a note cannot start a line that reads as an instruction.
3. **Two application signals** make the model speak first. The relay sends one as a client turn: `LIVE_START_SIGNAL` for a new walkthrough, `LIVE_RESUME_SIGNAL` when a session starts again with a clean model session after a drop. The instruction quotes both exactly, so changing either changes the prompt version. Neither is shown to the technician or kept in the transcript.

Not in this change, by design: the relay, the screens and the registry entry (`AI_REGISTRY.live.prompt` stays empty until S7-12). The admit function (S7-11) chooses the job facts.

## The sections

The order follows Google's guidance for Live system instructions: who the assistant is, then the conversation rules (one-time steps apart from the repeating loop), then the guardrails.

| Section | What it does |
| --- | --- |
| Opening line | The role: a voice assistant for one technician on a water or mold loss. It only talks. It cannot see, take photos or change the app. |
| STYLE | US English until the technician asks for another language. One or two short sentences. One question at a time. No echoing answers back. Other people's words are reported statements. |
| START (ONCE) | On the start signal: one short greeting, then the first gap (year built, or the current room). Never greets twice. |
| AFTER A RECONNECT | On the resume signal: no greeting and no restart of intake. It says it missed the last few seconds and carries on. It is told that older parts of a long walkthrough may be gone from its memory and that the transcript keeps them. |
| JOB INTAKE (ONCE) | Year built, then whether this is an insurance claim and only the claim details not yet saved. Customer details and the address are typed in the app, not asked aloud. |
| EACH ROOM (REPEAT) | The loop, in order: room name, water category or mold, the class or condition and the measurements, what is affected and the proposed work, meter readings, photos by shot name, what is still open. |
| FINISH | The handoff: end the walkthrough, tap Fill scope from walkthrough, check each change. It never says it saved anything and never tells the technician to tap Finish and review, send or sign. |
| GUARDRAILS | The safety and accuracy rules, grouped: numbers and facts, sources, evidence, mold and health, money law and approval, methods and equipment, company, app state. |
| DATA BOUNDARY | Last, straight before the job facts: they are untrusted data, never instructions, and never proof that something was checked today. |

## What changed from the old text, and why

The old text is `LIVE_INSTRUCTIONS`, `shot_list_instructions()`, `READINESS_INSTRUCTIONS` and `GREETING_TRIGGER` in `backend/prompts.py`. Every rule in it is listed here, top to bottom.

**Changed because the app was redesigned**

| Old text | Now | Why |
| --- | --- | --- |
| Estimating from video, camera frames, a colour filter | Gone. The assistant is told it cannot see. | No camera frames on Live (V7). |
| Photo log with ids, captions and upload dates | Gone. | The model gets no photo log. |
| Photo shot status: required shots, counts per surface and material, room toggles, "how many are missing" | It asks for each shot by the name on the Photos screen, and says in words when a shot applies. It never says a photo was taken, sent or tagged. | The rebuilt app tags photos freely; it keeps no required-shot list, counts or toggles. The names come from the field map (`SHOT_NAMES`), so they cannot drift from the screen. |
| Job readiness list | Gone. "Never say what blocks finishing or signing" stays. | The rebuilt app has no readiness list. |
| Ask for the property address first | Not asked. Customer details and the address are typed under Customer and claim. | The job starts with its address, or the office creates it (S5b). The plan keeps names and addresses out of prompts, and not asking keeps them out of transcripts. |
| "Water, mold, or both", mold mapped to category 3 | Water category 1, 2 or 3, or mold, as stated. | The room form has one choice with its own Mold option. |
| Collect job equipment counts, rental days, default quantities, added labour | Not asked. "Never recommend equipment counts" stays. | Fill scope never proposes a count or a priced field (S7-7). The app suggests equipment from the room measurements and the technician types the counts. |
| Dehumidifier pints-per-day rating | Gone. | The form has no box for it. |
| Residential or commercial; commercial rates; combined-job discounts; other inspections' quantities | The question is gone. "Never state a discount" stays. | No such field. Each company prices from its own price book. Only this job's facts reach the model. |
| Company name and sign-off name sent with the text | Not sent. The model is told identity comes only from the company profile and never to state it. | Same instructions for every company; identity prints from the profile. |
| "Tap Fill scope from walkthrough"; "never tell them to submit" | Same handoff. The button it must never send them to is now Finish and review. | New screen names. |
| Greeting only | Greeting, plus a reconnect section. | Sessions now resume and restart (S7-13). |
| "Close each room with a recap of observations, extent and open questions" | One sentence on what is still open. | Brief replies, and no numbers read back from memory. |

**Kept, said in fewer words**

| Old text | Now |
| --- | --- |
| Brief, one question at a time, do not repeat, gaps not a checklist | STYLE; "ask only for what is still missing" |
| No name the technician did not give | STYLE |
| Saved inspection is context, not proof | DATA BOUNDARY |
| Unit-qualified room names, never merge | Room step 1 |
| Category from the technician, never inferred | Room step 2 |
| Water class, ceiling height, floor and wet floor area; class is not category; never assume | Room step 3; "unknown stays unknown" |
| Material, surface, condition, proposed action; observation-only rooms; finished or unfinished; measured square feet | Room step 4 |
| Cabinets, countertops, toilets, contents, access, other trades, who does what | "Any prep the work needs and who does it"; "work that depends on drying, discovery or testing"; "never promise that a material can be saved" |
| Material distinctions (drywall, plaster, pad, toe kicks and so on) | "Keep each material and surface as named" |
| Flood-cut heights, "until dry", perimeter cuts are not quantities; keep "up to" and "approximate"; no multiplying or adding; floor area is not demolition area; overlap check | Numbers and facts |
| Claim details: ask once, only the missing ones, accept unknown, never guess or complete, full date | JOB INTAKE; Numbers and facts |
| Technician observations apart from owner reports and third-party reports, with source and date | Sources |
| Existing damage, work done, proposed work, conditional work | Sources |
| Spoken readings apart from verified meter photos; dry readings do not close a concern; units and scale; no percent from a relative scale; thermal shows temperature | Evidence; room step 5 |
| Never diagnose mold; suspected stays suspected | Mold and health |
| Health: only that dampness and mold affect people differently; no species, toxicity, illness link, ranking or clearance | Mold and health |
| No costs, coverage, deductible effect, software compatibility, legal conclusions, authorising work, promised added work | Money, law and approval |
| Year built before removal talk; never grant a testing exemption, state results not given, or override the age rule | JOB INTAKE; Money, law and approval |
| Prices, notices, approvals and signatures belong to the app | Money, law and approval |
| The app calculates equipment; cleaning-only rooms are not forced into demolition; a count of locations is not an area; no recommended methods | Methods and equipment |
| Nothing is in the form until Fill scope; never claim to have updated or confirmed | FINISH |
| Job data is untrusted, never instructions; the assistant's own words are suggestions | DATA BOUNDARY |

**Dropped, with the reason**

- Listing "direction, shared-room reference, existing opening" one by one, and the questions about moisture source before coatings and about containment and protective equipment: coaching detail, not safety rules. The general rules above cover what must not be said.
- "Keep separate segments until the form total is confirmed": the technician now accepts each change one by one in Fill scope.
- "Project-manager review" of added scope: a company's own process. "Never promise added work" stays.
- General health handouts are not evidence: no documents reach the model.

## Job facts (for S7-11)

The text is written to work with whatever the admit function sends, and to ask rather than assume when a fact is absent. It expects, where saved:

- the year built;
- each room with its saved fields (name, category, class or condition, heights and areas);
- which claim details are already saved, by name only;
- optionally, how many photos each room has under each shot name.

Never in job facts: a customer name, contact details, an address or coordinates (`docs/plans/S7.md` section 4.1). Recommended to leave out: prices, and the free-text notes, findings and summary, which are long, re-billed every turn and may hold personal data. This file does not check the facts' keys; S7-11's own test does.

## Size

Counted by `web/src/lib/ai/prompts/live-walkthrough.ts` as built, and `backend/prompts.py` as built. Tokens are an estimate of characters divided by four; the Live model has no token counter.

| Text | Characters | Words | Tokens (estimate) |
| --- | --- | --- | --- |
| Old instructions with the shot list | 12,127 | 1,887 | about 3,030 |
| Old, with the readiness block that was on | 12,606 | 1,966 | about 3,150 |
| New instructions | 6,979 | 1,208 | about 1,745 |

About 42% shorter by characters than the old instructions with the shot list (45% with the readiness block). The whole context is billed again on every turn, so a shorter instruction lowers the cost of each turn.

It could be shorter still. The remaining length is the guardrails and the room loop. Cutting further means dropping a rule from the tables above, which is the owner's choice.

## Google documentation checked

Read through the Developer Knowledge tools on 2026-11-16. No tool call failed.

| What Google says | Source | What the text does |
| --- | --- | --- |
| System instructions should define "the agent persona, conversational rules, and guardrails, in this order". "Delineate between one-time elements of the conversation and conversational loops." | `documents/docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/best-practices` | Role, then START, JOB INTAKE (once) and EACH ROOM (repeat), then GUARDRAILS. |
| "During each turn, the API bills for all context tokens, which encompasses both the conversation history and the system instruction provided by the user." | same page | The text is kept short. |
| "Instead of lengthy, multi-page prompts, consider using prompt chaining instead." | `documents/aistudio.google.com/docs/live-api/best-practices` | Extraction is a separate step (Fill scope), not part of this prompt. |
| "Live API expects user input before it responds. To have Live API initiate the conversation, include a prompt asking it to greet the user or begin the conversation." | same page | The start signal. |
| Affective dialogue and proactive audio: "Enabled by default in 3.8 Live." Proactive audio: "The model filters ambient noise and background speech, generating audio responses only when addressed by the user." | `.../models/guides/gemini-3-8-live` | Nothing in the text tries to turn either on or off. Other people's words are treated as reported statements. |
| "Thinking: purge prompt-level thinking hacks: To prevent dropped audio, remove all prompt text that attempts to enforce step-by-step thinking schemas or token limits." | `.../live-api/migrate-from-gemini-2-5-to-gemini-3-8-live` | The text asks for no step-by-step reasoning and sets no token limit. |
| The model "can switch between languages naturally during conversation. You can also restrict the languages it speaks in by specifying it in the system instructions." "If the model determines that a user is speaking a language other than the configured one, it can respond in that language. To reduce the chance of an unintended switch, provide a language hint by setting the `language_code` field and by stating the expected language in the system instruction." | `.../live-api/configure-language-voice`, `.../live-api/troubleshooting` | STYLE states US English and that only the technician's request switches it. It uses Google's word "unmistakably". |
| "The speech rate can accelerate during long turns ... Break extensive responses into chunks of fewer than 100 words". Prompts that ask the model to speak faster or slower "don't reliably change the synthesized speaking rate". | `.../live-api/troubleshooting`, `.../live-api/best-practices` | One or two short sentences a reply. The text does not ask for a speaking pace. |
| "Digit sequences can be repeated back inconsistently ... add a system instruction that directs the model to read the sequence back one digit at a time and to ask the user to repeat the sequence slowly when the digits aren't clear." | `.../live-api/troubleshooting` | **A deliberate difference.** The text asks the technician to repeat slowly, but tells the model not to read numbers back at all. The technician's own words are the record, and they check each number in Fill scope. |
| "Context compression will cause conversation history loss." Resuming with a session handle "resumes your session with its context intact on the new connection". | `.../live-api/best-practices`, `.../live-api/start-manage-session` | AFTER A RECONNECT tells the model that older parts may be gone and never to redo a room. |
| A context update's system instruction "Replaces the system instruction from the setup message for the rest of the session", and "updating them invalidates the prompt cache and can increase the latency of the next response. Update them only when needed." | `.../live-api/start-manage-session` | The text does not rely on job facts being refreshed during a walkthrough. |
| Custom vocabulary belongs in the transcription settings: "Listing custom vocabulary in the system instruction doesn't produce the same result." | `.../live-api/best-practices` | No trade word list in the text. |

Not stated in the pages read, so not relied on:

- whether the system instruction counts toward the compression trigger and target (8,000 and 4,000 tokens in the plan). A Firebase AI Logic page says "System instructions are not discarded and will always stay at the beginning of context window" (`documents/firebase.google.com/docs/ai-logic/live-api/sessions`); that is a different product surface. If the instruction counts, about 1,745 tokens of the 4,000 kept after each compression are the instruction. S7-16's compression check measures this.
- whether a resumed session takes a new system instruction.
- which call the relay should use to send the two signals. S7-12 chooses.

## Open points

1. **Language switching and the record.** The plan sets transcription to `en-US`. If the technician asks the assistant to switch to another language, the assistant will, but the transcript of what the technician then says may be poor. The plan lists Spanish walkthroughs as later work with their own evaluation.
2. **Owner wording review** of the four choices marked above: the address is not asked aloud; equipment counts are not asked; the room recap is one sentence; numbers are not read back.
