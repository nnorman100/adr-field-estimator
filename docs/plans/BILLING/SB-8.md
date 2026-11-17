# Billing plan, step SB-8

Part of [the billing plan](../BILLING.md), section 5, "Ordered steps".

**SB-8 The owner's Billing screen (M, High: money screens).** Slice: screens.
- UI: Company settings, "Billing". States: billed by invoice (`manual`); set up billing; finishing set-up; active with the next invoice date; payment failed (with "Update card"); read-only (with "Pay now" and "Export"); subscription ended. Buttons go to Stripe's pages by a normal page change, never a form post and never a frame. A return page that only reloads the state. The payment-failed notice appears on every screen for the owner only.
- FE: no Stripe script; nothing stored on the device; needs a connection and says so.
- Tests: Playwright on Chromium and WebKit at 390 px with axe, against the stand-in: each state renders; a tap on "Set up billing" leaves for the address the server gave; an estimator never sees the screen or the notice; the return page ignores its query string.
- Needs: SB-7. Uses the Modern Web Guidance skill.
