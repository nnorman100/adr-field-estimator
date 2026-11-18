#!/usr/bin/env bash
# Restore and rollback drill kit (docs/plans/S8/S8-5.md; procedures in docs/runbook/backups.md).
#
# Owner-run only. Agents write and test this script against a recording stub (tests/
# test_restore_drill.ts); they never run it against Google Cloud.
#
#   restore-drill.sh --env test --domain <domain> --zone <zone> [--dry-run]
#       The drill, on test only. Phases, each timed:
#         1 two marker jobs made through the app, one before and one after a chosen minute
#         2 a point-in-time copy of dryscope-test-pg to that minute, into a new instance in
#           --zone, which must differ from the original's zone (a zone-outage rehearsal)
#         3 checks on the copy: migration ledger complete, first marker there, second not, row
#           counts per table; then the owner applies the data root with S8-6's
#           sql_instance_override naming the copy (the admission only) and the web app's own
#           database account logs in to the copy
#         4 backup salvage: the latest automated daily backup in location `us` restored into
#           another region, its age recorded
#         5 the field database's latest backup restored into a new database; one draft compared
#           with its rooms and photo references
#         6 one evidence object restored from soft delete and one from an earlier version
#         7 S8-6's app-root repoint on test: candidate tag, check, all traffic; then put back
#         8 the drill's own instances, database and objects removed (names ending in -drill only)
#         9 a result block to paste into the drill record
#   restore-drill.sh --env <test|live> --recovery --point-in-time <UTC time> [--dry-run]
#       Damaged rows: phases 2 and 3 without the admission; stops at the validated copy and
#       prints the row copy-back steps. Never deletes and never repoints.
#   restore-drill.sh --env <test|live> --recovery --lost-instance --point-in-time <UTC time>
#                    --zone <zone> --domain <domain> [--dry-run]
#       Zone outage: phases 2 and 3 with the admission and the app's login check, then prints the
#       app root's repoint and the tag, check and traffic commands for the owner. --zone must
#       differ from the original's zone. Never deletes.
#   restore-drill.sh --env <test|live> --recovery --salvage [--salvage-region <region>] [--dry-run]
#       Regional outage: phase 4 only (a data copy; no repoint). Never deletes.
#
# --dry-run prints every command (lines starting "+ ") and makes no call; owner steps and
# questions are listed but not waited for. Every gcloud command names its project with
# --project=. Names come from infra/dryscope/data/envs/<env>.tfvars and follow
# infra/dryscope/modules/naming. Needs: gcloud, cloud-sql-proxy (v2), psql, curl and jq, and
# your own `gcloud auth login` and `gcloud auth application-default login`, as the same account.
# The drill and --lost-instance print Terraform blocks to paste as they are: before the run,
# export TF_VAR_<name> for every variable you pass to those roots besides the env file
# (TF_VAR_api_image, TF_VAR_live_image and TF_VAR_alert_email at least; also
# TF_VAR_workload_identity_principal_set and any other you set).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$INFRA/../.." && pwd)"

die() {
  printf 'restore-drill: %s\n' "$*" >&2
  exit 2
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

ENV=""
DRY=0
RECOVERY=0
LOST=0
SALVAGE=0
DOMAIN=""
PIT=""
ZONE=""
SALVAGE_REGION="us-east1"

value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) value "$@"; ENV="$2"; shift 2 ;;
    --domain) value "$@"; DOMAIN="$2"; shift 2 ;;
    --point-in-time) value "$@"; PIT="$2"; shift 2 ;;
    --zone) value "$@"; ZONE="$2"; shift 2 ;;
    --salvage-region) value "$@"; SALVAGE_REGION="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --recovery) RECOVERY=1; shift ;;
    --lost-instance) LOST=1; shift ;;
    --salvage) SALVAGE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$ENV" in
  test | live) ;;
  *) die "--env must be test or live" ;;
esac

# The project and region come from the data root's own settings for this environment, so the
# script follows them if the live project moves (S8-8).
tfvar() {
  sed -n "s/^$1[[:space:]]*=[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$INFRA/data/envs/$ENV.tfvars"
}
PROJECT="$(tfvar project_id)"
REGION="$(tfvar region)"
[ -n "$PROJECT" ] && [ -n "$REGION" ] || die "no project_id or region in data/envs/$ENV.tfvars"

# Names, as infra/dryscope/modules/naming makes them.
SQL_SOURCE="dryscope-$ENV-pg"
SQL_DATABASE="dryscope"
FS_DB="dryscope-field-$ENV"
BUCKET="$PROJECT-evidence-$ENV"
API_SERVICE="dryscope-api-$ENV"
API_SA="dryscope-api-$ENV@$PROJECT.iam.gserviceaccount.com"
MIGRATE_SA="dryscope-migrate-$ENV@$PROJECT.iam.gserviceaccount.com"
API_DB_USER="${API_SA%.gserviceaccount.com}"
MIGRATE_DB_USER="${MIGRATE_SA%.gserviceaccount.com}"

