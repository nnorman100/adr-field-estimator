#!/usr/bin/env bash
# Restore and rollback drill kit (docs/plans/S8/S8-5.md; procedures in docs/runbook/backups.md).
#
# Owner-run only. Agents write and test this script against a recording stub (tests/
# test_restore_drill.ts); they never run it against Google Cloud.
#
#   restore-drill.sh --env test --domain <domain> [--zone <zone>] [--dry-run]
#       The drill, on test only. Phases, each timed:
#         1 two marker jobs made through the app, one before and one after a chosen minute
#         2 a point-in-time copy of dryscope-test-pg to that minute, into a new instance
#         3 checks on the copy: migration ledger complete, first marker there, second not, row
#           counts per table; then the owner applies the data root with S8-6's
#           sql_instance_override naming the copy (the admission only) and the web app's own
#           database account logs in to the copy
#         4 backup salvage: the latest `us` backup restored into another region, its age recorded
#         5 the field database's latest backup restored into a new database, one draft compared
#         6 one evidence object restored from soft delete and one from an earlier version
#         7 S8-6's app-root repoint on test: candidate tag, check, all traffic; then put back
#         8 the drill's own instances, database and objects removed (names ending in -drill only)
#         9 a result block to paste into the drill record
#   restore-drill.sh --env <test|live> --recovery --point-in-time <UTC time> [--dry-run]
#       Damaged rows: phases 2 and 3 without the admission; stops at the validated copy and
#       prints the row copy-back steps. Never deletes and never repoints.
#   restore-drill.sh --env <test|live> --recovery --lost-instance --point-in-time <UTC time>
#                    --zone <zone> [--domain <domain>] [--dry-run]
#       Zone outage: phases 2 and 3 with the admission and the app's login check, then prints the
#       app root's repoint and the tag, check and traffic commands for the owner. Never deletes.
#   restore-drill.sh --env <test|live> --recovery --salvage [--salvage-region <region>] [--dry-run]
#       Regional outage: phase 4 only (a data copy; no repoint). Never deletes.
#   restore-drill.sh --env <test|live> --print-names
#       Prints the resource names this script uses, then stops. Makes no call.
#
# --dry-run prints every command (lines starting "+ ") and makes no call; owner steps and
# questions are listed but not waited for. Every gcloud command names its project with
# --project=. Names come from infra/dryscope/data/envs/<env>.tfvars and follow
# infra/dryscope/modules/naming. Needs: gcloud, cloud-sql-proxy (v2), psql, curl and jq, and
# your own `gcloud auth login` and `gcloud auth application-default login`.
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
PRINT_NAMES=0
DOMAIN=""
PIT=""
ZONE=""
SALVAGE_REGION="us-east1"
PORT=5433

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
    --port) value "$@"; PORT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --recovery) RECOVERY=1; shift ;;
    --lost-instance) LOST=1; shift ;;
    --salvage) SALVAGE=1; shift ;;
    --print-names) PRINT_NAMES=1; shift ;;
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
if [ "$ENV" = test ]; then PUBLIC_HOST="test.${DOMAIN:-<domain>}"; else PUBLIC_HOST="app.${DOMAIN:-<domain>}"; fi
CANDIDATE_HOST="candidate.$PUBLIC_HOST"

if [ "$PRINT_NAMES" = 1 ]; then
  cat <<EOF
project=$PROJECT
region=$REGION
sql_instance_name=$SQL_SOURCE
sql_connection_name=$PROJECT:$REGION:$SQL_SOURCE
sql_database_name=$SQL_DATABASE
firestore_database_id=$FS_DB
evidence_bucket=$BUCKET
api_service=$API_SERVICE
api_service_account=$API_SA
migrate_service_account=$MIGRATE_SA
sql_copy=$SQL_COPY
sql_salvage_copy=$SQL_SALVAGE
firestore_copy=$FS_COPY
EOF
  exit 0
fi

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
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] || die "--port must be a number"
case "$MODE" in
  drill)
    [ -n "$DOMAIN" ] || die "the drill needs --domain (it reads health at test.<domain>)"
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
if [ "$MODE" = lost-instance ] || [ -n "$ZONE" ]; then
  [[ "$ZONE" =~ ^$REGION-[a-z]$ ]] || die "--zone must be a zone of $REGION, such as $REGION-b"
