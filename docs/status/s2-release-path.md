# Status: S2 test release path

Part of [Status](../STATUS.md): one table of truth per feature. **Built** (merged), **On** (enabled in production), **Phone-checked** (observed on a real phone by the owner). Legend: yes · no · partial · flag off.

| Feature | Built | On | Phone-checked | Notes |
|---|---|---|---|---|
| S2 test release path (`.github/workflows/web-release.yml`, `web/scripts/build-image.sh`) | yes | no (production: test only, no live release). The test release path is active: GitHub Releases `2026.11.15-7 (test)` and earlier were published as pre-releases (`docs/plans/S8.md`, section 2, evidence of 2026-11-16). Before that the workflow skipped until the owner's setup in `docs/runbook/test-release.md` | n/a | After Web app passes on `master`: image assembled without Docker (crane) and pushed by digest, migrations in the Cloud Run job `dryscope-migrate-test` (same image by digest, as the migrator, inside Google; the runner never connects to Cloud SQL), 0% tagged revision of `dryscope-api-test`, smoke check (health reports the commit; signed-out business routes refuse), then 100% traffic, rolling back if anything after the move fails. Test only; no live release. `live-relay-placeholder/` is a 503 stand-in image for the app root until S7 |