if [ "$RECOVERY" = 0 ]; then
  MODE=drill
elif [ "$SALVAGE" = 1 ]; then
  MODE=salvage
elif [ "$LOST" = 1 ]; then
  MODE=lost-instance
else
  MODE=damaged-rows
fi

# A deleted Cloud SQL instance's name stays taken for a while, so every run stamps its own names.
# Only the drill's names end in -drill, and only names ending in -drill are ever deleted.
STAMP="$(date -u +%y%m%d%H%M)"
if [ "$MODE" = drill ]; then SUFFIX="-$STAMP-drill"; else SUFFIX="-$STAMP"; fi
SQL_COPY="$SQL_SOURCE$SUFFIX"
SQL_SALVAGE="$SQL_SOURCE-salvage$SUFFIX"
FS_COPY="$FS_DB$SUFFIX"
OBJ_SOFT="drill/$STAMP-soft-drill"
OBJ_VERSION="drill/$STAMP-version-drill"
if [ "$ENV" = test ]; then PUBLIC_HOST="test.$DOMAIN"; else PUBLIC_HOST="app.$DOMAIN"; fi
CANDIDATE_HOST="candidate.$PUBLIC_HOST"

# Mode rules. Live is touched only by the incident modes, which never delete.
if [ "$RECOVERY" = 0 ] && { [ "$LOST" = 1 ] || [ "$SALVAGE" = 1 ]; }; then
  die "--lost-instance and --salvage are incident modes: add --recovery"
fi
[ "$LOST" = 1 ] && [ "$SALVAGE" = 1 ] && die "choose one of --lost-instance and --salvage"
if [ "$ENV" = live ] && [ "$RECOVERY" = 0 ]; then
  die "the drill runs against test only; live is touched only with --recovery, which never deletes"
