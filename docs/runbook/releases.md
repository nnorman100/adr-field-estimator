# Releases and rollback

## Release

Follow the recipe at the top of `RELEASES.md` and `docs/SHIP-CHECKLIST.md`. A hand release is a production step the owner runs (`HANDOFF.md`, "Rules that decide what you may do"). Full commands: `docs/firebase-isolation.md`. Once the owner has set it up, `.github/workflows/deploy.yml` also releases master commits after CI, assigns the next `YYYY.MM.DD-N` version tag and GitHub Release after verification succeeds, and rolls back on failure (`docs/firebase-isolation.md#automatic-deploys`); it stops and leaves the commit for a manual release when rules or indexes changed, or when the repository baseline would turn off a feature now serving.

## Roll back

For a one-step rollback to an earlier `YYYY.MM.DD-N` version, run `python3 scripts/auto_deploy.py --rollback <YYYY.MM.DD-N>` or trigger **Deploy** in GitHub Actions with the `version` input (it needs `AUTO_DEPLOY_ENABLED` set to `true`; while paused, use the command). It redeploys that version's backend and Hosting and verifies health, but stops first when the target is older than a data migration, rules or indexes changed since it, or the repository baseline would turn off a feature now serving; `docs/firebase-isolation.md#rollback` has the confirmations and what stays unchanged.

**After a rollback, pause automatic deploys (`AUTO_DEPLOY_ENABLED`) or revert the bad change before the next merge. Otherwise the next release brings it back.**

For an immediate traffic-only restore, point Cloud Run traffic to the recorded rollback revision (explicit project and region), clone the recorded rollback Hosting version to the live channel, read back both, and append rows to `RELEASES.md`. Do not retry a failed deploy immediately.

### Turning company prices off

Change `DEFAULT_PRICE_BOOKS` back to `off` in a reviewed PR, then release that commit with `--confirm-baseline` (`docs/firebase-isolation.md#turning-a-feature-on-or-off`). That hides the price editor, the **Switch to v2** card and the estimator's item list, and the app shows the v1 form, including for a draft a phone already holds. It does not touch the data or the calculation, so nothing already priced moves:

- A job pinned to a company table keeps pricing from it, because the engine is not behind the flag. Documents print as before.
- A job started while the flag is off pins at its first audit, to the company's current table if it has one. Quantities only the item list collects (owner-added items) keep their saved values and cannot be edited until the flag is back on.
- A company that switched stays switched: no release can return it to its rate book. To change its prices the flag must be on.
- Unpublished working copies stay saved. Turning the flag on again brings them back.
