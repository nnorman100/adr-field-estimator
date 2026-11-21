# Status: TC Technology Standard Tier 1 catch-up

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

Plan: `docs/plans/TC.md` (#343). Nothing here is deployed to production: no live project exists yet (D-018). Terraform is applied by the owner.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| Structured logger and Error Reporting for server errors | yes (#352) | no (rebuild not live) | n/a | Scrubs emails, tokens and coordinates |
| Request tracing into Cloud Trace (TC-3) | yes (#358) | no (rebuild not live) | n/a | |
| Accessibility check on every page (TC-4) | yes (#353, #355) | n/a | n/a | axe in the browser tests |
| App Check in monitoring mode (TC-5) | yes (#391, #404) | no (rebuild not live) | no | Route list generated from the route files (#404) |
| Test release record: version, tag, GitHub Release and manifest (TC-8) | yes (#367) | n/a | n/a | |
| Data-root bundle: APIs, IAM, scanning, App Check, backup window (TC-9) | yes (#383) | no (owner applies) | n/a | Three grants without IAM conditions (D-031) |
| Synthetic monitor probe code (TC-10) | yes (#378) | no | n/a | |
| Browser and phone errors sent to a server route | yes (#370, #385) | no (rebuild not live) | n/a | Per-caller cap of 20 reports a minute (#385) |
| Fixed browser security headers (D-034) | yes (#385) | no (rebuild not live) | n/a | |
| Full script/connect content security policy, report-only (D-034) | yes (#403) | no (rebuild not live) | no | Not enforced; `docs/security-csp.md`. Enforcing needs the owner's phone check on the test copy and a separate owner approval |
