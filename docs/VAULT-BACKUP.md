# DryScope vault backup

Before this job is deployed and verified, Firebase Auth has no backup, and evidence photos and signature images live in one private bucket with a 7-day soft delete and no second copy. This job exports logins and copies evidence into a separate project once a day.

Transcripts stay in Firestore, which already has point-in-time recovery (7 days), delete protection, and a daily backup kept for 98 days. Live audio and voice recordings are not stored. This job does not read Firestore and does not try to back up audio that was never written.

The job is a separate Cloud Run deployment. Merging this repository does not update it. PlumbUp's October 2026 backup ([plumbupusa#87](https://github.com/nnorman100/plumbupusa/pull/87)) kept writing to the old bucket for three days because the vault change was merged and the running image was never replaced; successful executions were not vault backups. Treat a green execution the same way here: accept a run only when the log and the vault object's metadata agree. A same-day `already_exists` result does not prove this image wrote a new object.

Nothing in this file is run by the app or by CI. The commands are for the project owner, after review.

## How it runs

| Part | Value |
| --- | --- |
| Code | [`ops/vault-backup/`](../ops/vault-backup/): `vault_backup.py` runs once and exits; `auth_export.py` writes the same user records as `firebase auth:export` |
| Cloud Run job | `dryscope-vault-backup`, `us-west2`, project `alert-disaster-field-2026`, 1 task, 2 retries, 1800-second timeout, 1 CPU, 512Mi |
| Schedule | Cloud Scheduler `dryscope-vault-backup-daily`, `15 11 * * *` UTC |
| Identity | `dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com` |
| Auth permission | Custom role `dryscopeVaultBackup`: `firebaseauth.users.get`, `firebaseauth.configs.getHashConfig` |
| Evidence permission | `roles/storage.objectViewer` on `gs://alert-disaster-field-2026-evidence` only |
| Vault permission | `roles/storage.objectCreator` on `gs://alert-disaster-vault-backups` only |
| Trigger permission | `roles/run.invoker` on this job only, so the scheduler can start it |
| Auth output | `gs://alert-disaster-vault-backups/auth/YYYY-MM-DD.json` |
| Evidence output | `gs://alert-disaster-vault-backups/evidence/<source-generation>/<source-object-name>` |
| Manifest | `gs://alert-disaster-vault-backups/manifests/YYYY-MM-DD.json` |
| Vault project | `alert-disaster-vault`, bucket location `us-central1` |
| Retention | Lifecycle deletes vault objects 90 days after they were created; soft delete keeps a deleted object for 7 more days |

Evidence is in `us-west2`. The vault bucket is in `us-central1` so a single-region outage does not take both copies. Cross-region copy has an egress charge. The job runs in `us-west2` next to the evidence bucket and tells Cloud Storage to rewrite objects. It does not download photo bytes.

The source object name is kept after the generation directory. Photos and signatures are normally written once under a unique name. The evidence bucket has no object versioning, so a later replacement is a new generation and the previous bytes are gone from that bucket. The generation directory makes that replacement a new create-only object. Each rewrite asks for that listed generation with `sourceGeneration` and `ifSourceGenerationMatch`, and creates the vault object with `ifGenerationMatch=0`. On the first rewrite request, a `412` whose reasons are all `conditionNotMet` counts as already present only after a source metadata read of generation returns HTTP 200 and still shows the listed generation. A different generation or an unsuccessful source read fails the run without another rewrite attempt. A `412` on a rewrite continuation fails immediately without a source read. These failures do not count a copy. The next run lists the new generation and copies it under a new key. The job never deletes or overwrites a vault object. It cannot read the vault; Object Creator has no get or list. A `412` with any other reason fails the run.

