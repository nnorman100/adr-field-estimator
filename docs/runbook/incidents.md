# Common problems, incidents and contacts

## Common problems

| Symptom                                       | First checks                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in fails with `auth/unauthorized-domain` | Host has a trailing dot or wrong domain; use the canonical host                                                                                     |
| Everyone gets 403 "Set your own password…"    | Account has `password_change_required`; user must set a password                                                                                    |
| Documents/emails not delivered                | Delivery status on the job; company delivery switch; `INVITATION_TRANSPORT` (production: `smtp`) and its secret; daily email count (warning at 400) |
| Address suggestions blank                     | Maps key/secret, per-user daily cap, or offline                                                                                                     |
| Phone shows an old screen                     | Service worker cache; use **Save & update**; check `sw.js` version bump                                                                             |
| Post-deploy verifier fails on CSP             | Compare with the Oct 26 Google telemetry fix in `RELEASES.md`                                                                                       |
| AI features missing                           | `AI_FEATURES` value on the serving revision                                                                                                         |

## Incidents

1. Contain: revoke the signing/document link, disable the member, rotate the key, or roll back.
2. Look at Cloud Logging (allowlisted fields only) and `_admin_events`.
3. Fix on a branch with a failing test first.
4. Tell affected companies if their data was exposed [owner/legal decides wording].
5. Record it in `RELEASES.md`.

## Contacts

Owner: [Nathanael — phone]. Billing alerts: [email]. Maps budget alert: $25.
