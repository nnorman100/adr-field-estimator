# Status: S7 AI and live voice

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

Nothing here is deployed to production: no live project exists yet (D-018). No AI feature reaches a user yet.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| AI boundary library (S7-1) | yes (#354, #362) | no (rebuild not live) | n/a | Every REST model call goes through one ordered path; its log line uses the shared logger (#362) |
| AI infrastructure bundle: Model Armor, IAM, Cloud Run settings (S7-2) | yes (#356, #363, #398) | no (owner applies the Terraform) | n/a | |
| AI and Live tables (S7-3) | yes (#361) | no (rebuild not live) | n/a | Migration `0012_ai_live_tables` |
| AI budget ledger, usage view and AI switches (S7-4) | yes (#377) | no (rebuild not live) | no | |
| AI evaluation harness and manual eval workflow (S7-5) | yes (#369) | n/a | n/a | Synthetic datasets only |
| Live calibration probe (S7-0) | yes (#364) | n/a | n/a | Owner-run `npm run probe:live` |
| Live walkthrough instructions rewritten for the rebuilt app | yes (#421) | no (rebuild not live) | no | Waits on the owner's wording review |
| `@google/genai` 3.3.0 | yes (#417) | n/a | n/a | |