fi
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  die "--domain must be a plain host name such as example.com"
fi
case "$MODE" in
  drill)
    [ -z "$PIT" ] || die "the drill chooses its own minute in phase 1; leave out --point-in-time"
    ;;
  damaged-rows | lost-instance)
    [[ "$PIT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] ||
      die "--recovery needs --point-in-time in UTC, such as 2026-11-18T15:04:00Z"
    ;;
  salvage)
    [ -z "$PIT" ] || die "--salvage restores the latest daily backup; leave out --point-in-time"
    ;;
esac
# The repoint paths rehearse or recover a zone outage, so their copy goes into a named zone; the
# printed commands need the public address.
if [ "$MODE" = drill ] || [ "$MODE" = lost-instance ]; then
  [ -n "$ZONE" ] || die "--zone is required: a zone of $REGION other than the original's"
  [ -n "$DOMAIN" ] || die "--domain is required: the printed commands read health at $PUBLIC_HOST"
fi
if [ -n "$ZONE" ] && [[ ! "$ZONE" =~ ^$REGION-[a-z]$ ]]; then
  die "--zone must be a zone of $REGION, such as $REGION-b"
fi
if [[ ! "$SALVAGE_REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || [ "$SALVAGE_REGION" = "$REGION" ]; then
  die "--salvage-region must be a region other than $REGION"
fi

# Under /tmp with a short name: the Auth Proxy's socket path must stay under the 108-byte limit.
TMP="$(mktemp -d /tmp/rd.XXXXXX)"
PROXY_PID=""
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PHASE=""
PHASE_T0=0
RESULTS=()
FACTS=()
DONE=0
ACCOUNT=""
PUT_BACK=""

finish() {
  local code=$?
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  if [ "$DONE" = 0 ] && [ -n "$PHASE" ]; then
    RESULTS+=("$PHASE: $((SECONDS - PHASE_T0))s fail")
    result_block fail
    if [ -n "$PUT_BACK" ]; then
      printf '\nPut test back by hand, in this order, before anything else; delete the drill copies only after it:\n'
      printf '%s\n' "$PUT_BACK" | sed 's/^/  /'
    fi
  fi
  exit "$code"
}
trap finish EXIT

# One printed line per command, "+ " then each argument shell-quoted.
show() {
  local out="+" arg
  for arg in "$@"; do out+=" $(printf '%q' "$arg")"; done
  printf '%s\n' "$out"
}

run() {
  show "$@"
  [ "$DRY" = 1 ] || "$@"
}

# get VAR PLACEHOLDER command...: runs the command and keeps its output (never printed).
get() {
  local __var="$1" __placeholder="$2" __out
  shift 2
  show "$@"
  if [ "$DRY" = 1 ]; then
    printf -v "$__var" '%s' "$__placeholder"
  else
    __out="$("$@")" || return $?
    printf -v "$__var" '%s' "$__out"
  fi
}

# The only way this script deletes: the drill's own resources, named first and ending in -drill.
drop() {
  local name="$1"
  shift
  [ "$MODE" = drill ] || die "refusing to delete $name: only the test drill deletes"
  [[ "$name" == *-drill ]] || die "refusing to delete $name: the drill deletes only names ending in -drill"
  [[ " $* " == *"$name"* ]] || die "refusing a delete that does not name $name"
  run "$@"
}

ask() {
  local __var="$1" __question="$2" __answer
  printf '? %s\n' "$__question"
  if [ "$DRY" = 1 ]; then
    printf -v "$__var" '%s' "<$__var>"
    return 0
  fi
  read -r __answer || die "no answer"
  printf -v "$__var" '%s' "$__answer"
}

owner_step() {
  local line answer
  printf '\n>> Owner step: %s\n' "$1"
  shift
  for line in "$@"; do printf '%s\n' "$line" | sed 's/^/     /'; done
  if [ "$DRY" = 1 ]; then
    printf '     (dry run: not waited for)\n'
    return 0
  fi
  while true; do
    printf '   Type done when it has finished: '
    read -r answer || die "no answer"
    [ "$answer" = done ] && return 0
  done
}

phase() {
  PHASE="phase $1 $2"
  PHASE_T0=$SECONDS
  printf '\n== Phase %s: %s\n' "$1" "$2"
}

pass() {
  RESULTS+=("$PHASE: $((SECONDS - PHASE_T0))s pass${1:+ ($1)}")
  PHASE=""
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

result_block() {
  printf '\n----- restore-drill result -----\n'
  printf 'mode: %s\nenv: %s\nstarted: %s\n' "$MODE" "$ENV" "$STARTED"
  [ "$DRY" = 0 ] || printf 'dry run: yes\n'
  local line
  for line in "${FACTS[@]}" "${RESULTS[@]}"; do printf '%s\n' "$line"; done
  printf 'result: %s\n----- end -----\n' "$1"
}

# One command: each step runs only if the one before it passed, so nothing is applied unless the
# plan check accepted the plan, and the subshell leaves your own directory as it was.
# Your other variables come from the TF_VAR_ values you exported before the run (see the top).
tf_lines() { # root, override value or "" for emptied
  local root="$1"
  printf '%s\n' \
    "(cd $(printf '%q' "$INFRA/$root") &&" \
    "  terraform init -reconfigure -backend-config=envs/backend-$ENV.hcl &&" \
    "  terraform plan -var-file=envs/$ENV.tfvars -var sql_instance_override=$2 -out=$ENV.tfplan &&" \
    "  terraform show -json $ENV.tfplan > $ENV.json &&" \
    "  node ../scripts/check-plan.js $root $ENV $ENV.json &&" \
    "  terraform apply $ENV.tfplan)"
}

# The recorded revision serving all traffic again: tagged candidate and checked, then moved.
traffic_back_lines() {
  printf '%s\n' \
    "gcloud run services update-traffic $API_SERVICE --update-tags=candidate=$SERVING --region=$REGION --project=$PROJECT" \
    "curl -fsS https://$CANDIDATE_HOST/api/health   # must report env $ENV and database ok" \
    "gcloud run services update-traffic $API_SERVICE --to-revisions=$SERVING=100 --region=$REGION --project=$PROJECT" \
    "curl -fsS https://$PUBLIC_HOST/api/health"
}

# An RFC 3339 UTC time as text that sorts in time order; fails on anything else.
utc() {
  [[ "$1" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]{1,9}))?Z$ ]] || return 1
  local frac="${BASH_REMATCH[3]}000000000"
  printf '%s.%s' "${BASH_REMATCH[1]}" "${frac:0:9}"
}

not_after() { # time a, time b: a is not later than b
  local a b
  a="$(utc "$1")" && b="$(utc "$2")" && [[ ! "$a" > "$b" ]]
}

# The proxy listens on a Unix socket in a new directory inside this run's private temporary
# directory, so psql can only reach the proxy started here: never one left over from another
# runbook. Sets PROXY_HOST, the directory psql connects through (-h).
PROXY_N=0
proxy_start() { # connection name, extra proxy flags...
  local conn="$1" dir i
  shift
  PROXY_N=$((PROXY_N + 1))
  dir="$TMP/p$PROXY_N"
  PROXY_HOST="$dir/$conn"
  show cloud-sql-proxy "$@" --unix-socket="$dir" "$conn"
  [ "$DRY" = 0 ] || return 0
  mkdir -m 700 "$dir"
  cloud-sql-proxy "$@" --unix-socket="$dir" "$conn" >"$TMP/proxy.log" 2>&1 &
  PROXY_PID=$!
  for i in $(seq 60); do
    kill -0 "$PROXY_PID" 2>/dev/null || { sed -n '1,20p' "$TMP/proxy.log" >&2; fail "the Auth Proxy stopped"; }
    [ ! -S "$PROXY_HOST/.s.PGSQL.5432" ] || return 0
    sleep 1
  done
  fail "the Auth Proxy did not open its socket"
}

proxy_stop() {
  [ -n "$PROXY_PID" ] || return 0
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
  PROXY_PID=""
}

wait_op() { # operation name
  run gcloud sql operations wait "$1" --timeout=unlimited --project="$PROJECT"
}

# Phase 3's checks, as your own Google account through the Auth Proxy. The account is added to
# the copy only (never to the original, and with no IAM change, so nothing admits the app early)
# as an IAM database user holding the migrator's role. Row-level security is forced on every
# table, so inside one transaction the session takes the migrator's role (the tables' owner),
# lifts FORCE, reads, and rolls everything back: the copy's data is left exactly as restored.
# The ledger must be the first migrations of web/migrations with no gap and nothing unknown: a
# copy can predate a release, and the checkout can hold migrations not yet released.
db_checks() { # instance, region, marker before, marker after ("" for none)
  local instance="$1" conn="$PROJECT:$2:$1" before="$3" after="$4" out expected got level
  cat >"$TMP/checks.sql" <<'SQL'
BEGIN;
SET LOCAL ROLE :"migrator";
SELECT 'ledger|' || id FROM migration_ledger ORDER BY id;
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
\if :{?before}
SELECT 'marker_before|' || count(*) FROM jobs WHERE id = :'before'::uuid;
SELECT 'marker_after|' || count(*) FROM jobs WHERE id = :'after'::uuid;
\endif
SELECT 'rows|' || table_name || '|' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
ROLLBACK;
SQL
  local markers=()
  [ -z "$before" ] || markers=(-v "before=$before" -v "after=$after")
  [ -n "$ACCOUNT" ] || get ACCOUNT "<your-account>" gcloud config get-value account --project="$PROJECT"
  run gcloud sql users create "$ACCOUNT" --instance="$instance" --type=cloud_iam_user \
    --database-roles="$MIGRATE_DB_USER" --project="$PROJECT"
  proxy_start "$conn" --auto-iam-authn
  get out "<checks>" psql -X -A -t -q -v ON_ERROR_STOP=1 -v "migrator=$MIGRATE_DB_USER" "${markers[@]}" \
    -h "$PROXY_HOST" -U "$ACCOUNT" -d "$SQL_DATABASE" -f "$TMP/checks.sql"
  proxy_stop
  [ "$DRY" = 0 ] || return 0
  expected="$(find "$REPO/web/migrations" -maxdepth 1 -name '*.sql' -printf '%f\n' | sed 's/\.sql$//' | sort)"
  got="$(printf '%s\n' "$out" | sed -n 's/^ledger|//p' | sort)"
  [ -n "$got" ] || fail "the migration ledger on $instance is empty"
  level="$(printf '%s\n' "$got" | wc -l | tr -d ' ')"
  [ "$got" = "$(printf '%s\n' "$expected" | head -n "$level")" ] ||
    fail "the ledger on $instance is not the first $level migrations of web/migrations (pull your checkout, then compare): $(printf '%s\n' "$got" | tr '\n' ' ')"
  printf '   ledger: %s migrations, through %s\n' "$level" "$(printf '%s\n' "$got" | tail -n 1)"
  FACTS+=("ledger on $instance: through $(printf '%s\n' "$got" | tail -n 1)")
  if [ -n "$before" ]; then
    [ "$(printf '%s\n' "$out" | sed -n 's/^marker_before|//p')" = 1 ] || fail "the first marker is not on the copy"
    [ "$(printf '%s\n' "$out" | sed -n 's/^marker_after|//p')" = 0 ] || fail "the second marker is on the copy"
    printf '   markers: first there, second not\n'
  fi
  local counts
  counts="$(printf '%s\n' "$out" | sed -n 's/^rows|\([^|]*\)|\(.*\)$/\1=\2/p' | tr '\n' ' ')"
  FACTS+=("rows on $conn: ${counts% }")
}

# The web app's own database account logs in to the copy (after the data root admits it).
login_check() { # connection name
  proxy_start "$1" --auto-iam-authn --impersonate-service-account="$API_SA"
  run psql -X -A -t -q -v ON_ERROR_STOP=1 -h "$PROXY_HOST" -U "$API_DB_USER" -d "$SQL_DATABASE" -c 'SELECT 1'
  proxy_stop
}

health() { # host
  local body
  get body '{"status":"ok","env":"'"$ENV"'","database":"ok"}' curl -fsS --retry 3 "https://$1/api/health"
  [ "$DRY" = 1 ] && return 0
  printf '%s' "$body" | jq -e --arg env "$ENV" '.status == "ok" and .database == "ok" and .env == $env' >/dev/null ||
    fail "health at $1 does not report env $ENV with database ok"
  printf '   health at %s: ok, database ok\n' "$1"
}

traffic_of() { # var, tag ("" for the revision serving all traffic)
  local json
  get json '{}' gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" --format=json
  if [ "$DRY" = 1 ]; then printf -v "$1" '%s' "<${2:-serving}-revision>"; return 0; fi
  printf -v "$1" '%s' "$(printf '%s' "$json" | jq -r --arg tag "$2" '[.status.traffic[]
    | select(if $tag == "" then .percent == 100 else .tag == $tag end) | .revisionName] | first // empty')"
}

