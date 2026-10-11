# Full application review — October 6, 2026

**Repair status — October 7, 2026:** All six findings below are fixed, tested and deployed to the dedicated project `alert-disaster-field-2026`. The original review and its source locations are retained below as historical evidence. Physical iPhone acceptance and the product decisions listed under design gaps remain open; deployment does not establish those results.

| Finding | Repair and verification | Status |
| --- | --- | --- |
| R-01 | Cloud-restored originals are stored in the owner's IndexedDB draft. Conflict copies fetch missing originals before creating the new inspection. Browser tests cover photo-backed conflict recovery on Chromium/WebKit and offline photo reload on Chromium. Unavailable originals leave a retryable error. | Fixed / deployed |
| R-02 | Reconciliation merges remote and local photo IDs and loads missing originals. Chromium/WebKit tests reopen a local draft after another device adds a photo and show both photos. | Fixed / deployed |
| R-03 | The durable receipt is committed independently of record/evidence display. Fields and signing remain locked; a separate evidence retry never reposts a signature. Chromium/WebKit tests cover record and evidence GET failures after a successful POST. | Fixed / deployed |
| R-04 | Firestore orders before limiting, returns an owner-checked cursor, and the UI offers older pages. Composite indexes are READY. Unit tests cover 205 records, browser tests cover 105 signed jobs, and deployed synthetic checks cover 105 drafts and 105 signed-job fixtures with cross-owner cursor denial. | Fixed / deployed |
| R-05 | Protected routes use `check_revoked=True`; active Live sessions recheck every 20 seconds. The dedicated runtime has Firebase Authentication viewer access. Unit tests cover revoked tokens/Live teardown. Disabling a real synthetic Firebase account stopped its active Gemini Live session in 19.7 seconds and yielded REST 401. | Fixed / deployed |
| R-06 | Unique upload-attempt paths and generation-checked deletion remove confirmed unreferenced objects after rejected transactions or losing retries. Local tests inject a conflict after upload; deployed concurrent photo/signature checks leave only committed objects. Failed cleanup is logged and retains the private object when safe deletion cannot be confirmed. | Fixed / deployed |

Final verification: **37 Python tests passed**, Node checks and JavaScript syntax passed; **32 browser cases passed, 4 explicitly skipped** for Windows WebKit's missing Web Audio and offline service-worker limitations. The final browser run used the existing timeouts; the new recovery helper waits for the asynchronous new-inspection menu closure. Live Hosting checks passed asset equality, mobile layout, fonts/cache, dedicated routing, anonymous denial, CSP and Google OAuth popup. [Deployed synthetic results](deployed-fix-checks.txt) record Firestore, concurrency, complete document/evidence restoration and disabled-session checks. All synthetic accounts, records, quotas, leases and evidence were removed; the expiring token-signing grant was removed afterward.

Release: frontend `ui-20261006-6`, Hosting version `60724bb918512475` / release `1791378004044000`; backend `alert-disaster-field-estimator-00005-htr` at 100% traffic. Only dedicated Firestore indexes, runtime IAM, Cloud Run and `hosting:alert-disaster` were changed. Previous dedicated Hosting version `ef31df7f4a1fb47e` / release `1791344352511000` and backend `00004-rzx` remain rollback points. Staff/model environment settings were preserved. Workbook range pricing was unchanged.

---

**Verdict: Needs work.** The current local app completes the principal synthetic flow from private draft through priced audit, four documents and signed-job restoration, and its dedicated-project and owner checks held in local tests. A photo-backed draft restored from the cloud cannot use the offered “Save local work as new inspection” recovery after a revision conflict; this is a confirmed High finding. Other confirmed gaps affect evidence visibility, saved-job retrieval, revoked sessions and post-sign recovery. This review used the current uncommitted working tree at commit `9724b97`; it made no application-code or deployment changes and did not contact production.

The intended-behavior synthesis is in [intended-behavior.md](intended-behavior.md), and the approved scope is in [plan.md](plan.md). Findings below refer to current code, not historical repair status.

## Issues

Six confirmed issues: **1 High, 4 Medium, 1 Low; 0 Critical**. R-01 combines two effects of the same missing durable cloud-photo bytes.

