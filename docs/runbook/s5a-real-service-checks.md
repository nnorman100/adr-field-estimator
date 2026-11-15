# S5a real-service checks on `test` (owner)

S5a-12 ([plan](../plans/S5/S5a-12.md)). The company-isolation gate ([Company isolation gate](../access/isolation-gate.md))
runs in CI against a local Postgres, the Firestore emulator and an in-memory stand-in for the evidence bucket. These four
checks run the same promises once against the real `test` services and a real iPhone. They are owner steps: they use
real test sign-ins, the owner's own `gcloud` login and a phone, so no agent and no workflow runs them.

**Status: all four are owner checks pending, not yet run.** Checks 1 (create-only upload), 2 (the fence), 3 (double
submit against Cloud Run) and 4 (homeowner signing on a real iPhone) have no result yet; their results are added in a
small follow-up docs PR. S5a is not closed until all four are recorded in [Results](#results) with a pass.

Use the two test companies only (company A and company B, each with an estimator account, as set up for the S3-18
smoke check) and synthetic customers, addresses and photos. Never use a real customer's details.

**Recording results.** Write each result in [Results](#results) at the end of this file, in a docs PR of its own, with
the date, the release version, who ran it and pass or fail. These rows are real-service results only: the mock and CI
results (the `company-isolation` job and the other suites) stay in CI and are never copied here, and a row here is
never filled from a CI run. A failed check stops the S5a close-out: do not release S5a to `live` until it passes.

## Before you start

You need Chrome on a laptop, a real iPhone with Safari, `curl`, and `gcloud` signed in as the owner (`gcloud auth login`).
Set the service address and check that `test` is serving the release you are checking:

```bash
BASE=https://dryscope-api-test-570228742694.us-central1.run.app
curl -sS "$BASE/api/health"; echo
```

Expected: `"status":"ok"`, `"env":"test"` and database `ok`. Note the `version`; it goes in each result row.

**A sign-in token, kept out of every file.** Checks 1 to 3 send requests as a test estimator. In Chrome, open `$BASE`,
sign in as the estimator of company A, open DevTools (Option+Cmd+I or F12), choose **Network**, type `/api/` in the
filter box and click any request, such as `me`. Under **Headers**, **Request Headers**, copy the value of
`authorization` after `Bearer ` (a long string in three parts separated by dots). Then, in the terminal:

```bash
read -rs DS_TOKEN_A        # paste the token, press Enter; nothing is shown
curl -sS "$BASE/api/me" -H "Authorization: Bearer $DS_TOKEN_A"; echo
COMPANY_A=<company.id from that answer>
```

Expected: `200` with `"company":{"id":"…"` naming company A. Do the same in a second Chrome profile signed in as company
B's estimator for `DS_TOKEN_B` and `COMPANY_B`. A token works for one hour; read a fresh one the same way when a request
answers 401. Never paste a token into a chat, issue, PR, file or this document, and close the terminal when you finish.

## 1. A create-only upload refuses an overwrite (`dryscope-evidence-test`)

The photo route stores every photo with the precondition `ifGenerationMatch=0`, so the bucket creates an object only
when no live object has its name and a second upload under the same name fails with `412 Precondition Failed`
([Photo routes](../access/photos.md)).

1. In Chrome as company A's estimator, start a new job, add one room and take or choose one photo. Wait until the phone
   shows the photo as sent.
2. In DevTools **Network**, click the `PUT` request whose path is `/api/jobs/<job>/photos/<photo>?kind=photo` and copy the
   two ids from its address:

   ```bash
   JOB=<job id>
   PHOTO=<photo id>
   OBJECT="gs://dryscope-evidence-test/companies/$COMPANY_A/jobs/$JOB/photos/$PHOTO"
   gcloud storage objects describe "$OBJECT" --project=dryscope
   ```

   Expected: the object exists. Note its `generation` and `size`.
3. Try to write over it straight on the bucket, with the same precondition the app uses:

   ```bash
   printf 'synthetic overwrite attempt\n' > overwrite-attempt.txt
   gcloud storage cp overwrite-attempt.txt "$OBJECT" --if-generation-match=0 --project=dryscope; echo "exit $?"
   rm overwrite-attempt.txt
   ```

   Expected: the copy fails with a precondition error (`412`, `PreconditionFailed` or "At least one of the
   pre-conditions you specified did not hold") and `exit 1`.
4. Send other image bytes under the same photo id through the app's own route. Use any JPEG or PNG on the laptop that is
   not the photo from step 1:

   ```bash
   curl -sS -X PUT "$BASE/api/jobs/$JOB/photos/$PHOTO?kind=photo" \
     -H "Authorization: Bearer $DS_TOKEN_A" --data-binary @/path/to/another-image.jpg -w '\nHTTP %{http_code}\n'
   ```

   Expected: `HTTP 409` with `"error":"photo_conflict"`.
5. Run the `describe` from step 2 again. Expected: the same `generation` and `size` as before; the photo on the job still
   shows the image from step 1.
6. Company B against it: send the same `curl` as step 4 with `$DS_TOKEN_B` instead. Expected: `HTTP 404`, and step 5's
   `describe` still unchanged.

If step 3 succeeds, the test photo was replaced: record a failure and stop.

## 2. The fence holds on `dryscope-field-test`

Once Submit has fenced a draft (`submitting`) or recorded it (`submitted`), the field rules refuse every phone write to it
([Field rules](../data/field-rules.md), [Submit](../access/submit.md)). Requests here carry a Firebase sign-in token, so
Firestore applies the security rules to them exactly as to the phone. (A `gcloud` token is not used: Firestore checks a
Google account's requests with IAM and skips the rules.)

1. In Chrome as company A's estimator, finish the job from check 1 (one room, one photo) and submit it with **Finish and
   review**. Wait until it shows as submitted. Then read its draft id and a room id:

   ```bash
   FS=https://firestore.googleapis.com/v1/projects/dryscope/databases/dryscope-field-test/documents
   curl -sS "$BASE/api/jobs/$JOB" -H "Authorization: Bearer $DS_TOKEN_A"; echo
   DRAFT=<currentDraftId from that answer>
   curl -sS "$FS/companies/$COMPANY_A/drafts/$DRAFT/rooms" -H "Authorization: Bearer $DS_TOKEN_A" | grep '"name"'
   ROOM=<the last part of one room's name, after /rooms/>
   ```

   Expected: the job answers with `"status":"submitted"`; the room list answers (the field owner may read it).
2. Try to change the submitted draft and its room as its own field owner:

   ```bash
   curl -sS -X PATCH "$FS/companies/$COMPANY_A/drafts/$DRAFT?updateMask.fieldPaths=field.notes&currentDocument.exists=true" \
     -H "Authorization: Bearer $DS_TOKEN_A" -H 'Content-Type: application/json' \
     -d '{"fields":{"field":{"mapValue":{"fields":{"notes":{"stringValue":"synthetic change after submit"}}}}}}' -w '\nHTTP %{http_code}\n'
   curl -sS -X PATCH "$FS/companies/$COMPANY_A/drafts/$DRAFT/rooms/$ROOM?updateMask.fieldPaths=field.name&currentDocument.exists=true" \
     -H "Authorization: Bearer $DS_TOKEN_A" -H 'Content-Type: application/json' \
     -d '{"fields":{"field":{"mapValue":{"fields":{"name":{"stringValue":"Synthetic Room"}}}}}}' -w '\nHTTP %{http_code}\n'
   ```

   Expected: both `HTTP 403` with `PERMISSION_DENIED`.
3. Control, so the refusal is the fence and not a malformed request: start another job as the same estimator, add a room
   on the phone, read its draft id the same way (`DRAFT2`), and send the first `PATCH` of step 2 with `$DRAFT2`.
   Expected: `HTTP 200`, and the job's notes show the synthetic line.
4. Company B against company A's drafts:

   ```bash
   curl -sS "$FS/companies/$COMPANY_A/drafts/$DRAFT" -H "Authorization: Bearer $DS_TOKEN_B" -w '\nHTTP %{http_code}\n'
   curl -sS -X POST "$FS/companies/$COMPANY_A:runQuery" -H "Authorization: Bearer $DS_TOKEN_B" -H 'Content-Type: application/json' \
     -d '{"structuredQuery":{"from":[{"collectionId":"drafts"}]}}' -w '\nHTTP %{http_code}\n'
   ```

   Expected: both `HTTP 403`.

The `submitting` state lasts only while a Submit is in flight, so it is checked with the emulator in CI; this check covers
the deployed rules on a `submitted` draft.

## 3. A double submit against Cloud Run gives one record

Submit is idempotent by the submission id the phone makes, and the database allows one committed record per draft
([Submit](../access/submit.md)). Cloud Run may hand two requests to two instances at once, so this sends them together.

1. In Chrome as company A's estimator, make a new job with one room and one photo, ready to submit. In DevTools open
   **More tools**, **Network request blocking**, tick **Enable network request blocking** and add the pattern
   `*/submissions`.
2. Tap **Finish and review** and submit. The request is blocked, so the server never sees it and the phone shows that it
   could not send. In **Network**, click the blocked `submissions` request, open **Payload**, click **view source** and copy
   the JSON (`{"id":…,"draftId":…,"digest":…}`). Untick blocking.

   ```bash
   JOB=<this job's id, from the request's path>
   BODY='<the JSON you copied>'
   for i in 1 2; do
     curl -sS -o "submit-$i.json" -w "attempt $i: HTTP %{http_code}\n" -X POST "$BASE/api/jobs/$JOB/submissions" \
       -H "Authorization: Bearer $DS_TOKEN_A" -H 'Content-Type: application/json' --data "$BODY" &
   done; wait; cat submit-1.json; echo; cat submit-2.json; echo
   ```

   Expected: one `HTTP 201` and the other `HTTP 200` with the same record (the same `id` and snapshot hash), or `HTTP 409`
   with `"error":"submission_in_progress"`. Never two `201`s.
3. Send the same body once more:

   ```bash
   curl -sS -X POST "$BASE/api/jobs/$JOB/submissions" -H "Authorization: Bearer $DS_TOKEN_A" \
     -H 'Content-Type: application/json' --data "$BODY" -w '\nHTTP %{http_code}\n'
   ```

   Expected: `HTTP 200` with the record from step 2.
4. Two phones at once (two submission ids for one draft): on a fresh job, repeat step 1 and only the blocked-request part
   of step 2 (submit with blocking on, copy the blocked request's JSON, untick blocking), and do not run step 2's `curl`
   loop, so the fresh draft is still unsubmitted. Set `JOB` and `BODY` from that request, then make a second body with a
   new id and send both together:

   ```bash
   JOB=<the fresh job's id, from the blocked request's path>
   BODY='<the JSON you copied from the fresh job>'
   BODY2=$(printf '%s' "$BODY" | sed -E "s/\"id\":\"[0-9a-f-]{36}\"/\"id\":\"$(uuidgen | tr 'A-F' 'a-f')\"/")
   curl -sS -o one.json -w "first: HTTP %{http_code}\n" -X POST "$BASE/api/jobs/$JOB/submissions" -H "Authorization: Bearer $DS_TOKEN_A" -H 'Content-Type: application/json' --data "$BODY" &
   curl -sS -o two.json -w "second: HTTP %{http_code}\n" -X POST "$BASE/api/jobs/$JOB/submissions" -H "Authorization: Bearer $DS_TOKEN_A" -H 'Content-Type: application/json' --data "$BODY2" &
   wait; cat one.json; echo; cat two.json; echo
   ```

   Expected: exactly one `HTTP 201`; the other is `HTTP 409` with `submission_in_progress` or `already_submitted`.
   Sending the losing body again answers `409` (`already_submitted` or `submission_aborted`), never `201`.
5. On the phone, reload the job: it shows as submitted once, and **Review before signing** prices one record.
6. Remove the answer files: `rm -f submit-1.json submit-2.json one.json two.json`.

## 4. A homeowner signs a link on a real iPhone

The homeowner's signing page and document links (S5a-11b, [Signing links and document links](../access/signing-links.md)),
on Safari on a real iPhone. Note the iPhone model and iOS version for the result row.

1. As company A's estimator (Chrome or the field phone), price a submitted job with a synthetic customer on **Review
   before signing**, then tap **Make a signing link** and send it to the iPhone (share sheet, copy into a message to
   yourself, or the QR code).
2. On the iPhone, open the link in Safari. Expected: the page names company A as its profile prints it, shows the estimate
   and the company's terms exactly as entered, and asks who signs (homeowner, adjuster or other). The address bar shows
   `/sign#…`; nothing of the link is in the path.
3. Choose **homeowner**, confirm the documents and the electronic consent, sign with a finger and send. Expected: a
   confirmation, and the page now shows the signed record read-only. Tapping send twice quickly, or going back and sending
   again, gives the same confirmation and one agreement.
4. On the technician's screen, reload the job. Expected: **Signed**, with the homeowner's and the adjuster's document links.
5. Open the homeowner's document link on the iPhone. Expected: the signed proposal with who signed and their role, the
   photo log with the job's photos and the signature. Open the adjuster's link. Expected: the claim documents without the
   proposal.
6. Open the signing link again. Expected: the signed record, read-only; nothing can be signed again.
7. As company A's owner or office user, revoke the homeowner's document link and reload it on the iPhone. Expected: the
   "link unavailable" page.
8. In Chrome signed in as company B's estimator, open company A's job by its address (`$BASE/sign-in/<company B's
   sign-in address>/jobs/<company A's job id>/review`). Expected: "This job could not be found", and nothing of company A.

## Results

Real-service results only, newest first. Mock and CI results are never written here. No check has been run yet: all
four are owner checks pending, and S5a is not closed until each has a passing row here.

| Date | Release version | Check | Result | Run by | Notes (no token, name or address) |
| ---- | --------------- | ----- | ------ | ------ | --------------------------------- |
|      |                 |       |        |        |                                   |