traffic_is() { # tag ("" for all traffic), revision it must reach
  local got
  traffic_of got "$1"
  [ "$DRY" = 1 ] || [ "$got" = "$2" ] || fail "${1:-all} traffic reaches ${got:-no revision}, not $2"
}

serving_revision() {
  traffic_of SERVING ""
  [ -n "$SERVING" ] || fail "no revision serves all traffic on $API_SERVICE"
}

revision_uses() { # revision, the database connection it must name
  local json got
  get json '{}' gcloud run revisions describe "$1" --region="$REGION" --project="$PROJECT" --format=json
  [ "$DRY" = 0 ] || return 0
  got="$(printf '%s' "$json" | jq -r '[.spec.containers[].env[]? | select(.name == "SQL_CONNECTION_NAME") | .value] | first // empty')"
  [ "$got" = "$2" ] || fail "revision $1 uses database ${got:-none}, not $2"
}

# The copy holds every migration applied before its point in time, and a release migrates before
# its revision exists, so a serving revision made no later than that time finds its schema there.
serving_fits_copy() {
  local created
  get created "<created>" gcloud run revisions describe "$SERVING" --region="$REGION" --project="$PROJECT" \
    --format='value(metadata.creationTimestamp)'
  [ "$DRY" = 0 ] || return 0
  not_after "$created" "$PIT" ||
    fail "revision $SERVING was made at $created, after $PIT: the copy may lack migrations it needs, so do not repoint"
}

