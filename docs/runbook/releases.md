# Releases and rollback

## Release

The old app is retired. Any manual legacy release is an owner-only operation. The retained
procedure is in [RELEASES.md](../../RELEASES.md), [the checklist](../SHIP-CHECKLIST.md) and
[the deployment guide](../firebase-isolation.md#deployment). For the rebuilt app, see
[the release workflow](test-release.md).

## Roll back

The owner can run `python3 scripts/auto_deploy.py --rollback <YYYY.MM.DD-N>`. It redeploys that
version's backend and Hosting and checks health. It stops before staging if the target predates a
data migration or rules or index change, or if the baseline would turn off a serving feature. The
[rollback guide](../firebase-isolation.md#rollback) lists the explicit confirmations. Fix or revert
the bad change before the next manual release.

For an immediate traffic-only restore, point Cloud Run traffic to the recorded rollback revision (explicit project and region), clone the recorded rollback Hosting version to the live channel, read back both, and append rows to `RELEASES.md`. Do not retry a failed deploy immediately.

### Turning company prices off

Change `DEFAULT_PRICE_BOOKS` back to `off` in a reviewed PR, then release that commit with `--confirm-baseline` (`docs/firebase-isolation.md#turning-a-feature-on-or-off`). That hides the price editor, the **Switch to v2** card and the estimator's item list, and the app shows the v1 form, including for a draft a phone already holds. It does not touch the data or the calculation, so nothing already priced moves:

- A job pinned to a company table keeps pricing from it, because the engine is not behind the flag. Documents print as before.
- A job started while the flag is off pins at its first audit, to the company's current table if it has one. Quantities only the item list collects (owner-added items) keep their saved values and cannot be edited until the flag is back on.
- A company that switched stays switched: no release can return it to its rate book. To change its prices the flag must be on.
- Unpublished working copies stay saved. Turning the flag on again brings them back.
