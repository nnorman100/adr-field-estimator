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
pair. Compare them with `/api/health` (`source_commit`) and `node scripts/verify_hosting.js`. The
service-level `source-commit` label follows the latest staged revision, not traffic; read the label of
the revision that serves traffic instead.

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
| 2026-10-13 | `00018-qel` (tag `release-20261012`) | — | `1711d0194583b730a109b69c69f7b780d8674f3e` | 0% (staged) | Workspaces off. Superseded before promotion by `00019-waf`; never served traffic. |
| 2026-10-13 | `00019-waf` (tag `release-20261013`) | — | `dd7fe95e7b80fba51777a5eac4c8a50cca55be7c` | 0% (staged) | Workspaces off. Staged browser check passed, including Live. |
| 2026-10-13 | `00019-waf` (tag `release-20261013`) | — | `dd7fe95e7b80fba51777a5eac4c8a50cca55be7c` | 100% (promoted) | Workspaces off. Rollback target `00015-kem`. |
| 2026-10-13 | — | `dd7fe95e7b80fba51777a5eac4c8a50cca55be7c` (Hosting version `30a321a0863e67c4`, release `1791896953376000`) | `dd7fe95e7b80fba51777a5eac4c8a50cca55be7c` | live | verify_hosting.js: shell and backend same commit; production browser check passed. Rollback target release `1791758723456000`. |
| 2026-10-13 | `00021-bac` (tag `rel-20261013b`) | — | `95dd32807ee810357249be3af222813e4cb7debf` | 0% (staged) | Workspaces off. Staged check failed: scope-suggestion calls hit the 55 s deadline (model thinking runaway, pre-existing). Never served traffic. |
| 2026-10-13 | `00022-zew` (tag `rel-20261013c`) | — | `35066a537a9f731ae9c85c2941426b5aebe1aeba` | 0% (staged) | Workspaces off. Thinking budget cap (#47) did not hold; staged check failed on scope timeouts. Never served traffic. |
| 2026-10-13 | `00023-toj` (tag `rel-20261013d`) | — | `fd514aeb311d2c9fa345b1012780fc1553affe80` | 0% (staged) | Workspaces off. Scope uses low thinking (#48); staged browser check passed. |
| 2026-10-13 | `00023-toj` (tag `rel-20261013d`) | — | `fd514aeb311d2c9fa345b1012780fc1553affe80` | 100% (promoted) | Workspaces off. Rollback target `00019-waf`. |
| 2026-10-13 | — | `fd514aeb311d2c9fa345b1012780fc1553affe80` (Hosting version `52279305401438fa`, release `1791925600486000`) | `fd514aeb311d2c9fa345b1012780fc1553affe80` | live | verify_hosting.js: shell and backend same commit; its iPhone-viewport capture-button assertion failed (also failed on the morning release). Production browser check passed. Rollback target release `1791896953376000`. |
| 2026-10-14 | `00025-sux` (tag `workspaces`) | — | `3f8f076ce355f99c54e5a06ea11482eac694ae21` | 0% (staged) | Workspaces on; the `workspaces` tag moved here from `00008-jom`. Tagged health reported this commit and anonymous `/api/session`, `/api/access` and `/api/admin/companies` returned 401; synthetic database check passed 12/12. Runtime account holds only Firebase Authentication viewer, so invitation account provisioning would fail. The owner job list returned 404 on four 2026-10-07 migration sidecars whose drafts no longer exist; after their approved deletion the same day, the owner's `/api/access`, `/api/inspections` and `/api/authorizations` on this tag returned 200. No four-role or invitation check yet. |
| 2026-10-14 | `00026-seh` (tag `workspaces`) | — | `2dbfd6c9687d13951e3644ed1089c2fccdec3184` | 0% (staged) | Workspaces on; built by `deploy_backend.py` from master with the Gmail SMTP transport (#54). No invitation transport configured; superseded minutes later by `00027-rus`. Never served traffic. |
| 2026-10-14 | `00027-rus` (tag `workspaces`) | — | `2dbfd6c9687d13951e3644ed1089c2fccdec3184` | 0% (staged) | Workspaces on. Same image as `00026-seh`, created by `gcloud run services update --no-traffic --tag=workspaces` adding `INVITATION_TRANSPORT=smtp`, `INVITATION_SMTP_USERNAME`, `INVITATION_FROM` and secret `ADRfieldappinvitations` as `INVITATION_SMTP_PASSWORD`; `adr-runtime` has secret accessor on that secret only. Tagged health reported this commit; anonymous workspace endpoints returned 401. No invitation sent yet. |
| 2026-10-14 | `00028-gur` (tag `workspaces`) | — | `3c3546b401f123887abbdb97c51c12f8cedb1258` | 0% (staged) | Workspaces on; built by `deploy_backend.py` from master with superadmin support access (#55). Inherited the Gmail SMTP settings and secret `ADRfieldappinvitations` from `00027-rus`'s template; tagged health reported this commit and anonymous workspace endpoints returned 401. |
| 2026-10-14 | `00029-kux` (tag `rel-20261014`) | — | `3c3546b401f123887abbdb97c51c12f8cedb1258` | 0% (staged) | Workspaces off. Staged browser check passed on the first attempt, including Live and the homeowner signing link (owner-only mode). |
| 2026-10-14 | `00029-kux` (tag `rel-20261014`) | — | `3c3546b401f123887abbdb97c51c12f8cedb1258` | 100% (promoted) | Workspaces off. Inherited the workspace revision's invitation settings (`INVITATION_TRANSPORT=smtp`, sender, SMTP username and password secret); they stay unused while workspaces are off. Rollback target `00023-toj`. |
| 2026-10-14 | — | `3c3546b401f123887abbdb97c51c12f8cedb1258` (Hosting version `268707cc3c5b564a`, release `1792007460912000`) | `3c3546b401f123887abbdb97c51c12f8cedb1258` | live | verify_hosting.js passed: shell and backend same commit. Production browser check passed. Rollback target release `1791925600486000`. |
| 2026-10-14 | `00031-xed` (tag `workspaces`) | — | `aafbd1e2050470b004f825290fe71edc4829674f` | 0% (staged) | Workspaces on; built by `deploy_backend.py` from master with the phone layout fix (#56), inheriting the Gmail invitation settings and secret. Tagged health reported this commit; anonymous workspace endpoints returned 401. Phone layout check through the local shell with real owner and estimator sessions: Start walkthrough on the first screen at 390×844 and 320×844 for both roles. |
| 2026-10-15 | `00031-xed` (tag `workspaces`) | — | `aafbd1e2050470b004f825290fe71edc4829674f` | 100% (promoted) | Workspaces on in production. Before promotion `migrate_workspaces.py --apply` created the two job sidecars for the existing drafts (create 2, already present 3, unmapped 0, sources preserved); the re-run after promotion created none. Hosting `/api/health` reported this commit, anonymous workspace endpoints returned 401, and the owner session showed owner plus superadmin with both drafts listed. Hosting still serves the `3c3546b` shell. Rollback target `00029-kux` (tag `rel-20261014`). |
| 2026-10-15 | — | `aafbd1e2050470b004f825290fe71edc4829674f` (Hosting version `d86104c0de7d29af`, release `1792032583836000`) | `aafbd1e2050470b004f825290fe71edc4829674f` | live | Workspaces-on shell with the phone layout fix. verify_hosting.js passed: shell and backend same commit. Owner session in production: Start walkthrough on the first screen at 390×844 and 320×844 (at 320 px it sits 6 px above the action bar under a three-line job title). Rollback target release `1792007460912000` (version `268707cc3c5b564a`). |