move_to() { # revision, its database connection: tagged candidate and checked there, then given all traffic
  revision_uses "$1" "$2"
  run gcloud run services update-traffic "$API_SERVICE" --update-tags="candidate=$1" --region="$REGION" --project="$PROJECT"
  traffic_is candidate "$1"
  health "$CANDIDATE_HOST"
  run gcloud run services update-traffic "$API_SERVICE" --to-revisions="$1=100" --region="$REGION" --project="$PROJECT"
  traffic_is "" "$1"
  health "$PUBLIC_HOST"
}

preflight() {
  [ "$DRY" = 0 ] || return 0
  local tool
  for tool in gcloud cloud-sql-proxy psql curl jq; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
  done
  if [ "$MODE" = drill ] || [ "$MODE" = lost-instance ]; then
    for tool in TF_VAR_api_image TF_VAR_live_image TF_VAR_alert_email; do
      [ -n "${!tool:-}" ] || die "export $tool (and every other TF_VAR_ you pass) before the run: the printed Terraform blocks use them"
    done
  fi
  printf 'This runs mode %s against project %s, environment %s.\nType %s to go on: ' "$MODE" "$PROJECT" "$ENV" "$ENV"
  local answer
  read -r answer || die "no answer"
  [ "$answer" = "$ENV" ] || die "stopped: nothing was run"
}

# ---- phases ----

