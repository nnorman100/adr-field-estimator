#!/usr/bin/env bash
# One-time, owner-run setup for .github/workflows/deploy.yml. Safe to re-run: every step checks or
# is idempotent. It creates no key files and sets no GitHub secrets. It prints the two GitHub
# repository variables to set; the workflow reads its identifiers from them.
#
#   scripts/setup_auto_deploy.sh --dry-run   # print every change without making it
#   scripts/setup_auto_deploy.sh             # apply (needs gcloud signed in as a project owner)
#
# Roles come from reading scripts/deploy_backend.py, auto_deploy.py, ensure_firestore_ttls.py and the
# Hosting deploy. Failures before promotion are safe, so a missing permission shows up as a failed
# run, not a bad release; see docs/firebase-isolation.md, "Automatic deploys".
set -euo pipefail

PROJECT=alert-disaster-field-2026
PROJECT_NUMBER=545776254070
REGION=us-west2
REPO=nnorman100/adr-field-estimator
POOL=github-actions
PROVIDER=adr-field-estimator
DEPLOYER=adr-deployer
DEPLOYER_EMAIL="$DEPLOYER@$PROJECT.iam.gserviceaccount.com"
RUNTIME_EMAIL="adr-runtime@$PROJECT.iam.gserviceaccount.com"
BUILDER_EMAIL="adr-builder@$PROJECT.iam.gserviceaccount.com"
SOURCE_BUCKET="run-sources-$PROJECT-$REGION"

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# Print the command; run it unless this is a dry run.
do_it() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if [ "$DRY_RUN" -eq 0 ]; then "$@"; fi
}
# True when the read-only describe command succeeds; a dry run assumes nothing exists yet.
exists() {
  [ "$DRY_RUN" -eq 0 ] && "$@" >/dev/null 2>&1
}

echo "== APIs"
do_it gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PROJECT"

echo "== Deploy service account (no keys are created)"
if ! exists gcloud iam service-accounts describe "$DEPLOYER_EMAIL" --project="$PROJECT"; then
  do_it gcloud iam service-accounts create "$DEPLOYER" \
    --display-name="GitHub Actions production deploy" --project="$PROJECT"
fi

echo "== Workload Identity pool and provider, limited to this repository and master"
if ! exists gcloud iam workload-identity-pools describe "$POOL" \
  --location=global --project="$PROJECT"; then
  do_it gcloud iam workload-identity-pools create "$POOL" \
    --location=global --display-name="GitHub Actions" --project="$PROJECT"
fi
CONDITION="assertion.repository == '$REPO' && assertion.ref == 'refs/heads/master' && (assertion.job_workflow_ref.startsWith('$REPO/.github/workflows/deploy.yml@') || assertion.job_workflow_ref.startsWith('$REPO/.github/workflows/rollback.yml@'))"
PROVIDER_ARGS=(
  --location=global --workload-identity-pool="$POOL" --project="$PROJECT"
  --issuer-uri=https://token.actions.githubusercontent.com
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository"
  --attribute-condition="$CONDITION"
)
if exists gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --location=global --workload-identity-pool="$POOL" --project="$PROJECT"; then
  do_it gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}"
else
  do_it gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}"
fi

echo "== Let the repository's workflow act as the deploy account"
do_it gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" \
  --project="$PROJECT" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO"

echo "== Project roles for the deploy account"
# run.developer: deploy a revision, move traffic, read the service and its revisions.
# cloudbuild.builds.editor, logging.viewer: gcloud run deploy --source builds and streams the log.
# serviceusage.serviceUsageConsumer: API calls billed to the project.
# firebasehosting.admin, firebase.viewer: firebase deploy --only hosting and the live release lookup.
# datastore.viewer: the read-only TTL policy check. Nothing here can change rules, indexes or TTLs.
for role in roles/run.developer roles/cloudbuild.builds.editor roles/logging.viewer \
  roles/serviceusage.serviceUsageConsumer roles/firebasehosting.admin roles/firebase.viewer \
  roles/datastore.viewer; do
  do_it gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$DEPLOYER_EMAIL" --role="$role" --condition=None --quiet
done

echo "== Act as the runtime and build accounts, and only those"
for account in "$RUNTIME_EMAIL" "$BUILDER_EMAIL"; do
  do_it gcloud iam service-accounts add-iam-policy-binding "$account" \
    --project="$PROJECT" --role=roles/iam.serviceAccountUser \
    --member="serviceAccount:$DEPLOYER_EMAIL"
done

echo "== Source upload bucket (gcloud run deploy --source), on that bucket only"
if [ "$DRY_RUN" -eq 1 ] || exists gcloud storage buckets describe "gs://$SOURCE_BUCKET" --project="$PROJECT"; then
  do_it gcloud storage buckets add-iam-policy-binding "gs://$SOURCE_BUCKET" \
    --member="serviceAccount:$DEPLOYER_EMAIL" --role=roles/storage.objectAdmin
else
  echo "(bucket gs://$SOURCE_BUCKET not found; the first manual or automatic deploy creates it."
  echo " Re-run this script afterwards to bind it.)"
fi

echo "== Artifact Registry (source builds push the image), on the existing repository only"
if [ "$DRY_RUN" -eq 1 ] || exists gcloud artifacts repositories describe cloud-run-source-deploy \
  --location="$REGION" --project="$PROJECT"; then
  do_it gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy \
    --location="$REGION" --project="$PROJECT" \
    --member="serviceAccount:$DEPLOYER_EMAIL" --role=roles/artifactregistry.writer
else
  echo "(repository cloud-run-source-deploy not found in $REGION; re-run after the first deploy.)"
fi

PROVIDER_NAME="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
cat <<MSG

== Set these GitHub repository variables (Settings > Secrets and variables > Actions > Variables)
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo $REPO --body '$PROVIDER_NAME'
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo $REPO --body '$DEPLOYER_EMAIL'

== Prove the setup without deploying: run the Deploy workflow by hand (workflow_dispatch) with
   AUTO_DEPLOY_ENABLED set to true; it only runs the refusal checks. Then leave the variable at true.
gh variable set AUTO_DEPLOY_ENABLED --repo $REPO --body true
MSG
