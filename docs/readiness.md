# F1 readiness (off by default)

`AI_FEATURES=readiness` enables F1, and the repository baseline (`DEFAULT_AI_FEATURES`) sets it
on every release. The comma-separated server flag defaults to empty; `/api/session.ai_features` advertises it. Release
with Phase 3a only after the staged and physical-device checks below. No deployment
or model call is part of this change's local verification.

Owners and estimators with scope access see a **Still missing** count in Walk &
Photo. **Finish & review** shows **Ready to review?** when a gap exists that was
absent at the previous Finish on this device. Fix opens the relevant form or photo
list; Continue runs the existing audit checks. Resolving a gap, or changing only
the draft revision, does not repeat the dialog. Back also acknowledges that Finish's
list. The acknowledgement is private local UI state outside `inspection.data`,
never uploaded by the offline queue. A new device can show its first check again.
Office and superadmin support have no readiness controls. Signed agreements are
unchanged and never carry a derived readiness field.

The Python and JavaScript gap lists use the same twelve synthetic fixtures. They
include intake, demolition, photo tags/counts, loss type, water-room sizing, AHAM,
partial claim fields, setup readings, pending/failed photo verification and scope
confirmation. Legacy category-3 rooms use the existing mold sizing exemption;
missing explicit loss confirmation remains advisory. No equipment quantity or
price is inferred. Claim values, customer names, coordinates and reading values
are absent from the readiness payload; room names identify where to fix a gap.

Two pricing gaps sit outside those fixtures. `prices` (**Company prices are not set
up**) appears when the job has no saved prices and its company has no published
prices. `area_basis` appears, per room, when a `dryscope-v2` table prices by wet
floor area and the room has neither a wet floor nor a floor area; a wet floor area of
0 is deliberate and is not a gap. A company on the v1 rate book gets neither gap.

There is no setup timestamp/visit marker in the current log. The first affected-air
or affected-material reading is treated as the setup reading; thermal, outside-air
and dry-reference-only readings do not clear that gap. This is an initial-reading
check, not evidence that each affected material has been measured. Missing or
loading logs say **Readings not loaded**; offline says **Readings unknown offline**.
The list needs no new network request. Existing reading-load failure stays retryable
through the drying-log reconnect path. AI/document generation remains online-only.

Authorized draft responses derive readiness from the existing claim and reading
sidecars and the job's price basis. The relay rechecks job access when reading saved readiness, and appends
it to the existing shot-status context message under the [relay timing and access
constraints](firebase-isolation.md). Saved draft changes that alter readiness, claim
saves and reading saves/removals notify that channel. The gated
Live instructions ask one listed gap after photo shots, never fill or mark anything
complete, and never describe gaps as blockers. No new model operation, per-user
cap, log field or monitoring alert is introduced; existing Live caps, failure alerts
and provider retry behavior apply. No new route or acceptance endpoint is needed:
Fix edits through existing authenticated routes and Continue calls the existing
audit. Signing still uses the existing deterministic checks.

Database review: readiness is derived and never stored. `firestore.rules` remains
deny-all. There is no new collection, index, TTL field/group or migration. Existing
reading transactions and their authorization are reused. The emulator regression
checks that reading-dependent readiness changes without touching the inspection
or creating a quota record; existing rules and TTL suites remain authoritative.
The changed frontend assets are already in `sw.js`'s precache; the release stamp
bumps its cache version and asset URLs. Both landing HTML copies remain identical.

Verification: `tests/test_readiness.py`, `tests/browser/readiness.spec.js`, the node
fixture checks and the existing lifecycle suites run with fakes. The dry-run eval
is `python scripts/verify_live_release.py --readiness-dry-run`; its synthetic
transcripts prove the pass-bar code, not model behavior. With later release
authorization, pass `--readiness-audio /absolute/path/question.wav` alongside the
normal staged `--backend-tag ... --token-stdin` flow. Supply 16 kHz mono PCM16 audio
asking “What is still missing? Ask me for just one item.” It checks three replies
after saved readiness updates: exactly one listed gap requested, no completion or
blocking claim. No production target is allowed for that optional eval. The owner
must separately hear a sizing-input request and a setup-reading request on iPhone;
camera, Bluetooth, interruption, reconnect, Finish cleanup and latency remain device
observations, not claims from mocks.

Kun's input: deterministic checks reuse structured facts and existing transports;
there is no model loop, extra persistence or generic suggestion framework. The
regression tests exercise public routes, saved-state isolation and real UI actions.

Estimate warnings share the dialog. With `AI_FEATURES=estimate_assist` on, **Ready to
review?** also lists the server's warnings for the saved draft under **Check before you
finish**, and it opens for a new warning as it does for a new gap. Online, Finish saves
the draft before this check, so an edit made a moment earlier is listed. With `readiness` off,
the same dialog opens for warnings alone and the gaps, the **Still missing** count and
the fill's extra gaps stay off. See [Estimate assist](estimate-assist.md#4-guard-rails-while-estimating).