phase_markers() {
  phase 1 "two marker records"
  ask MARKER_BEFORE "Make a new job in a test company through the app now (marker 1), then paste its job id:"
  local now
  now="$(date -u +%s)"
  PIT_EPOCH=$(((now / 60 + 2) * 60))
  PIT="$(date -u -d "@$PIT_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$PIT_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
  printf '   chosen minute: %s\n' "$PIT"
  if [ "$DRY" = 0 ]; then
    printf '   waiting until 30 seconds after it...\n'
    sleep $((PIT_EPOCH + 30 - $(date -u +%s)))
  fi
  ask MARKER_AFTER "Make a second new job through the app now (marker 2), then paste its job id:"
  local id
  for id in "$MARKER_BEFORE" "$MARKER_AFTER"; do
    [ "$DRY" = 1 ] || [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "a job id is a uuid"
  done
  FACTS+=("point in time: $PIT" "markers: $MARKER_BEFORE before, $MARKER_AFTER after")
  pass
}

phase_copy() {
  phase 2 "point-in-time copy of $SQL_SOURCE to $PIT"
  local zone=() op latest i source_zone copy_zone
  [ -z "$ZONE" ] || zone=(--preferred-zone="$ZONE")
  # A zone recovery's copy must not land in the original's zone. In a real zone outage the
  # original may not answer; then only the copy's own zone is checked below.
  if [ "$MODE" = drill ] || [ "$MODE" = lost-instance ]; then
    if get source_zone "<original-zone>" gcloud sql instances describe "$SQL_SOURCE" --project="$PROJECT" \
      --format='value(gceZone)'; then
      [ "$DRY" = 1 ] || [ -n "$source_zone" ] || fail "no zone reported for $SQL_SOURCE"
      [ "$source_zone" != "$ZONE" ] || fail "--zone $ZONE is the zone of $SQL_SOURCE: choose another zone of $REGION"
    else
      [ "$MODE" = lost-instance ] || fail "could not read the zone of $SQL_SOURCE"
      printf '   %s does not answer; only the copy'"'"'s zone is checked.\n' "$SQL_SOURCE"
      source_zone=""
    fi
  fi
  # The drill waits for its chosen minute to become recoverable; an incident time must already be.
  for i in $(seq 20); do
    get latest "$PIT" gcloud sql instances get-latest-recovery-time "$SQL_SOURCE" --project="$PROJECT" \
      --format='value(latestRecoveryTime)'
    [ "$DRY" = 0 ] || break
    not_after "$PIT" "$latest" && break
    { [ "$MODE" = drill ] && [ "$i" -lt 20 ]; } ||
      fail "$PIT is not recoverable: the latest recoverable time of $SQL_SOURCE is $latest"
    sleep 30
  done
  get op "<operation>" gcloud sql instances clone "$SQL_SOURCE" "$SQL_COPY" --point-in-time="$PIT" "${zone[@]}" \
    --project="$PROJECT" --async --format='value(name)'
  wait_op "$op"
  if [ -n "$ZONE" ]; then
    get copy_zone "$ZONE" gcloud sql instances describe "$SQL_COPY" --project="$PROJECT" --format='value(gceZone)'
    [ "$copy_zone" = "$ZONE" ] || fail "the copy $SQL_COPY is in zone ${copy_zone:-unknown}, not $ZONE"
    FACTS+=("copy: $SQL_COPY in $ZONE${source_zone:+ (original in $source_zone)}")
  else
    FACTS+=("copy: $SQL_COPY")
  fi
  pass
}

phase_checks() { # admit: 1 to apply the data root's admission and check the app's login
  phase 3 "checks on the copy"
  db_checks "$SQL_COPY" "$REGION" "${MARKER_BEFORE:-}" "${MARKER_AFTER:-}"
  if [ "$1" = 1 ]; then
    [ "$MODE" != drill ] || PUT_BACK="$(tf_lines data "")"
    owner_step "apply the data root with the copy admitted (S8-6; the services stay on $SQL_SOURCE)" \
      "$(tf_lines data "$SQL_COPY")"
    printf '   Your account needs Service Account Token Creator on %s for this login check.\n' "$API_SA"
    login_check "$PROJECT:$REGION:$SQL_COPY"
  fi
  pass
}

phase_salvage() {
  phase 4 "backup salvage into $SALVAGE_REGION"
  local json name start op age
  # Project-level list: works while the instance's region is down (backups.md).
  get json '[]' gcloud sql backups list --project="$PROJECT" --filter="instance=$SQL_SOURCE" --format=json
  if [ "$DRY" = 1 ]; then
    name="<backup-name>"
    age="<age>"
  else
    # The latest automated daily backup, never an on-demand or final one taken later.
    read -r name start < <(printf '%s' "$json" | jq -r '[.[] | select(.type == "AUTOMATED" and .state == "SUCCESSFUL"
      and .location == "us")] | sort_by(.backupInterval.startTime) | last | select(. != null)
      | "\(.name) \(.backupInterval.startTime)"') ||
      fail "no successful automated backup in location us for $SQL_SOURCE"
    age="$(jq -nr --arg t "$start" '(now - ($t | sub("\\.[0-9]+"; "") | fromdateiso8601)) / 60 | floor | "\(. / 60 | floor)h\(. % 60)m"')"
  fi
  get op "<operation>" gcloud sql backups restore "$name" --restore-instance="$SQL_SALVAGE" \
    --region="$SALVAGE_REGION" --project="$PROJECT" --async --format='value(name)'
  wait_op "$op"
  db_checks "$SQL_SALVAGE" "$SALVAGE_REGION" "" ""
  FACTS+=("salvage copy: $SQL_SALVAGE in $SALVAGE_REGION, backup age $age")
  pass "backup age $age"
}

