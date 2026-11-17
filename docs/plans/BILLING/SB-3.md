# Billing plan, step SB-3

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-3 Terraform: the webhook secret and the billing schedule (S, High: secrets, IAM).** Slice: infrastructure. Owner applies (test, then live).
- Infra: a second secret, `stripe-webhook-secret`, readable by the web app only, in the naming module's table, the settings list and the plan check ("one secret per purpose"). A second Cloud Scheduler job per environment calling `POST /api/internal/billing-sync` with its own audience, every 5 minutes. Both secrets follow the rotation rule the Standard sets for stored keys. One log-based alert policy for the billing alert codes, sent to the owner's phone channel (the TC-11 pattern).
- Owner: add each secret's value by hand after the Stripe set-up (section 7).
- Tests: mocked plans; the plan check accepts exactly these additions; a scheduler job that names another environment's address is refused; the web app starts without the secrets set (billing off).
- Needs: S8-13 (the public address) for the job's address. On the test copy it can land as soon as S8's front door is applied there.