| ID | Severity | Area and exact location | What is wrong | Intended behavior | Suggested fix |
| --- | --- | --- | --- | --- | --- |
| R-01 | **High** | `public/app.js:279`, `public/app.js:467` | A photo restored from cloud has a transient blob URL but no `data_url`; the offered conflict fork rejects it, even though the photo is visible. The same missing durable bytes make that photo unavailable after an offline reload. | A technician can preserve local edits as a new inspection after a revision conflict, with its photos; offline recovery should show what evidence is available. | Fetch owned original bytes before cloning; persist a bounded private copy for offline display or clearly mark cloud-only media unavailable offline. Keep the fork retryable. |
| R-02 | Medium | `public/app.js:70`, `public/app.js:262` | Reconciliation updates locally known photos but never adds photo IDs newly present in the server record. A reopened local draft can show fewer photos than the saved inspection. | Saved evidence and evidence later displayed should match, including a photo added on another tab/device. | Merge the union of server and local photo IDs, preserve unsynced local entries, and fetch missing thumbnails before review. |
| R-03 | Medium | `public/app.js:299`, `public/app.js:302`, `public/app.js:364` | A successful authorization receipt is followed by photo/signature fetches. If one fetch fails, signing reports “Save not confirmed,” although the agreement was saved; `restoreSigned` has already cleared the retry reference and set `signed`, so the retry button is disabled. | An acknowledged signed job should show a durable receipt and offer a separate retry for evidence display. | Commit the receipt state independently of evidence loading, retain the authorization ID, and make failed photo/signature retrieval retryable without resubmitting the signature. |
| R-04 | Medium | `backend/inspection_store.py:51`, `backend/job_store.py:113` | Both owner queries take an unordered `limit(100)` before sorting in Python. With more than 100 records, newer drafts or signed jobs can be absent from the only Jobs list. | Staff should be able to find their recent saved records for later office use. | Order by timestamp descending in Firestore before limiting, add the needed composite index, and paginate or expose a search/open-by-ID path. |
| R-05 | Medium | `backend/main.py:64`, `backend/main.py:322` | Firebase ID tokens are verified without revocation/disabled-user checking. An unexpired token can continue passing the verified-email allowlist after its Firebase session is revoked or user is disabled; an established Live session is only time-checked. | Protected routes and sessions should stop accepting disabled or revoked staff access. | Verify with `check_revoked=True`, map revoked/disabled cases to 401, and define/recheck a bounded Live-session revocation interval. |
| R-06 | Low | `backend/inspection_store.py:107`, `backend/inspection_store.py:172` | Evidence/signature bytes upload before the revision transaction commits. A concurrent conflict can leave an unreferenced private object in the bucket. | Failed/conflicting saves should not accumulate abandoned private evidence. | Stage or reconcile uploads and clean only confirmed unreferenced object generations after a failed transaction. |

### R-01 browser reproduction and evidence

1. In the localhost synthetic app, create a draft and add a 400 × 600 PNG. The [evidence screen](local-evidence.png) shows its room, dimensions and “no meter” status.
2. Open the same saved draft in a fresh isolated browser session under the same synthetic owner; the cloud-restored photo is visible. Advance that inspection's revision with a second synthetic tab/API request, then edit local notes and save. The app shows “Revision conflict · local draft preserved.”
3. Select “Save local work as new inspection.” The app keeps the conflict and displays “Reconnect and load the original photos before forking this draft,” despite the photo being loaded. See the [blocked fork](photo-conflict-fork-blocked.png) and [photo still present](photo-conflict-evidence.png). The error was observed in the fresh local browser session. The local notes remain; restoring the server draft would discard them.

The root reviewer independently reproduced this High issue in the running local app after the code reviewer found the missing `data_url` path. Local browser-only steps and probe scripts are retained alongside the screenshots.

### Other finding evidence and limits

- R-02: A focused local state reproduction with one local photo and two server photos left the UI draft with only the original local photo; the loop at `app.js:70` has no append branch. This is a cross-device/tab condition not covered by the existing browser suite.
- R-01 also affects offline reload: the remote image response becomes an object URL at `app.js:279`, and only draft metadata is persisted. The service worker deliberately excludes authenticated evidence; no local durable byte copy exists. This consequence was confirmed in a focused state reproduction, not on a physical iPhone.
- R-03: A focused local authorization reproduction returned a successful receipt, then failed the evidence GET. The UI displayed “Save not confirmed,” while `signed` was already true and retry state cleared. The existing browser test covers failure of the *authorization POST*, not this later failure.
- R-04: Focused fake-store runs with 101 chronological records returned the first 100 and omitted the newest one. The Firestore `limit`/sort order is visible at the cited lines. A real Firestore query was not run.
- R-05: The installed Firebase Admin SDK defaults `check_revoked` to false; local verifier inspection and a synthetic allowlisted-claims check show that the current call does not request revocation checks. No real disabled Firebase account was used.
- R-06: A fake bucket hook advanced the draft revision after upload but before commit. The subsequent conflict left one object in storage and no photo reference in the inspection. No real GCS object was created.

