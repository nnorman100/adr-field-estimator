# Release checklist

The owner approves every production release. Follow the recipe at the top of `RELEASES.md`; this list adds the checks around it. Automatic deploys (`docs/firebase-isolation.md#automatic-deploys`) are recorded in the Actions job summary, not `RELEASES.md`. Never run a blanket `firebase deploy`.

## Before
- [ ] Master CI is green **on the exact commit being released**
- [ ] Python, JS and browser tests pass locally or in CI; no test weakened (Test guard clean)
- [ ] The eight checks in `docs/roadmap.md` are done for every item in the release
- [ ] Any new Firestore index is declared in `firestore.indexes.json` and READY
- [ ] Firestore TTL policies verified ACTIVE (`scripts/ensure_firestore_ttls.py`, see `docs/firebase-isolation.md`)
- [ ] Rollback pair recorded: current serving backend revision and Hosting version
- [ ] Rollback note covers data compatibility (new fields mean old revisions lose features; prefer fixing forward)
- [ ] Feature flags decided: `AI_FEATURES`, `PRICE_BOOKS_ENABLED`, `WORKSPACES_ENABLED` set on purpose by `scripts/deploy_backend.py`
- [ ] No secrets, keys or personal data in the diff

## Release
- [ ] Get the number: `python3 scripts/auto_deploy.py --next-version`
- [ ] Stage backend at 0% traffic with a tag (`--version YYYY.MM.DD-N`); run staged checks
- [ ] Promote; `/api/health` reports `version` and `source_commit`; anonymous business routes return 401
- [ ] Stamp (`--version YYYY.MM.DD-N`) and deploy **only** `hosting:alert-disaster`
- [ ] `node scripts/verify_hosting.js` passes (matching version, commits, assets, CSP, OAuth popup)
- [ ] Publish the tag and GitHub Release: `python3 scripts/auto_deploy.py --publish <commit>`
- [ ] 15-minute watch
- [ ] For a manual release, append the rows to `RELEASES.md`; reset the stamp (`stamp_hosting.py --reset`); both `index.html` copies identical

## If a check fails
Run `python3 scripts/auto_deploy.py --rollback <YYYY.MM.DD-N>` (or restore traffic to the recorded rollback revision and the recorded Hosting version), note any `_migrations` data migration or rules and indexes warning (the rollback stops there unless rerun with `--confirm-past-migration`), record the failed attempt and the rollback, and do not retry blindly. (This is what happened with release 5 on Oct 26.)

## After (owner)
- [ ] Phone check of each new screen on a real phone (record separately from automated results)
- [ ] `docs/STATUS.md` updated
