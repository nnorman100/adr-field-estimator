# Slice NN: [Name]

Status: draft · building · done · Branch: `slice/NN-name` · Risk: Low | Medium | High

## Goal
[What can a user do after this that they could not before?]

## Who it is for
[Role(s): owner / estimator / office / superadmin support / homeowner]

## Out of scope
- [..]

## Behavior
[Screens, steps, wording. Include exact customer-facing wording the owner must approve.]

## Backend and data
- Routes: [..]
- Fields/records added; sidecar or signed record? (Signed records never change.)
- New index? Declare in `firestore.indexes.json`.

## The eight checks (answer each)
1. Rules and indexes: [..]
2. Older records: [how old-shape jobs display; never backfill invented values]
3. Offline: [what happens with no signal]
4. Who may use it: [add to `can()` and the server check; test owner, estimator, office, superadmin support, other company]
5. App update/cache: [`sw.js` precache and shell version]
6. Help and docs: [Help how-to, README, `docs/company-workspaces.md`, `docs/ACCESS.md`, `docs/STATUS.md`]
7. Privacy and logs: [allowlisted fields only]
8. Phone check by the owner: [what to try]

## Acceptance criteria (each has a test that fails without the change)
1. [Given / when / then]

## Tests
- Python: [..] · JS: [..] · Browser: [..]

## Rollback note
[Does rolling back lose data or features? Prefer fixing forward.]

## Done
- [ ] Criteria pass · [ ] CI green · [ ] Eight checks answered · [ ] Docs updated · [ ] Independent review · [ ] Owner phone check recorded