fs_get() { # var, database id, path under documents/. The token goes to a private header file,
  # never to a command line.
  local hdr="$TMP/auth-header" token
  if [ ! -s "$hdr" ]; then
    get token "<token>" gcloud auth print-access-token --project="$PROJECT"
    (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$hdr")
  fi
  get "$1" '{}' curl -fsS -H "@$hdr" \
    "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$2/documents/$3"
}

# One draft as the app loads it (web/src/lib/field/store.ts, loadDraft): the draft document and
# its rooms and photos subcollections, each document by id with its fields, in one canonical
# form. Fails if a read fails, the draft is missing, or a list does not fit in one page.
draft_snapshot() { # var, database id
  local doc rooms photos snapshot
  fs_get doc "$2" "$DRAFT" || return 1
  fs_get rooms "$2" "$DRAFT/rooms?pageSize=300" || return 1
  fs_get photos "$2" "$DRAFT/photos?pageSize=300" || return 1
  if [ "$DRY" = 1 ]; then printf -v "$1" '%s' '{}'; return 0; fi
  snapshot="$(jq -cnS --argjson d "$doc" --argjson r "$rooms" --argjson p "$photos" '
    def docs($list): if $list.nextPageToken then error("more than one page")
      else [($list.documents // [])[] | {id: (.name | split("/") | last), fields: (.fields // {})}] | sort_by(.id) end;
    if ($d.fields | type) != "object" then error("no draft") else
      {draft: $d.fields, rooms: docs($r), photos: docs($p)} end')" || return 1
  printf -v "$1" '%s' "$snapshot"
}

phase_field() {
  phase 5 "field database restore"
  local json name snap original restored i rooms photos
  get json '[]' gcloud firestore backups list --location="$REGION" --project="$PROJECT" --format=json
  if [ "$DRY" = 1 ]; then
    name="<backup-name>"
    snap="<snapshot-time>"
  else
    read -r name snap < <(printf '%s' "$json" | jq -r --arg db "projects/$PROJECT/databases/$FS_DB" \
      '[.[] | select(.database == $db and .state == "READY")] | sort_by(.snapshotTime) | last | select(. != null)
      | "\(.name) \(.snapshotTime)"') || fail "no ready backup of $FS_DB"
  fi
  run gcloud firestore databases restore --source-backup="$name" --destination-database="$FS_COPY" --project="$PROJECT"
  ask DRAFT "Path of one field draft that has not changed since $snap: companies/<company id>/drafts/<draft id>"
  [ "$DRY" = 1 ] || [[ "$DRAFT" =~ ^companies/[A-Za-z0-9_-]+/drafts/[A-Za-z0-9_-]+$ ]] ||
    die "a draft path is companies/<company id>/drafts/<draft id>"
  draft_snapshot original "$FS_DB" || fail "could not read the draft, its rooms and photos from $FS_DB"
  for i in $(seq 120); do
    if draft_snapshot restored "$FS_COPY" 2>/dev/null; then break; fi
    [ "$i" -lt 120 ] || fail "the restored database did not answer with the draft within an hour"
    sleep 30
  done
  if [ "$DRY" = 0 ]; then
    [ "$original" = "$restored" ] ||
      fail "the restored draft differs from the original (its fields, rooms or photo references, by id)"
    rooms="$(printf '%s' "$original" | jq '.rooms | length')"
    photos="$(printf '%s' "$original" | jq '.photos | length')"
    printf '   draft: same fields, %s rooms and %s photo references, by id\n' "$rooms" "$photos"
  fi
  printf '   Note: a restored database starts with deny-all rules and without its expiry (TTL) policies.\n'
  FACTS+=("field copy: $FS_COPY from the backup at $snap")
  pass "draft matches"
}

phase_files() {
  phase 6 "evidence files: soft delete and earlier version"
  local soft="gs://$BUCKET/$OBJ_SOFT" version="gs://$BUCKET/$OBJ_VERSION" gen md5 v1md5 now
  printf 'dryscope drill %s v1\n' "$STAMP" >"$TMP/v1"
  printf 'dryscope drill %s v2\n' "$STAMP" >"$TMP/v2"
  # Soft delete: with versioning on, a delete makes the live object noncurrent; deleting that
  # generation soft-deletes it.
  run gcloud storage cp "$TMP/v1" "$soft" --project="$PROJECT"
  get gen "<generation>" gcloud storage objects describe "$soft" --project="$PROJECT" --format='value(generation)'
  get md5 "<md5>" gcloud storage objects describe "$soft" --project="$PROJECT" --format='value(md5_hash)'
  run gcloud storage rm "$soft" --project="$PROJECT"
  run gcloud storage rm "$soft#$gen" --project="$PROJECT"
  run gcloud storage restore "$soft#$gen" --project="$PROJECT"
  get now "<md5>" gcloud storage objects describe "$soft" --project="$PROJECT" --format='value(md5_hash)'
  [ "$now" = "$md5" ] || fail "the object restored from soft delete differs"
  # Earlier version: copy generation 1 back over the live object.
  run gcloud storage cp "$TMP/v1" "$version" --project="$PROJECT"
  get gen "<generation>" gcloud storage objects describe "$version" --project="$PROJECT" --format='value(generation)'
  get v1md5 "<md5>" gcloud storage objects describe "$version" --project="$PROJECT" --format='value(md5_hash)'
  run gcloud storage cp "$TMP/v2" "$version" --project="$PROJECT"
  run gcloud storage cp "$version#$gen" "$version" --project="$PROJECT"
  get now "<md5>" gcloud storage objects describe "$version" --project="$PROJECT" --format='value(md5_hash)'
  [ "$now" = "$v1md5" ] || fail "the object put back from its earlier version differs"
  pass "both restored"
}

phase_repoint() {
  phase 7 "repoint on test, then put back"
  serving_revision
  FACTS+=("recorded revision: $SERVING")
  serving_fits_copy
  PUT_BACK="$(traffic_back_lines)
$(tf_lines app "")
$(tf_lines data "")"
  owner_step "apply the app root pointing the services at the copy (S8-6)" "$(tf_lines app "$SQL_COPY")"
  local fresh
  get fresh "<fresh-revision>" gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" \
    --format='value(status.latestCreatedRevisionName)'
  [ "$DRY" = 1 ] || [ "$fresh" != "$SERVING" ] || fail "the app-root apply made no fresh revision"
  move_to "$fresh" "$PROJECT:$REGION:$SQL_COPY"
  printf '   Putting back: the recorded revision serves again before any admission is removed.\n'
  move_to "$SERVING" "$PROJECT:$REGION:$SQL_SOURCE"
  PUT_BACK="$(tf_lines app "")
$(tf_lines data "")"
  owner_step "apply the app root with the override emptied" "$(tf_lines app "")"
  PUT_BACK="$(tf_lines data "")"
  owner_step "apply the data root with the override emptied (removes the admission)" "$(tf_lines data "")"
  PUT_BACK=""
  pass "fresh revision $fresh"
}

phase_cleanup() {
  phase 8 "remove the drill's own resources"
  local name
  for name in "$SQL_COPY" "$SQL_SALVAGE"; do
    drop "$name" gcloud sql instances patch "$name" --no-deletion-protection --project="$PROJECT" --quiet
    drop "$name" gcloud sql instances delete "$name" --project="$PROJECT" --quiet
  done
  drop "$FS_COPY" gcloud firestore databases delete --database="$FS_COPY" --project="$PROJECT" --quiet
  for name in "$OBJ_SOFT" "$OBJ_VERSION"; do
    drop "$name" gcloud storage rm --all-versions "gs://$BUCKET/$name" --project="$PROJECT"
  done
  printf '   The removed objects stay in soft delete for 7 days; the instance names stay taken for a while.\n'
  pass
}

print_copy_back() {
  cat <<EOF

The validated copy is $SQL_COPY. Nothing was repointed and nothing was deleted.
Copy back only the damaged rows (docs/runbook/backups.md, "Damaged rows"):
  1. Read the damaged rows by company id and id from the copy, through the Auth Proxy as
     $ACCOUNT with SET ROLE to the migrator and FORCE lifted inside a transaction that is
     rolled back (as these checks did), and the same rows on $SQL_SOURCE as the migrator.
  2. Never write a signed record or a guarded table's rows (the guard triggers refuse it; never
     disable one). A damaged signed record is an owner decision, recorded in a sidecar.
  3. On $SQL_SOURCE, as the migrator (the way db:migrate is run), one transaction per table:
       BEGIN;
       ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;
       UPDATE <table> ... WHERE company_id = '<company id>' AND id IN (<damaged ids>);
       -- psql prints UPDATE <n>: unless n is exactly the number of ids, ROLLBACK;
       ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
       COMMIT;
     Rows written since $PIT stay.
  4. Run the records check for each company (operator screen, "Check records").
  5. Delete $SQL_COPY only when you decide to; this script never does.
EOF
}

print_repoint() {
  local sql="$PROJECT:$REGION:$SQL_COPY" rev='.status.traffic[] | select(.percent == 100) | .revisionName'
  cat <<EOF

The copy $SQL_COPY passed its checks and the web app's account logs in to it.
The revision serving now is $SERVING. Repoint the app (S8-6), then move traffic only after
each check prints what its comment says:
$(tf_lines app "$SQL_COPY" | sed 's/^/  /')
  FRESH="\$(gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format='value(status.latestCreatedRevisionName)')"
  gcloud run revisions describe "\$FRESH" --region=$REGION --project=$PROJECT --format=json | jq -r '.spec.containers[].env[]? | select(.name == "SQL_CONNECTION_NAME") | .value'   # must print $sql
  gcloud run services update-traffic $API_SERVICE --update-tags="candidate=\$FRESH" --region=$REGION --project=$PROJECT
  gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format=json | jq -r '.status.traffic[] | select(.tag == "candidate") | .revisionName'   # must print \$FRESH
  curl -fsS https://$CANDIDATE_HOST/api/health   # must report env $ENV and database ok
  gcloud run services update-traffic $API_SERVICE --to-revisions="\$FRESH=100" --region=$REGION --project=$PROJECT
  gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format=json | jq -r '$rev'   # must print \$FRESH
  curl -fsS https://$PUBLIC_HOST/api/health
Keep the recovered database serving; a return to the original is a separate owner decision.
Your account $ACCOUNT stays a user of $SQL_COPY with the migrator's role until you remove it.
EOF
}

preflight
case "$MODE" in
  drill)
    phase_markers
    phase_copy
    phase_checks 1
    phase_salvage
    phase_field
    phase_files
    phase_repoint
    phase_cleanup
    ;;
  damaged-rows)
    FACTS+=("point in time: $PIT")
    phase_copy
    phase_checks 0
    print_copy_back
    ;;
  lost-instance)
    FACTS+=("point in time: $PIT")
    phase_copy
    phase_checks 1
    serving_revision
    serving_fits_copy
    print_repoint
    ;;
  salvage)
    phase_salvage
    ;;
esac
phase 9 "result"
pass
DONE=1
result_block pass
