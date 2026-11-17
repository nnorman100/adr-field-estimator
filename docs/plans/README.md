# Stage plans

Each stage of the rebuild has its plan here, and the plan's corrections live in the same file. A pull request for a stage is checked against its plan; if the work needs the plan to change, the pull request changes the plan file too, with a dated entry under "Corrections" saying what changed and why. The S5, S6, S8 and billing plans keep each step and each dated correction in its own file under [`S5/`](S5/), [`S6/`](S6/), [`S8/`](S8/) and [`BILLING/`](BILLING/), linked in order from the plan file: a pull request changes its own step's file and adds its correction as a new file with one line in that list. A plan or correction that lives only outside the repository does not count for review.

- [S3: Sign-in and company separation](S3.md): 18 steps, owner decisions D1 to D12 (all decided), the owner-run cloud steps, risks, and corrections.
- [Pricing: owner-set prices for every estimate](pricing.md): steps S4-1 to S5b-4 (S4-4d to S4-4f added 2026-11-13; three database jobs), owner decisions Q1 to Q15 and M1 to M10 (all decided 2026-11-10), industry research, risks, and corrections.
- [S5: Core workflows](S5.md): S5a (16 steps since the 2026-11-13 correction, and the rules-release job S5a-R) and S5b (11 steps), seven database jobs, the exactly-once Submit handoff, owner decisions J1 to J10 (all decided 2026-11-11), the owner hands-on check after S5a-6, risks, and corrections.
- [S6: Offline and photos](S6.md): 9 steps (S6-1 to S6-9), no database job, the phone-side exactly-once queue and journal, the sync gate, Update ready and the minimum app version, owner decisions O1 to O8 (all decided 2026-11-12), the owner iPhone check, risks, and corrections. Six steps can start beside S5a-2 to S5a-7; S5a-6's author reads S6-2 before starting (section 10).
- [TC: Tier 1 catch-up (Technology Standard 2.5)](TC.md): 12 pull requests (TC-1 to TC-6, TC-8 to TC-13) and the offline acceptance tests inside S6-3 and S6-5 (TC-7), no database job, two owner Terraform applies, tracing, Error Reporting, App Check and sign-in reCAPTCHA in monitoring mode, the release manifest, alerts to the owner's phone, the synthetic monitor, owner decisions C1 to C13 (all decided 2026-11-12), the owner phone check, risks, and corrections. Most steps can start beside S4 to S6 (section 6).
- [S7: AI and live voice](S7.md): 19 pull requests (S7-0 to S7-17 and the relay release S7-R), one database job (S7-3), the Live relay (thin, no database access), the AI boundary and per-company budget, five text AI features, Model Armor screening, per-person voice choice, evaluations with written pass marks, owner decisions V1 to V13 (all decided 2026-11-12), ten owner cloud steps, the owner iPhone check, risks, and corrections. Wave A (S7-0, S7-1, S7-2, S7-5, S7-11, S7-15) can start beside S5a and S6 (section 6).
- [S8: Go-live](S8.md): 25 steps (S8-1 to S8-24 and S8-13b, 28 pull requests), no database job, the live project `dryscope-live`, the domain and front door, the release path to live, restore and load drills, the old app's deletion, switch-over day for the owner's own company, owner decisions L1 to L16 (decided 2026-11-17; only the domain name is open), the owner cloud steps, risks, and corrections. The [lawyer checklist](S8/lawyer-checklist.md) is the list for the owner's lawyer.
- [Billing (SB): Stripe billing and offboarding](BILLING.md): 28 steps (SB-0 to SB-26 and SB-12b), four database jobs (SB-1, SB-11, SB-14, SB-21), a Stripe subscription per company (company fee, a fee per active user, extra voice minutes and AI credits above a pooled allowance), the owner's spending cap, the failed-payment path to read-only enforced at five places, the company export, cancellation and closure, the sandbox proof (SB-0), owner decisions B1 to B23 (all decided 2026-11-17), the owner Stripe steps, the phone check, risks, and corrections. Its own stage after S8 go-live; it can run beside S9, and its first steps (SB-1, SB-2, SB-4) need no Stripe account. Live switch-on (SB-26) needs S8 complete.

The owner-only cloud steps for every stage are one ordered checklist in the runbook: [Owner cloud steps, in order](../runbook/owner-cloud-steps.md).

## Build completion plan (owner-approved 2026-11-10)

The owner confirmed the plan on 2026-11-10 ("I agree with the updated plan"):

- Stages S1 to S10 as planned; S11 comes after launch.
- Each stage starts with a planning scout; the owner answers its decisions once, in one batch.
- Stages overlap where their plans allow: one database-changing job at a time, about five workers.
- No fixed date; a forecast is given after each stage.
- The first company is the owner's own; the domain is set at S8; no data is brought over from the old app.
- No stage gates, except one hands-on check of about 15 minutes by the owner at the first usable S5 job screens (after S5a-6).
- An early live-voice feasibility test (a scout, test only, outside the main build) runs when a worker slot frees.
