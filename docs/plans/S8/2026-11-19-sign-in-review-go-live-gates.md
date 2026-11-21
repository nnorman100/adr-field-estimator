# S8 plan, correction, 2026-11-19: sign-in review go-live gates

Part of [the S8 plan](../S8.md), section 15.

The sign-in and company-separation security review (`docs/DECISIONS.md` D-030; its finding F4 and section 5) asked for three go-live gates: the live scheduler has run once, a test account is refused on a live tenant's users, and a written list of test and live tenant ids exists. The owner approved them on 2026-11-18.

Section 7 of [the S8 plan](../S8.md) now names them as **G6a**, **G6b** and **G6c**, with how each is proven and who proves it. They are the three parts of gate **G6** in [S8-24](S8-24.md), which is unchanged. No step file other than this one changes, and no code, Terraform or status file changes. The gates are owner-proven; no agent creates the tenant list or runs a check against test or live.