fi
if [[ ! "$SALVAGE_REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || [ "$SALVAGE_REGION" = "$REGION" ]; then
  die "--salvage-region must be a region other than $REGION"
fi

TMP="$(mktemp -d)"
PROXY_PID=""
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PHASE=""
PHASE_T0=0
RESULTS=()
FACTS=()
DONE=0

finish() {
  local code=$?
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
  if [ "$DONE" = 0 ] && [ -n "$PHASE" ]; then
    RESULTS+=("$PHASE: $((SECONDS - PHASE_T0))s fail")
    result_block fail
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

tf_lines() { # root, override value or "" for emptied
  local root="$1" var="-var sql_instance_override=$2"
  [ -n "$2" ] || var="(no sql_instance_override: leave it out, it is empty by default)"
  printf '%s\n' \
    "cd infra/dryscope/$root && terraform init -reconfigure -backend-config=envs/backend-$ENV.hcl" \
    "terraform plan -var-file=envs/$ENV.tfvars <the other -var you always pass for this root> $var -out=$ENV.tfplan" \
    "terraform show -json $ENV.tfplan > $ENV.json && node ../scripts/check-plan.js $root $ENV $ENV.json" \
    "terraform apply $ENV.tfplan"
}

proxy_start() { # connection name, port, extra proxy flags...
  local conn="$1" port="$2" i
  shift 2
  show cloud-sql-proxy "$@" --port="$port" "$conn"
  [ "$DRY" = 0 ] || return 0
  cloud-sql-proxy "$@" --port="$port" "$conn" >"$TMP/proxy.log" 2>&1 &
  PROXY_PID=$!
  for i in $(seq 60); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then return 0; fi
    kill -0 "$PROXY_PID" 2>/dev/null || { sed -n '1,20p' "$TMP/proxy.log" >&2; fail "the Auth Proxy stopped"; }
    sleep 1
  done
  fail "the Auth Proxy did not open port $port"
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

# Phase 3's checks, as the built-in postgres user through the Auth Proxy (your own credentials).
# Row-level security is forced on every table, so inside one transaction the session takes the
# migrator's role (the tables' owner), lifts FORCE, reads, and rolls everything back: the copy is
# left exactly as restored.
db_checks() { # connection name, marker before, marker after ("" for none)
  local conn="$1" before="$2" after="$3" out expected got missing extra counts
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
  printf '   psql asks for the postgres password (or set it in ~/.pgpass); it is never stored here.\n'
  proxy_start "$conn" "$PORT"
  get out "<checks>" psql -X -A -t -q -v ON_ERROR_STOP=1 -v "migrator=$MIGRATE_DB_USER" "${markers[@]}" \
    -h 127.0.0.1 -p "$PORT" -U postgres -d "$SQL_DATABASE" -f "$TMP/checks.sql"
  proxy_stop
  [ "$DRY" = 0 ] || return 0
  expected="$(find "$REPO/web/migrations" -maxdepth 1 -name '*.sql' -printf '%f\n' | sed 's/\.sql$//' | sort)"
  got="$(printf '%s\n' "$out" | sed -n 's/^ledger|//p' | sort)"
  missing="$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$got") | tr '\n' ' ')"
  extra="$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$got") | tr '\n' ' ')"
  [ -z "$missing$extra" ] || fail "migration ledger differs from web/migrations: missing [$missing] extra [$extra]"
  printf '   ledger: all %s migrations\n' "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')"
  if [ -n "$before" ]; then
    [ "$(printf '%s\n' "$out" | sed -n 's/^marker_before|//p')" = 1 ] || fail "the first marker is not on the copy"
    [ "$(printf '%s\n' "$out" | sed -n 's/^marker_after|//p')" = 0 ] || fail "the second marker is on the copy"
    printf '   markers: first there, second not\n'
  fi
  counts="$(printf '%s\n' "$out" | sed -n 's/^rows|\([^|]*\)|\(.*\)$/\1=\2/p' | tr '\n' ' ')"
  FACTS+=("rows on $conn: ${counts% }")
}

