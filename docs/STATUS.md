# Status

One table of truth for each feature: **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Last built from `docs/roadmap.md` and `RELEASES.md` on 2026-10-28. `RELEASES.md` stays the only record of what is serving; recheck it, do not copy from here.

Legend: yes · no · partial · flag off. "no" under Phone-checked means no phone check is recorded in the repo; the roadmap says releases since Oct 19 were checked signed-out only.

This file replaces the roadmap's old "Where we are" narrative. Update this table in the same PR that changes a feature, and keep `docs/roadmap.md` for the plan.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Walkthrough-first flow, Live, offline notes | yes | yes | partial | Owner's staged field workflow passed Oct 14; physical iPhone checks still open |
| Company workspaces and roles | yes | yes (since Oct 15) | partial | One real invitation accepted Oct 14; Google-account invitee not yet checked |
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
| Price editor (company price books) | yes | flag off (`PRICE_BOOKS_ENABLED=false` as of the Oct 27 release) | no | Arbitrary workbook upload not built. A company other than ADR cannot set prices or estimate with the flag off, but keep it off until the PR 7 cutover (see the v2 editor row) |
| No default prices (a company without prices is blocked; ADR's rates are ADR's alone) | yes | on with the code | no | Owner notice and blocked audit not yet checked on a phone |
| Owner-defined pricing v2 data model | yes | flag off | no | v2 item/policy schema, starter catalog, working copy, v2 CSV/XLSX template |
| Owner-defined pricing v2 calculation | yes | drives the editor's sample totals only (audits and extras approvals still refuse a v2 table) | no | `backend/pricing_v2.py` |
| Owner-defined pricing v2 documents | yes (documents render only; the audit route's `pin` hand-off ships separately) | flag off | no | Price or range heading, summary lines, Xactimate column, owner-only quantity override note; rate-book documents unchanged; real-phone signing check open |
| Estimator item list (v2 company price tables) | yes (`public/scope-items.js`) | flag off, and a v2 table cannot price a job until the calculation is connected to audits | no | Check Scope lists the job's pinned table by group with unit prices and no totals; new drafts seed from the table's default quantities, including counts, once only: on the phone at New job, or on the server when office staff create the job, and the job records the table version in `seeded_from_version`; items no longer in the table are listed read-only; items limited to water categories no room on the job has are hidden, with entered quantities listed read-only; mold rooms keep the floor area input, and the wet floor input when an item prices their category from it; the table is cached on the phone for offline jobs; changing a walkthrough-filled quantity needs a short reason, which the server enforces at save and audit (until it is given, the change stays on the phone). Phone check outstanding |
| Price editor (v2 tables) | yes | flag off | no | Owner screen for items, estimate settings, saved working copy, publish and discard. Sample totals come from the v2 calculation, under the settings and before and after in the review. `PRICE_BOOKS_ENABLED` must stay off until jobs can be priced from a v2 table (PR 7 cutover): a company that publishes a v2 table cannot price a job before then (audit answers 409) |
| Automatic deploys after CI | yes (#171) | not recorded | n/a | Needs the owner's one-time setup in `docs/firebase-isolation.md#automatic-deploys`; runs are recorded in the Actions job summary, not `RELEASES.md` |
| Release version numbers (`YYYY.MM.DD-N`) and one-step rollback | yes | not yet released | no | Shown in `/api/health`, app footer and Account menu; automatic git tag + plain-word GitHub Release after deploy verification; `auto_deploy.py --rollback <version>` and workflow dispatch warn and stop when rolling back past a `_migrations` data migration or a rules or index change, unless confirmed |
| Vault backup | yes | yes | n/a | Verified Oct 27 |
| Landing page at `/` | yes | yes | no | |

## Not built (from VISION.md)
Company workbook upload; AI-suggested prices; crew calendar and reminders; per-visit reading dispatch; homeowner photo upload through the link; walkthrough recording stored with the signed agreement; recipient texting; anonymized cross-company price comparison; support role and owner-visible access log.

## Open items for the owner
1. Phone test 2 on a real phone (iPhone if possible) — roadmap Phase 0 item 1.
2. ADR company profile and logo — Phase 0 item 2.
3. Invitation check to a Google and an Outlook address — Phase 0 item 3.
4. Local SMTP timeout test on Windows — Phase 0 item 6.
5. Before onboarding a second company: add a separate test project (D-006) and switch email to Resend with a company sending domain (D-007).
6. Decide which flag-off features to switch on, one at a time, each with a phone check.

## Next steps for an agent
Work only the first item the owner approves, as one small PR. Do not turn on flags or release.
