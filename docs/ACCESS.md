# Access matrix

Summary of who may do what. **Source of truth in code:** the `CAPABILITIES` dictionary in `backend/workspaces.py`, enforced by `job_access` and the route checks. Some routes test the caller's _role_ (owner) instead of a capability key; those are listed under "Checks by role" below. `can()` in `public/workspaces.js` only hides buttons. Prose detail: `docs/company-workspaces.md`. If this file and the code disagree, the code wins; fix this file in the same PR. The rebuilt app's TypeScript port of this table is `web/src/lib/access/`; `web/tests/unit/access.test.ts` reads the table in [Company roles](access/roles.md) and fails when the port differs from it, so change both in the same PR.

The sections of this document, one file per area (each keeps its original headings):

- [Principles](access/principles.md): Principles.
- [Company roles](access/roles.md): Company roles: the capability table `web/tests/unit/access.test.ts` reads.
- [Checks by role and feature switches](access/role-checks-and-switches.md): Checks by role (no capability key); Feature switches that gate routes.
- [Superadmin](access/superadmin.md): Superadmin and the platform operator; Operator-only actions (rebuilt app), the records check (S8-3).
- [Prices API](access/prices.md): Prices API (S4-6) and the published item list for Check Scope (S6-8).
- [Company profile API](access/company-profile.md): Company profile API (rebuilt app, S5a-4 and S5a-4b).
- [AI usage and ceilings](access/ai-usage.md): AI usage and ceilings (rebuilt app, S7-4); AI summary draft (rebuilt app, S7-6).
- [Non-role access](access/non-role-access.md): Non-role access (anonymous, links, server-only).
- [Jobs routes](access/jobs.md): Jobs routes (rebuilt app, S5a-3); Office jobs routes (rebuilt app, S5b-1): coordination, assignment, the field owner and its move; Field database job locators (S6 follow-up); Archive, restore and copy (rebuilt app, S5b-2).
- [Photo routes](access/photos.md): Photo routes (rebuilt app, S5a-5).
- [Submit and Back to editing](access/submit.md): Submit and Back to editing (rebuilt app, S5a-8).
- [Estimate and review](access/estimate.md): Estimate and review (rebuilt app, S5a-9); Reprice this draft (S5b-6).
- [Proposals and approvals](access/approvals.md): proposals and approvals on a job (rebuilt app, S5b-8), key `additions_approve`, switch `priced_extras`.
- [Signing on the phone](access/signing.md): Signing on the phone (rebuilt app, S5a-11).
- [Check Scope lists](access/scope-lists.md): Check Scope lists (rebuilt app, S5a-10).
- [Drying log](access/drying.md): Drying log (rebuilt app, S5b-10): the readings and room-list routes, the drying watch and the job close.
- [Ready to review?](access/readiness.md): Ready to review? (rebuilt app, S5b-11): the advisory gaps before Finish.
- [Signing links and document links](access/signing-links.md): Signing links and document links (rebuilt app, S5a-11b), including "Homeowner signing link".
- [Company isolation gate](access/isolation-gate.md): Company isolation gate.
- [Rules for adding a feature](access/adding-a-feature.md): Rules for adding a feature.