# The web app's own database account logs in to the copy (after the data root admits it).
login_check() { # connection name
  local port=$((PORT + 1))
  proxy_start "$1" "$port" --auto-iam-authn --impersonate-service-account="$API_SA"
  run psql -X -A -t -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U "$API_DB_USER" -d "$SQL_DATABASE" -c 'SELECT 1'
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

serving_revision() {
  local json
  get json '{}' gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" --format=json
  if [ "$DRY" = 1 ]; then SERVING="<serving-revision>"; return 0; fi
  SERVING="$(printf '%s' "$json" | jq -r '[.status.traffic[] | select(.percent == 100) | .revisionName] | first // empty')"
  [ -n "$SERVING" ] || fail "no revision serves all traffic on $API_SERVICE"
}

move_to() { # revision: tagged candidate and checked there, then given all traffic
  run gcloud run services update-traffic "$API_SERVICE" --update-tags="candidate=$1" --region="$REGION" --project="$PROJECT"
  health "$CANDIDATE_HOST"
  run gcloud run services update-traffic "$API_SERVICE" --to-revisions="$1=100" --region="$REGION" --project="$PROJECT"
  health "$PUBLIC_HOST"
}

preflight() {
  [ "$DRY" = 0 ] || return 0
  local tool
  for tool in gcloud cloud-sql-proxy psql curl jq; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
  done
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
  local zone=() op
  [ -z "$ZONE" ] || zone=(--preferred-zone="$ZONE")
  get op "<operation>" gcloud sql instances clone "$SQL_SOURCE" "$SQL_COPY" --point-in-time="$PIT" "${zone[@]}" \
    --project="$PROJECT" --async --format='value(name)'
  wait_op "$op"
  FACTS+=("copy: $SQL_COPY")
  pass
}

phase_checks() { # admit: 1 to apply the data root's admission and check the app's login
  phase 3 "checks on the copy"
  db_checks "$PROJECT:$REGION:$SQL_COPY" "${MARKER_BEFORE:-}" "${MARKER_AFTER:-}"
  if [ "$1" = 1 ]; then
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
    read -r name start < <(printf '%s' "$json" | jq -r '[.[] | select(.state == "SUCCESSFUL" and .location == "us")]
      | sort_by(.backupInterval.startTime) | last | select(. != null) | "\(.name) \(.backupInterval.startTime)"') ||
      fail "no successful backup in location us for $SQL_SOURCE"
    age="$(jq -nr --arg t "$start" '(now - ($t | sub("\\.[0-9]+"; "") | fromdateiso8601)) / 60 | floor | "\(. / 60 | floor)h\(. % 60)m"')"
  fi
  get op "<operation>" gcloud sql backups restore "$name" --restore-instance="$SQL_SALVAGE" \
    --region="$SALVAGE_REGION" --project="$PROJECT" --async --format='value(name)'
  wait_op "$op"
  db_checks "$PROJECT:$SALVAGE_REGION:$SQL_SALVAGE" "" ""
  FACTS+=("salvage copy: $SQL_SALVAGE in $SALVAGE_REGION, backup age $age")
  pass "backup age $age"
}

fs_read() { # var, database id. The token goes to a private header file, never to a command line.
  local hdr="$TMP/auth-header" token
  if [ ! -s "$hdr" ]; then
    get token "<token>" gcloud auth print-access-token --project="$PROJECT"
    (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$hdr")
  fi
  get "$1" '{}' curl -fsS -H "@$hdr" \
    "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$2/documents/$DRAFT"
}

phase_field() {
  phase 5 "field database restore"
  local json name snap original restored i
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
  ask DRAFT "Path of one field draft that has not changed since $snap (under documents/):"
  [ "$DRY" = 1 ] || [[ "$DRAFT" =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+)*$ ]] ||
    die "a draft path is collection/id pairs"
  fs_read original "$FS_DB"
  for i in $(seq 120); do
    if fs_read restored "$FS_COPY" 2>/dev/null; then break; fi
    [ "$i" -lt 120 ] || fail "the restored database did not answer within an hour"
    sleep 30
  done
  if [ "$DRY" = 0 ]; then
    [ "$(printf '%s' "$original" | jq -S .fields | sha256sum)" = "$(printf '%s' "$restored" | jq -S .fields | sha256sum)" ] ||
      fail "the restored draft differs from the original"
    printf '   draft: same fields in the restored copy\n'
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
  owner_step "apply the app root pointing the services at the copy (S8-6)" "$(tf_lines app "$SQL_COPY")"
  local fresh
  get fresh "<fresh-revision>" gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" \
    --format='value(status.latestCreatedRevisionName)'
  [ "$DRY" = 1 ] || [ "$fresh" != "$SERVING" ] || fail "the app-root apply made no fresh revision"
  move_to "$fresh"
  printf '   Putting back: the recorded revision serves again before any admission is removed.\n'
  move_to "$SERVING"
  owner_step "apply the app root with the override emptied" "$(tf_lines app "")"
  owner_step "apply the data root with the override emptied (removes the admission)" "$(tf_lines data "")"
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
  1. Through the Auth Proxy on the copy and on $SQL_SOURCE, export the damaged rows by id from the
     copy and compare them with the same ids on $SQL_SOURCE.
  2. Write back only those rows by id, as the migrator, in one transaction; rows written since
     $PIT stay.
  3. Run the records check for each company (operator screen, "Check records").
  4. Delete $SQL_COPY only when you decide to; this script never does.
EOF
}

print_repoint() {
  cat <<EOF

The copy $SQL_COPY passed its checks and the web app's account logs in to it.
Repoint the app (S8-6), then move traffic only after the candidate check passes:
$(tf_lines app "$SQL_COPY" | sed 's/^/  /')
  gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format=json   # record the serving revision
  gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format='value(status.latestCreatedRevisionName)'
  gcloud run services update-traffic $API_SERVICE --update-tags=candidate=<fresh revision> --region=$REGION --project=$PROJECT
  curl -fsS https://$CANDIDATE_HOST/api/health   # must report env $ENV and database ok
  gcloud run services update-traffic $API_SERVICE --to-revisions=<fresh revision>=100 --region=$REGION --project=$PROJECT
  curl -fsS https://$PUBLIC_HOST/api/health
Keep the recovered database serving; a return to the original is a separate owner decision.
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
