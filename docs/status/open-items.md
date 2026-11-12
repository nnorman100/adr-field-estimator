# Status: not built, open items and next steps

Part of [Status](../STATUS.md).

## Not built (from VISION.md)
Arbitrary company workbook upload (ADR's workbook is never used for another company; the owner-filled template is the price editor row above); AI-suggested prices (not wanted for now); crew calendar and reminders; per-visit reading dispatch; homeowner photo upload through the link; walkthrough recording stored with the signed agreement; recipient texting; anonymized cross-company price comparison; support role and owner-visible access log.

## Open items for the owner
1. Phone test 2 on a real phone (iPhone if possible) — roadmap Phase 0 item 1; script in `docs/phone-acceptance.md`.
2. ADR company profile and logo — Phase 0 item 2.
3. Invitation check to a Google and an Outlook address — Phase 0 item 3.
4. Local SMTP timeout test on Windows — Phase 0 item 6.
5. Before onboarding a second company: for the current app, add isolated test resources (D-006; the rebuild's `test` environment is in project `dryscope`, see `docs/DECISIONS.md`) and switch email to Resend with a company sending domain (D-007).
6. Decide which flag-off features to switch on, one at a time, each as one reviewed PR with a phone check (`docs/firebase-isolation.md#turning-a-feature-on-or-off`).

## Next steps for an agent
Work only the first item the owner approves, as one small PR. Do not turn on flags or run a hand release; the owner-only exceptions are listed in `HANDOFF.md` ("Rules that decide what you may do").