Lifecycle age is 90 days from when that vault object was created. After deletion, the next successful run copies a source object that is still live, because a soft-deleted vault object does not satisfy `ifGenerationMatch=0`. Soft delete then keeps the removed vault generation for 7 days. A generation the job has not yet copied exists only in the evidence bucket (and in that bucket's own 7-day soft delete if it was removed there).

The UTC date is chosen once at the start of the task and used for the auth object and the manifest, including when a run crosses midnight. A same-day rerun keeps the existing auth object and manifest. Users added after that day's object was created appear in the next day's auth file. Photo copies still proceed on the rerun: missing generations are created. If any photo is created but the dated manifest already exists, the run fails because the existing manifest cannot record the new receipts.

Each write is accepted only when the upload or rewrite response names the intended bucket and object, a positive generation, and the byte size. Evidence responses must also echo the source `crc32c` (and `md5Hash` when the listing had one). The job does not read the object back. Logs contain outcomes, counts, the destination bucket, dated auth and manifest object names, and their response generations and sizes. They omit emails, password hashes, photo bytes, user IDs, evidence paths, checksums, and SDK error bodies. `stage=export` means the account download failed, or a password account had no usable hash (including a hash firebase-tools would drop because `version` is not 0). The task exits non-zero, so Cloud Run retries and, after the retries, marks the execution failed.

| `outcome` | Meaning |
| --- | --- |
| `created` | At least one of the auth file, the manifest, or an evidence generation was created, and every response checked out |
| `already_exists` | This UTC day's auth object and manifest were already there, and every current evidence generation was already there. This is a rerun, not proof that this image wrote the files |
| `failed` | Export, list, copy, upload, or response check failed. `stage` and `http_status` (when the status is 4xx or 5xx) say where. The process exits 1 |

`auth_outcome` and `manifest_outcome` are `created` or `already_exists` on their own. Evidence counts are `copied`, `already_present`, and `bytes_copied`.

## Access

Auth files contain password hashes and emails. Evidence copies are the inspection photos and signature images. Treat the vault like a password store.

The vault is a separate project because Editor on `alert-disaster-field-2026` includes Cloud Storage read, and these projects are not in a Google Cloud organization that could hold a deny policy. `alert-disaster-vault` has the owner as its only member and only the Storage API enabled. Enabling Cloud Run, Cloud Build, Firebase, Firestore, Compute, App Engine, or Container there can create a default service account with Editor. The backup identity is not a member of the vault project; its only vault grant is Object Creator on this bucket.

The export is project-wide. It includes every Firebase Auth user and every live object in the evidence bucket, for every company workspace.

## Owner setup

Run these from the repository root, signed in as the owner. Stop if a command wants a new permission, a key file, or an API in `alert-disaster-vault` other than Storage.

1. Create the vault project and attach the same billing account as DryScope. Confirm that account is the approved Citi account ending F05CC3 before linking.

   ```sh
   gcloud projects create alert-disaster-vault --name='DryScope vault'
   gcloud billing projects describe alert-disaster-field-2026 --format='value(billingAccountName)'
   gcloud billing projects link alert-disaster-vault --billing-account='BILLING_ACCOUNT_ID'
   ```

   `BILLING_ACCOUNT_ID` is the id at the end of `billingAccountName` (`billingAccounts/XXXX-XXXX-XXXX`). If the project id is already taken, pick another id. The bucket name below is global and is what the job uses; if that bucket name is taken, stop. A different bucket name requires a code change in `ops/vault-backup/vault_backup.py`.

2. Enable Storage and check the project members and enabled APIs.

   ```sh
   gcloud services enable storage.googleapis.com --project=alert-disaster-vault
   gcloud services list --enabled --project=alert-disaster-vault --format='value(config.name)'
   gcloud projects get-iam-policy alert-disaster-vault --format='yaml(bindings)'
   ```

   The member list should be the owner only. Stop if a default service account holds Editor. Stop if the enabled list includes `run.googleapis.com`, `cloudbuild.googleapis.com`, `firebase.googleapis.com`, `firestore.googleapis.com`, `compute.googleapis.com`, `appengine.googleapis.com`, or `container.googleapis.com`. Companion APIs that Storage enablement turns on, such as Service Management, can stay when they add no Editor account.

3. Create the bucket in `us-central1` with uniform access, public access prevention, a 7-day soft delete, and the 90-day lifecycle file.

   ```sh
   gcloud storage buckets create gs://alert-disaster-vault-backups \
     --project=alert-disaster-vault \
     --location=us-central1 \
     --uniform-bucket-level-access \
     --public-access-prevention \
     --soft-delete-duration=7d
   gcloud storage buckets update gs://alert-disaster-vault-backups \
     --project=alert-disaster-vault \
     --lifecycle-file=ops/vault-backup/lifecycle.json
   gcloud storage buckets describe gs://alert-disaster-vault-backups \
     --format='yaml(location,iamConfiguration,softDeletePolicy,lifecycle)'
   ```

   `iamConfiguration` should show uniform bucket-level access and public access prevention. `location` is `us-central1`. `softDeletePolicy.retentionDurationSeconds` is `604800`. The lifecycle rule deletes at age 90.

4. Place a lien so the project is not deleted in passing.

   ```sh
   gcloud alpha resource-manager liens create \
     --project=alert-disaster-vault \
     --restrictions=resourcemanager.projects.delete \
     --reason='DryScope vault holds the off-project copies of logins and evidence photos' \
     --origin=dryscope-vault
   ```

5. Create the job identity in the DryScope project and grant only the backup permissions.

   ```sh
   gcloud iam service-accounts create dryscope-vault-backup \
     --project=alert-disaster-field-2026 \
     --display-name='DryScope vault backup'
   gcloud iam roles create dryscopeVaultBackup \
     --project=alert-disaster-field-2026 \
     --title='DryScope vault backup' \
     --description='Read Firebase Auth users and password hash parameters for the daily vault export.' \
     --permissions=firebaseauth.users.get,firebaseauth.configs.getHashConfig \
     --stage=GA
   gcloud projects add-iam-policy-binding alert-disaster-field-2026 \
     --member='serviceAccount:dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com' \
     --role='projects/alert-disaster-field-2026/roles/dryscopeVaultBackup'
   gcloud storage buckets add-iam-policy-binding gs://alert-disaster-field-2026-evidence \
     --project=alert-disaster-field-2026 \
     --member='serviceAccount:dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com' \
     --role='roles/storage.objectViewer'
   gcloud storage buckets add-iam-policy-binding gs://alert-disaster-vault-backups \
     --project=alert-disaster-vault \
     --member='serviceAccount:dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com' \
     --role='roles/storage.objectCreator'
   ```

   Do not grant this identity Object Viewer or Object Admin on the vault, and do not grant it a project role on `alert-disaster-vault`. Cloud Run collects stdout without `roles/logging.logWriter`.

6. Enable the scheduler in the DryScope project if it is not already enabled. Source deploy also uses Cloud Build and Artifact Registry there. Leave those APIs off in the vault.

   ```sh
   gcloud services enable cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
     --project=alert-disaster-field-2026
   ```

7. Deploy the job from this directory. Then allow the same identity to start that job, and let the Cloud Scheduler service agent mint that identity's token.

   ```sh
   gcloud run jobs deploy dryscope-vault-backup \
     --source=ops/vault-backup \
     --region=us-west2 \
     --project=alert-disaster-field-2026 \
     --service-account='dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com' \
     --tasks=1 \
     --max-retries=2 \
     --task-timeout=1800s \
     --cpu=1 \
     --memory=512Mi
   gcloud run jobs add-iam-policy-binding dryscope-vault-backup \
     --region=us-west2 \
     --project=alert-disaster-field-2026 \
     --member='serviceAccount:dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com' \
     --role='roles/run.invoker'
   PROJECT_NUMBER=$(gcloud projects describe alert-disaster-field-2026 --format='value(projectNumber)')
   test "$PROJECT_NUMBER" = 545776254070
   gcloud iam service-accounts add-iam-policy-binding \
     dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com \
     --project=alert-disaster-field-2026 \
     --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
     --role='roles/iam.serviceAccountUser'
   gcloud scheduler jobs create http dryscope-vault-backup-daily \
     --location=us-west2 \
     --project=alert-disaster-field-2026 \
     --schedule='15 11 * * *' \
     --time-zone='Etc/UTC' \
     --uri='https://run.googleapis.com/v2/projects/alert-disaster-field-2026/locations/us-west2/jobs/dryscope-vault-backup:run' \
     --http-method=POST \
     --attempt-deadline=180s \
     --max-retry-attempts=2 \
     --oauth-service-account-email='dryscope-vault-backup@alert-disaster-field-2026.iam.gserviceaccount.com' \
     --oauth-token-scope='https://www.googleapis.com/auth/cloud-platform'
   ```

   `projectNumber` `545776254070` is the DryScope project. Stop if the lookup prints something else. The scheduler call returns when the execution is created; Cloud Run's own retries cover a failed task. A later deploy of this job must repeat the `gcloud run jobs deploy` and the metadata check below. Updating the scheduler is not required unless the schedule changes.

## One-off verification

Use metadata and log fields. Do not download `auth/*.json` or photo bytes to check the job.

1. Record the image, then compare it with the deploy above if this is a redeploy.

   ```sh
   gcloud run jobs describe dryscope-vault-backup \
     --region=us-west2 \
     --project=alert-disaster-field-2026 \
     --format='yaml(metadata.generation,spec.template.spec)'
   ```

   Confirm the service account, one task, two retries, and 1800-second timeout. Confirm the image digest changed after a redeploy. An unchanged digest means the new source is not running.

2. Run once and keep the execution name the command prints.

   ```sh
   gcloud run jobs execute dryscope-vault-backup --region=us-west2 --project=alert-disaster-field-2026 --wait
   VAULT_EXECUTION='<execution name printed above>'
   gcloud logging read \
     "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"dryscope-vault-backup\" AND labels.\"run.googleapis.com/execution_name\"=\"$VAULT_EXECUTION\" AND jsonPayload.event=\"vault_backup\"" \
     --project=alert-disaster-field-2026 --freshness=1d --order=asc --limit=20 \
     --format='yaml(timestamp,jsonPayload)'
   ```

   Require `outcome: created`, `bucket: alert-disaster-vault-backups`, today's UTC `auth_object` and `manifest_object`, and positive `auth_generation`, `manifest_generation`, `auth_bytes`, and `manifest_bytes`. `copied` plus `already_present` is the evidence listing size. `failed`, a missing outcome, or a missing generation is not acceptance. If today's auth object already existed before this deploy, `already_exists` can be an honest rerun and does not prove the new image; run again on the next UTC day and require `created`.

3. Describe the two dated objects, then use the verifier below for evidence metadata.

   ```sh
   gcloud storage objects describe "gs://alert-disaster-vault-backups/auth/<YYYY-MM-DD>.json" \
     --project=alert-disaster-vault --format='yaml(bucket,name,generation,size,timeCreated)'
   gcloud storage objects describe "gs://alert-disaster-vault-backups/manifests/<YYYY-MM-DD>.json" \
     --project=alert-disaster-vault --format='yaml(bucket,name,generation,size,timeCreated)'
   ```

   Auth and manifest bucket, name, generation, and size match the log. `timeCreated` falls in this execution. Already-present copies have no new receipt and do not prove a new copy. Compare the photo receipts with the vault metadata. This reads the vault as the owner, not as the backup service account, and prints counts only:

   ```sh
   python3 ops/vault-backup/verify_vault.py --date <YYYY-MM-DD>
   ```

   Acceptance is `failed=0` and `passed` equal to `checked`, with a zero exit. Any other result is not acceptance. The owner command uses the active `gcloud` account's access token and is not included in the job image; do not grant the backup identity vault read access. An unreadable or malformed manifest prints `checked=0 passed=0 failed=1` and exits nonzero. All receipts are structurally validated before any photo metadata is fetched or comparisons are counted. The script does not print object names or checksums and does not download photo bytes. Each receipt carries `source_name`, `source_generation`, and `source_crc32c` (and `source_md5Hash` when the source had one) plus the vault object's `name`, `generation`, `size`, and `crc32c`, with `md5Hash` when the rewrite response included it. The script checks those fields against the vault object's metadata, including that the object name is `evidence/<source_generation>/<source_name>`. The next 11:15 UTC run needs its own dated auth object and manifest before the schedule counts as restored.

4. Install the alert after that first successful check, so the absence condition does not page for a job that has never succeeded. Re-run the monitoring script (it updates policies in place and does not deploy this job):

   ```sh
   bash ops/monitoring/setup-monitoring.sh --email you@example.com --dry-run
   bash ops/monitoring/setup-monitoring.sh --email you@example.com
   ```

   The policy behavior and response guidance are in [MONITORING.md](MONITORING.md).

## Restore logins

Restore was not rehearsed against the live project. The file matches the `firebase auth:import` user records.

1. Copy one day to a private machine and delete it when finished:

   ```sh
   gcloud storage cp gs://alert-disaster-vault-backups/auth/<YYYY-MM-DD>.json auth-restore.json \
     --project=alert-disaster-vault
   ```

2. In the Firebase console for `alert-disaster-field-2026`, open Authentication → Users → ⋮ → **Password hash parameters**. The import needs `base64_signer_key`, `base64_salt_separator`, `rounds`, and `mem_cost`.

3. Import. The same UID keeps Firestore ownership lined up with the account. Import overwrites an existing account with that UID.

   ```sh
   firebase auth:import auth-restore.json \
     --hash-algo=SCRYPT \
     --hash-key=<base64_signer_key> \
     --salt-separator=<base64_salt_separator> \
     --rounds=<rounds> \
     --mem-cost=<mem_cost> \
     --project=alert-disaster-field-2026
   rm -f auth-restore.json
   ```

## Restore photos

List generations for the source name, then copy the chosen generation back. The vault path is `evidence/<source-generation>/<source-object-name>`. Prefer the greatest generation unless an earlier one is the copy you want. Compare checksums before replacing a live evidence object. The backup job itself never writes to the evidence bucket.

```sh
gcloud storage ls --long --recursive \
  'gs://alert-disaster-vault-backups/evidence/**/<source-object-name>' \
  --project=alert-disaster-vault
gcloud storage cp \
  'gs://alert-disaster-vault-backups/evidence/<source-generation>/<source-object-name>' \
  ./restored-object \
  --project=alert-disaster-vault
gcloud storage cp ./restored-object \
  'gs://alert-disaster-field-2026-evidence/<source-object-name>' \
  --project=alert-disaster-field-2026
rm -f ./restored-object
```

If the live name already exists, pick a new object name or confirm the checksums before replacing it. A signature path looks like `users/<uid>/authorizations/<auth id>/<digest>/<attempt>/signature.<ext>`. A photo path looks like `users/<uid>/inspections/<inspection id>/<photo id>/<uuid>-<sha256>.<ext>`.

## Tests

`python -m pytest tests/test_vault_backup.py tests/test_verify_vault.py tests/test_monitoring_script.py -q -p no:cacheprovider`

The tests call the job module with a fake HTTP transport. They do not contact Google.
