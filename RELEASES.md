# Release log

This is the single record of what is deployed in `alert-disaster-field-2026`. Other documents link here
instead of repeating production state. Append one row per deploy or traffic change, oldest first, and
never rewrite earlier rows; add a correcting row instead.

- **Date (UTC)**: day of the deploy or traffic change.
- **Backend revision (tag)**: Cloud Run revision suffix of `alert-disaster-field-estimator` and its URL tag;
  `—` for a Hosting-only row.
- **Frontend marker**: asset marker of the Hosting shell, with the Hosting version and release when known;
  `—` for a backend-only row. Stamped shells use the source commit as the marker.
- **Source commit**: the full commit the release was built from, as stamped by the deploy scripts.
  `<commit>-dirty` marks a release built with uncommitted changes. `unknown` means it was not recorded;
  never fill it in by inference.
- **Traffic**: `0% (staged)`, `100%`, `100% (promoted)` or `rolled back` for the backend; `live` for Hosting.

The serving backend is the newest row with 100% traffic that has not been rolled back; the serving
frontend is the newest `live` row. Recheck both read-only before a cutover and keep them as the rollback
pair. Compare them with `/api/health` (`source_commit`) and `node scripts/verify_hosting.js`.

## Recording a release

1. `python scripts/deploy_backend.py ... --yes` stamps the image and its `source-commit` label, then
   prints a row for the staged revision. Fill in the revision suffix and append it.
2. After `gcloud run services update-traffic ... --to-tags=<tag>=100`, append the same revision with
   `100% (promoted)`.
3. `python scripts/stamp_hosting.py` stamps the Hosting shell and prints a row. Deploy only
   `hosting:alert-disaster`, fill in the Hosting version, append the row, then run
   `python scripts/stamp_hosting.py --reset`.

The seed rows below were reconstructed from the narrative records in `docs/` and the pull request
named in their notes; none of those releases was stamped. Where a deploy itself was not recorded, the
date is the read-only check that observed it.

| Date (UTC) | Backend revision (tag) | Frontend marker | Source commit | Traffic | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-10-07 | `00006-yer` (tag `live-reliable`) | — | `unknown` | 100% | Live reliability cutover; workspaces off. |
| 2026-10-07 | — | `live-reliable-20261007-1` (Hosting version `0350de7b1566a1b5`, release `1791398669068000`) | `unknown` | live | Paired with `00006-yer`. |
| 2026-10-07 | `00008-jom` (tag `workspaces`) | — | `unknown` | 0% (staged) | Workspaces on; still the workspace staging tag. |
| 2026-10-10 | `00009-ved` (tag `legacy-fixes`) | — | `unknown` | 100% (promoted) | Workspaces off. |
| 2026-10-11 | `00011-geb` (tag `ops-fixes`) | — | `e7f70e783ba48f1204e20e9dfb34e0eb0e248bba` | 100% (promoted) | Workspaces off; first non-root image. |
| 2026-10-12 | `00013-hup` (tag `harden-fixes`) | — | `unknown` | 100% | Workspaces off. Deploy not recorded; observed by the October 11 (Pacific) read-only check. |
| 2026-10-12 | — | `hardening-20261011-1` (Hosting version `05af952eff367594`, release `1791758723456000`) | `unknown` | live | Deploy not recorded; observed by the same check. No later Hosting release is recorded. |
| 2026-10-12 | `00015-kem` (tag `body-limits`) | — | `unknown` | 100% (promoted) | Workspaces off. The records conflict: `docs/review-repairs.md` named master `9b714e2`, while nnorman100/adr-field-estimator#19 states the source is not recorded and attributes `9b714e2` to `00017-kap`. |
| 2026-10-12 | `00017-kap` (tag `backend-20261012`) | — | `9b714e283bdbd641333d77e644f68e9d56ed477d` | 0% (staged) | Workspaces off. Recorded in nnorman100/adr-field-estimator#19 (open when this log was created); public checks only. |
