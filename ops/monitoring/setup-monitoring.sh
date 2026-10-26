#!/usr/bin/env bash
# One-time setup of DryScope uptime checks, error alerts and alert emails.
# Review it, then run it yourself (see docs/MONITORING.md):
#   bash ops/monitoring/setup-monitoring.sh --email you@example.com --dry-run
#   bash ops/monitoring/setup-monitoring.sh --email you@example.com --confirm
# It is safe to re-run: the existing channel and uptime check are kept and alert policies are
# updated in place. It never deletes anything, grants IAM roles, enables APIs or changes billing.
set -euo pipefail

PROJECT=alert-disaster-field-2026
HOST=alert-disaster-field-2026.web.app # Firebase Hosting site; /api/** rewrites to the Cloud Run service
SERVICE=alert-disaster-field-estimator
SERVICE_REGION=us-west2
EMAIL='' DRY_RUN=0 CONFIRM=0 CONFIG_DIR=''

usage() {
  cat <<EOF
Usage: bash ops/monitoring/setup-monitoring.sh --email ADDRESS [options]

  --email ADDRESS   Where alert emails go (required)
  --dry-run         Print every command and config without signing in or changing anything
  --confirm         Create without the typed confirmation (needed when there is no terminal)
  --config-dir DIR  Keep the generated config files in DIR
EOF
}
die() { echo "setup-monitoring: $*" >&2; exit 1; }
json_quotes() { local s="$1"; printf '%s' "${s//\"/\\\"}"; } # escape " for a JSON string

while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="${2:-}"; shift 2 ;;
    --config-dir) CONFIG_DIR="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --confirm) CONFIRM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$EMAIL" ] || { usage >&2; die '--email is required.'; }
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "not an email address: $EMAIL"

if [ -n "$CONFIG_DIR" ]; then mkdir -p "$CONFIG_DIR"; else CONFIG_DIR=$(mktemp -d); trap 'rm -rf "$CONFIG_DIR"' EXIT; fi

# Every change goes through run, so --dry-run shows exactly what a real run would do.
run() {
  printf '+ gcloud'; printf ' %q' "$@" --project="$PROJECT"; printf '\n'
  if [ "$DRY_RUN" = 0 ]; then gcloud "$@" --project="$PROJECT"; fi
}
# Read-only lookups. A dry run makes none and treats everything as new.
read_gcloud() { if [ "$DRY_RUN" = 0 ]; then gcloud "$@" --project="$PROJECT"; fi; }
show_config() { if [ "$DRY_RUN" = 1 ]; then cat "$1"; fi; }

# --- Checks before anything changes -----------------------------------------
if [ "$DRY_RUN" = 0 ]; then
  command -v gcloud >/dev/null || die 'gcloud is not installed. Install the Google Cloud CLI first.'
  gcloud beta --help >/dev/null 2>&1 || die 'the gcloud beta commands are missing. Run: gcloud components install beta'
  ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1)
  [ -n "$ACCOUNT" ] || die 'no gcloud login. Run: gcloud auth login'
  gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null 2>&1 ||
    die "$ACCOUNT cannot open project $PROJECT. Sign in as its owner."
  ENABLED=$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)')
  for api in monitoring.googleapis.com logging.googleapis.com; do
    grep -qx "$api" <<<"$ENABLED" || die "$api is not enabled. Run: gcloud services enable $api --project=$PROJECT"
  done
  gcloud run services describe "$SERVICE" --region="$SERVICE_REGION" --project="$PROJECT" --format='value(metadata.name)' >/dev/null 2>&1 ||
    die "Cloud Run service $SERVICE was not found in $SERVICE_REGION."
else
  ACCOUNT='(dry run: no sign-in checked)'
fi

# --- What this creates -------------------------------------------------------
UPTIME_NAME='DryScope: API health'
UPTIME_PATH=/api/health
UPTIME_BODY=healthy # /api/health answers {"status": "healthy", ...}
POLICIES=(site-down server-errors vertex-errors live-provider-errors email-send-failed email-delivery-failed drying-reminder-failed drying-summary-failed email-volume)

cat <<EOF
Project:  $PROJECT (signed in as $ACCOUNT)
Alerts to: $EMAIL
Site:     https://$HOST (Cloud Run service $SERVICE in $SERVICE_REGION)