## Verification

| Check | Result |
| --- | --- |
| Python suite, outside the test dependency sandbox restriction | **32 passed**, 2 upstream deprecation warnings: `python -m pytest -q -p no:cacheprovider`. |
| Node checks | **Passed**: `npm test` (currency, HTML mirror, image aspect, PCM/resampling, teardown). |
| Local Playwright Chromium/WebKit | **21 passed, 3 skipped**: `npx playwright test --reporter=line`; skips are Windows WebKit Web Audio and two real-offline service-worker journeys. |
| Local exploratory browser | Property, evidence, audit/review and photo-backed conflict tested with synthetic identities on `https://localhost:8765`. [Property](local-property.png), [walkthrough at 390 px](../redesigned-walkthrough-390.png), [evidence](local-evidence.png), [review](local-review.png), [mobile claim](../redesigned-mobile-claim.png), [conflict](photo-conflict-fork-blocked.png). The review screen showed `$1,208.00–$1,221.90` versus `$1,208.00` itemized for a 10-SF category-1 finished room; four documents were present and an injected AI string displayed as literal text. |
| Printed documents | Playwright generated a [four-page synthetic Letter PDF](../repaired-documents.pdf). I rendered and visually inspected each page: proposal, itemized claim, defense letter and photo log are legible with no clipping or overlapping text. The synthetic black photo and literal injection string are deliberate fixture content. |
| Synthetic access replay from browser | Anonymous inspection read returned **401**; another synthetic owner could not read, update or fetch a photo from the inspection by changed ID (**404** each). The [probe](cross-owner-probe.js) and its localhost-only fixture were used. |
| Build, type check and linter | No build/type/lint scripts or tool configuration are defined for this static JavaScript/Python repository. Existing test and browser suites were run; those checks cannot be reported as passing. |

The first sandboxed Python/browser attempt could not read `.test-deps/tzdata/__init__.py` and generated environment-only failures. Rerunning the unchanged suites with filesystem access to that existing dependency produced the passing results above. No real customer account, production URL, live cloud data or deployed service was used in browser testing.

## Confirmed behavior and design gaps

Local traces found owner checks on business APIs and parent-owned evidence retrieval, deny-all direct Firestore browser rules, a dedicated project guard and same-project Hosting target, typed audit/photo/signature validation, server-side pricing, immutable revision/hash signing, transactional quotas and PWA API cache exclusion. These are local code/test observations, not deployed IAM or device acceptance.

- **Office access:** The current documented model allows a staff user to list only jobs owned by that same Firebase UID. If office personnel need to retrieve any technician's job without using that technician's account, the product needs an explicit office role, sharing rule and server-side authorization design. This is a product decision, not a finding that current owner checks are wrong.
- **Document naming:** `AGENTS.md` calls the itemized output “Xactimate Line Items,” while current operating instructions say ADR internal scope codes and no ESX compatibility claim. Confirm the approved customer/adjuster label and export promise.
- **Historical references:** The earlier pasted instructions and old UI report mention package tiers and a shared project. The current repository `AGENTS.md`, workbook notes and isolation docs supersede them. Keeping old artifacts clearly marked historical would reduce future ambiguity.
- **Live recovery after connectivity loss:** `public/app.js:440` stops media when the browser reports offline and only syncs drafts when it reports online again. A focused state reproduction confirmed that Live does not restart automatically; manual Start works. Clarify whether the iPhone reconnect acceptance requires automatic resumption of an interrupted session or an explicit technician restart, then test that behavior on-device.

## Untested journeys, ordered by risk

1. Physical iPhone camera/microphone permission behavior, Bluetooth audio, interruption, reconnect, Finish teardown and measured sub-second Live latency. Browser media is synthetic; Windows WebKit lacks Web Audio in this test build.
2. Actual deployed Firebase project/IAM/bucket ACL/Auth configuration and disabled-user behavior. This review's local-only instruction precluded production access.
3. Real Vertex AI Live, OCR and audit responses, quotas/cost and model availability under the dedicated project. The local harness mocks provider output and failures.
4. Real Firestore ordering/index behavior above 100 records and real GCS cleanup after a concurrent write conflict; current proof uses local fake stores.
5. WebKit installed-app offline navigation and queued-work sync on a physical iPhone. Two Windows WebKit offline tests are explicitly skipped.
