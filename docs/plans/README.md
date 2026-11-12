# Stage plans

Each stage of the rebuild has its plan here, and the plan's corrections live in the same file. A pull request for a stage is checked against its plan; if the work needs the plan to change, the pull request changes the plan file too, with a dated entry under "Corrections" saying what changed and why. A plan or correction that lives only outside the repository does not count for review.

- [S3: Sign-in and company separation](S3.md): 18 steps, owner decisions D1 to D12 (all decided), the owner-run cloud steps, risks, and corrections.
- [Pricing: owner-set prices for every estimate](pricing.md): steps S4-1 to S5b-4 (three database jobs), owner decisions Q1 to Q15 and M1 to M10 (all decided 2026-11-10), industry research, risks, and corrections.
- [S5: Core workflows](S5.md): S5a (12 steps and the rules-release job S5a-R) and S5b (12 steps), six database jobs, the exactly-once Submit handoff, owner decisions J1 to J10 (all decided 2026-11-11), the owner hands-on check after S5a-6, risks, and corrections.
- [S6: Offline and photos](S6.md): 9 steps (S6-1 to S6-9), no database job, the phone-side exactly-once queue and journal, the sync gate, Update ready and the minimum app version, owner decisions O1 to O8 (all decided 2026-11-12), the owner iPhone check, risks, and corrections. Six steps can start beside S5a-2 to S5a-7; S5a-6's author reads S6-2 before starting (section 10).
- [TC: Tier 1 catch-up (Technology Standard 2.5)](TC.md): 12 pull requests (TC-1 to TC-6, TC-8 to TC-13) and the offline acceptance tests inside S6-3 and S6-5 (TC-7), no database job, two owner Terraform applies, tracing, Error Reporting, App Check and sign-in reCAPTCHA in monitoring mode, the release manifest, alerts to the owner's phone, the synthetic monitor, owner decisions C1 to C13 (all decided 2026-11-12), the owner phone check, risks, and corrections. Most steps can start beside S4 to S6 (section 6).

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
