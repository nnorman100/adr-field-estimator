# Status

One table of truth for each feature: **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Last built from `docs/roadmap.md` and `RELEASES.md` on 2026-10-28. `RELEASES.md` stays the only record of what is serving; recheck it, do not copy from here.

Legend: yes · no · flag off · unknown

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Walkthrough-first flow, Live, offline notes | yes | yes | unknown | Physical iPhone checks still open |
| Company workspaces and roles | yes | yes (since Oct 15) | unknown | Google-account invitee not yet checked |
| Invitation clearing (owners) | yes | yes | no | #167 |
| QR tags, drying log, claim details, sizing, shot list | yes | yes | no | |
| Jobs list tabs and search | yes | yes | no | #130 |
| GPS stamp on photos | yes | yes | no | |
| Address autocomplete and map | yes | yes | no | Maps key set; $25 budget alert |
| Copy signed job to draft | yes | yes | no | |
| Document delivery (homeowner, adjuster, crew lead, resend) | yes | yes | no | Gmail SMTP; limit near 500/day |
| Readiness check | yes | yes (`AI_FEATURES=readiness`) | no | |
| Voice-note signing gate | yes | yes | no | #148, fix #158 |
| Drying watch | yes | flag off | no | |
| Priced extras | yes | flag off | no | |
| Job summaries and AI usage | yes | flag off | no | |
| Price editor (company price books) | yes | `PRICE_BOOKS_ENABLED` — [confirm current value in RELEASES.md] | no | Arbitrary workbook upload not built |
| Vault backup | yes | yes | n/a | Verified Oct 27 |
| Landing page at `/` | yes | yes | no | |

## Not built (from VISION.md)
Company workbook upload; AI-suggested prices; crew calendar and reminders; per-visit reading dispatch; homeowner photo upload through the link; walkthrough recording stored with the signed agreement; recipient texting; anonymized cross-company price comparison; support role and owner-visible access log; automatic deploys after CI.

## Open items for the owner
1. Phone test 2 on a real phone (iPhone if possible) — roadmap Phase 0 item 1.
2. ADR company profile and logo — Phase 0 item 2.
3. Invitation check to a Google and an Outlook address — Phase 0 item 3.
4. Local SMTP timeout test on Windows — Phase 0 item 6.
5. Decide D-006, D-007, D-008 in `docs/DECISIONS.md`.
6. Decide which flag-off features to switch on, one at a time, each with a phone check.

## Next steps for an agent
Work only the first item the owner approves, as one small PR. Do not turn on flags or release.