This will create, or update if they already exist:
  - 1 email notification channel to $EMAIL
  - 1 uptime check every 5 minutes from 3 US regions: $UPTIME_PATH -> 200 containing "$UPTIME_BODY"
  - ${#POLICIES[@]} alert policies (see docs/MONITORING.md for each one)
It does not delete anything, grant IAM roles, enable APIs or change billing.
The existing budget alert is left unchanged.
EOF

if [ "$DRY_RUN" = 0 ] && [ "$CONFIRM" = 0 ]; then
  [ -t 0 ] || die 'no terminal to confirm in. Review the list above, then re-run with --confirm.'
  read -r -p "Type yes to create these in $PROJECT: " answer
  [ "$answer" = yes ] || die 'stopped; nothing was changed.'
fi
echo

# --- Email channel ----------------------------------------------------------
CHANNEL=$(read_gcloud beta monitoring channels list --filter="type=\"email\" AND labels.email_address=\"$EMAIL\"" --format='value(name)' | head -n 1)
if [ -n "$CHANNEL" ]; then
  echo "Email channel exists: $CHANNEL"
else
  run beta monitoring channels create --type=email --display-name="DryScope alerts ($EMAIL)" \
    --channel-labels=email_address="$EMAIL" --user-labels=managed-by=dryscope-monitoring
  CHANNEL=$(read_gcloud beta monitoring channels list --filter="type=\"email\" AND labels.email_address=\"$EMAIL\"" --format='value(name)' | head -n 1)
  if [ "$DRY_RUN" = 1 ]; then CHANNEL="projects/$PROJECT/notificationChannels/NEW_EMAIL_CHANNEL"; fi
  [ -n "$CHANNEL" ] || die 'the email channel was not found after creating it.'
fi

# --- Uptime check -----------------------------------------------------------
CHECK_ID=$(read_gcloud monitoring uptime list-configs --filter="displayName=\"$UPTIME_NAME\"" --format='value(name)' | head -n 1)
if [ -n "$CHECK_ID" ]; then
  echo "Uptime check exists: $UPTIME_NAME"
else
  # shellcheck disable=SC2054 # the commas belong to gcloud flag values
  run monitoring uptime create "$UPTIME_NAME" --resource-type=uptime-url --resource-labels="host=$HOST,project_id=$PROJECT" \
    --protocol=https --path="$UPTIME_PATH" --status-codes=200 --period=5 --timeout=10 \
    --regions=usa-iowa,usa-oregon,usa-virginia --matcher-content="$UPTIME_BODY" --matcher-type=contains-string \
    --user-labels=managed-by=dryscope-monitoring
  CHECK_ID=$(read_gcloud monitoring uptime list-configs --filter="displayName=\"$UPTIME_NAME\"" --format='value(name)' | head -n 1)
  if [ "$DRY_RUN" = 1 ]; then CHECK_ID="projects/$PROJECT/uptimeCheckConfigs/NEW_CHECK"; fi
  [ -n "$CHECK_ID" ] || die "uptime check \"$UPTIME_NAME\" was not found after creating it."
fi
CHECK_ID=${CHECK_ID##*/}

# --- Alert policies ---------------------------------------------------------
# Log filters match only fields the backend writes (backend/cloud_log.py LOG_FIELDS).
CLOUD_RUN="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\""
RUN_METRIC="metric.type=\\\"run.googleapis.com"
RUN_SERVICE="resource.type=\\\"cloud_run_revision\\\" AND resource.label.service_name=\\\"$SERVICE\\\""

policy() { # file key, display name, documentation, conditions (JSON list), alert strategy extra
  cat >"$CONFIG_DIR/policy-$1.json" <<EOF
{
  "displayName": "$2",
  "documentation": {"mimeType": "text/markdown", "content": "$(json_quotes "$3")\n\nDetails: docs/MONITORING.md in the adr-field-estimator repository."},
  "userLabels": {"managed-by": "dryscope-monitoring"},
  "combiner": "OR",
  "conditions": $4,
  "notificationChannels": ["$CHANNEL"],
  "alertStrategy": {$5"autoClose": "86400s"}
}
EOF
}
log_condition() { # condition name, log filter
  echo "[{\"displayName\": \"$1\", \"conditionMatchedLog\": {\"filter\": \"$(json_quotes "$2")\"}}]"
}
LOG_RATE='"notificationRateLimit": {"period": "3600s"}, ' # at most one email per hour per log alert

policy site-down 'DryScope: health check failing' \
  '**What it means:** /api/health stopped answering 200 with "healthy" from at least two regions.\n\n**What to do:** open the site, then check the Cloud Run service alert-disaster-field-estimator (us-west2) and its latest revision. Roll traffic back if it started with a deploy.' \
  "[{\"displayName\": \"Uptime check failing\", \"conditionThreshold\": {
    \"filter\": \"metric.type=\\\"monitoring.googleapis.com/uptime_check/check_passed\\\" AND resource.type=\\\"uptime_url\\\" AND metric.label.check_id=\\\"$CHECK_ID\\\"\",
    \"aggregations\": [{\"alignmentPeriod\": \"1200s\", \"perSeriesAligner\": \"ALIGN_NEXT_OLDER\", \"crossSeriesReducer\": \"REDUCE_COUNT_FALSE\", \"groupByFields\": [\"resource.label.host\"]}],
    \"comparison\": \"COMPARISON_GT\", \"thresholdValue\": 1, \"duration\": \"60s\", \"trigger\": {\"count\": 1}}}]" ''
policy server-errors 'DryScope: server errors' \
  '**What it means:** more than 5 requests to the backend failed with a 5xx in 10 minutes.\n\n**What to do:** open Logs Explorer for the service and filter severity>=ERROR. If it started with a deploy, roll back.' \
  "[{\"displayName\": \"More than 5 5xx responses in 10 minutes\", \"conditionThreshold\": {
    \"filter\": \"$RUN_METRIC/request_count\\\" AND $RUN_SERVICE AND metric.label.response_code_class=\\\"5xx\\\"\",
    \"aggregations\": [{\"alignmentPeriod\": \"600s\", \"perSeriesAligner\": \"ALIGN_SUM\", \"crossSeriesReducer\": \"REDUCE_SUM\", \"groupByFields\": []}],
    \"comparison\": \"COMPARISON_GT\", \"thresholdValue\": 5, \"duration\": \"0s\", \"trigger\": {\"count\": 1}}}]" ''
policy vertex-errors 'DryScope: Vertex AI call failed' \
  '**What it means:** an audit, OCR, scope or voice-transcription model call failed or timed out, or a scope suggestion failed grounding checks (log line "Vertex AI call" at ERROR; outcome validation is a rejected scope suggestion; transcription uses operation transcribe). The line has the model, operation, outcome and provider status only.\n\n**What to do:** read provider_status, provider_code and outcome in the log line. A technician sees a retry message; check the Vertex AI quota and status page if it repeats. After a release that changes this filter, run this script again so the alert updates.' \
  "$(log_condition 'Vertex AI call logged an error' "$CLOUD_RUN AND jsonPayload.message=\"Vertex AI call\" AND severity>=ERROR")" "$LOG_RATE"
policy live-provider-errors 'DryScope: Live provider failed' \
  '**What it means:** a Live session ended with provider code 429 (rate limit), 401, 403 or 404 (provider auth or model configuration), an SDK 5xx error, an abnormal upstream WebSocket closure (1006, 1011 or 1013), or a provider timeout logged as 1006. Normal session endings do not alert. Ordinary client auth and input rejections have no provider code and do not page.\n\n**What to do:** check provider_code in the log, Vertex AI availability and quotas. The technician can reconnect with the preserved draft. After a release that changes this filter, run this script again so the alert updates.' \
  "$(log_condition 'Live provider failure' "$CLOUD_RUN AND jsonPayload.operation=\"live\" AND severity>=WARNING AND CAST(jsonPayload.provider_code, STRING)=~\"^(429|401|403|404|5[0-9]{2}|1006|1011|1013)$\"")" "$LOG_RATE"
