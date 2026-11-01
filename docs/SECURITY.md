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
8. **AI:** capped per user per day. A model never supplies a price or removes required wording. Provider failure produces a retry error, never a signable fallback.
9. **Logs:** allowlisted fields only. Never prompts, transcripts, emails, tokens, addresses, coordinates or paths.
10. **Secrets:** Secret Manager only. Never in git, wiki or Notion. Do not commit service-account keys.
11. **Dependencies:** hash-locked; CI runs `pip-audit` and `npm audit`. Ask before adding a dependency.
12. **Isolation of the project:** never touch peer sites, shared databases or other Firebase projects. Deploy only target-scoped.
13. **Photos and GPS:** location is evidence; never edited, never logged.

## Needs the owner's approval
Anything touching auth settings, IAM, secret bindings, the proposal's privacy wording, `firestore.rules`, `.github/workflows`, test fixtures, or production data.

## If something leaks
Contain (revoke the link, disable the member, rotate the key), then record what happened in `RELEASES.md` or a postmortem. See `docs/RUNBOOK.md`.
