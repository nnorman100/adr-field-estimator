# Security rules

Authoritative detail is in `AGENTS.md` section 5, `docs/firebase-isolation.md` and `docs/company-workspaces.md`. This is the short list an agent checks before every change.

## What we protect
Customer names, addresses, claim details and photos; signed agreements and evidence; company price data; each company's isolation from the others.

## Rules
1. **Isolation:** every business endpoint, evidence download and Live recheck verifies company membership and job access server-side.
2. **No direct database access from browsers.** `firestore.rules` stays deny-all (`tests/test_ci_config.py` checks it). Rules do not constrain server access; IAM does.
3. **Public sign-up stays disabled** in Firebase Auth. Re-enabling is never done without the owner's approval.
4. **Invitations** need explicit acceptance by a verified account with the matching email.
5. **Superadmin access** is audited and read-only for customer data; refusals return no data and write no entry.
6. **Signing:** audits and signatures bind to a saved revision and proposal hash; any edit invalidates them; success only after a durable server receipt.
7. **Links:** signing links are single-use, 7 days; document links are read-only, bound to one agreement and set, 30 days, revocable. Tokens are stored as digests.
8. **AI:** capped per user per day and per company per UTC month ([Company AI spending](ai-spending.md)). A model never supplies a price or removes required wording: on each new audit the server drops any sentence stating a price (a currency sign or word, or a money word such as cost or total with any number) from the AI summary, suggestions and testing advice; records already saved or signed stay as they are. Those notes stay with company staff; signing and document links omit them. Provider failure produces a retry error, never a signable fallback.
9. **Logs:** allowlisted fields only. Never prompts, transcripts, emails, tokens, addresses, coordinates or paths.
10. **Secrets:** Secret Manager only. Never in git, wiki or Notion. Do not commit service-account keys.
11. **Dependencies and code scanning:** hash-locked; CI runs `pip-audit` and `npm audit`. Ask before adding a dependency. CodeQL scans JavaScript on each push and pull request to `master`, and Python (the old app's code) on those that change legacy app, test or tooling files or have no diff base; both scan weekly. Code scanning is not enabled on this private repository, so results are in the job summary and the `codeql-results-<language>` SARIF artifact of each leg that scanned (Actions > CodeQL); a skipped Python leg has neither. Once code scanning is enabled, switch the workflow's `upload` to `always` and results appear under Security > Code scanning.
12. **Isolation of the project:** never touch peer sites, shared databases or other Firebase projects. Deploy only target-scoped.
13. **Photos and GPS:** location is evidence; never edited, never logged.
14. **Rebuilt app isolation (`web/`):** a company's data is held apart three times over: every route checks the caller's company and job access server-side, every company table in Postgres has forced row-level security for the runtime role, and the field database's rules (`web/firestore.rules`) check the sign-in tenant, an unexpired access record and the role. The company-isolation gate (`npm run test:isolation`, required on every PR; [Company isolation gate](access/isolation-gate.md)) calls every route as the other company's owner, estimator and office user, reads and writes every company table as the runtime role, and tries the field rules with two tenants. A new route needs its row in `web/tests/db/isolation-matrix.ts`, and a new company table is checked by the gate from the catalog. Link tokens are never a sign-in: they travel in the `X-Link-Token` header and the page address's fragment, and only their SHA-256 is stored. The checks the gate cannot make in CI (the real bucket, field database, Cloud Run and an iPhone) are the owner's [S5a real-service checks](runbook/s5a-real-service-checks.md), pending and not yet run; S5a is not closed until they are recorded.

## Needs the owner's approval
Anything touching auth settings, IAM, secret bindings, the proposal's privacy wording, `firestore.rules`, `.github/workflows`, test fixtures, or production data.

## If something leaks
Contain (revoke the link, disable the member, rotate the key), then record what happened in `RELEASES.md` or a postmortem. See `docs/runbook/incidents.md`.