policy email-send-failed 'DryScope: email send failed' \
  '**What it means:** an invitation email send failed. The ERROR log contains only the failure class.\n\n**What to do:** check the email transport configuration, credentials and provider status; retry the invitation after correcting the failure.' \
  "$(log_condition 'Email send failed' "$CLOUD_RUN AND jsonPayload.operation=\"email\" AND jsonPayload.status=\"send_failed\" AND severity>=ERROR")" "$LOG_RATE"
policy email-delivery-failed 'DryScope: document email failed' \
  '**What it means:** a document delivery email ended as failed (log line "Delivery entry" with status failed; the line has the delivery ID and recipient role, never an address).\n\n**What to do:** check the Gmail SMTP account and app password and the daily send limit. The entry stays retryable unless the outcome was unconfirmed.' \
  "$(log_condition 'Delivery entry failed' "$CLOUD_RUN AND jsonPayload.operation=\"delivery\" AND jsonPayload.status=\"failed\"")" "$LOG_RATE"
policy drying-reminder-failed 'DryScope: drying reminder failed' \
  'A human-approved drying reminder failed. Check the sender and retry only entries marked retryable. Logs contain status and reminder ID only.' \
  "$(log_condition 'Drying reminder failed' "$CLOUD_RUN AND jsonPayload.operation=\"reminder\" AND jsonPayload.status=\"failed\"")" "$LOG_RATE"
policy drying-summary-failed 'DryScope: drying summary rejected' \
  'The drying summary validator refused a model output. Recorded facts remain visible; retry the summary and review the staged evaluation before enabling the feature.' \
  "$(log_condition 'Drying summary rejected' "$CLOUD_RUN AND jsonPayload.operation=\"drying_watch\" AND jsonPayload.outcome=\"invalid\" AND severity>=ERROR")" "$LOG_RATE"
policy email-volume 'DryScope: daily email count high' \
  '**What it means:** the service sent more than 400 emails in its 24-hour window, near the Gmail limit.\n\n**What to do:** expect invitations or documents to be refused by Gmail until the window resets. Check for a send loop.' \
  "$(log_condition 'Daily email count passed the warning level' "$CLOUD_RUN AND jsonPayload.operation=\"email\" AND jsonPayload.status=\"daily_warning\"")" "$LOG_RATE"

for p in "${POLICIES[@]}"; do
  file="$CONFIG_DIR/policy-$p.json"
  show_config "$file"
  name=$(sed -n 's/^  "displayName": "\(.*\)",$/\1/p' "$file")
  existing=$(read_gcloud monitoring policies list --filter="displayName=\"$name\"" --format='value(name)' | head -n 1)
  if [ -n "$existing" ]; then run monitoring policies update "$existing" --policy-from-file="$file"
  else run monitoring policies create --policy-from-file="$file"; fi
done

cat <<EOF

Done. Google sends a verification email to $EMAIL; confirm it or alerts are not delivered.
Then send a test notification (docs/MONITORING.md): Monitoring > Alerting > Notification channels.
EOF
