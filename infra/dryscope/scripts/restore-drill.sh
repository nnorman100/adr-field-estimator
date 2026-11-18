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
#   restore-drill.sh --env live --recovery --point-in-time <UTC time> [--dry-run]
#       Damaged rows: phases 2 and 3 without the admission; stops at the validated copy and
#       prints the row copy-back steps. Never deletes and never repoints.
#   restore-drill.sh --env live --recovery --lost-instance --point-in-time <UTC time>
#                    --zone <zone> --domain <domain> [--dry-run]
#       Zone outage: phases 2 and 3 with the admission and the app's login check; once you confirm
#       access on the copy is reconciled, prints the app root's repoint and the tag, check and
#       traffic commands. --zone must differ from the original's zone. Never deletes.
#   restore-drill.sh --env live --recovery --salvage [--salvage-region <US region>] [--dry-run]
#       Regional outage: phase 4 only (a data copy, in another US region; no repoint). Never deletes.
#   The incident modes run on live only; test rehearses them with the drill. --domain is for the
#   drill and --lost-instance, --salvage-region for the drill and --salvage; every copy gets a new
#   name to the second, and the run refuses a destination that already exists.
#
# Any access the run gives your own account (a database user on a copy, holding the migrator's
# role, for the checks) is temporary: it is removed as soon as the checks end and on every exit.
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
# The Cloud SDK's own log files would keep tokens and your account name from these commands.
export CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1

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
SALVAGE_REGION_SET=0

value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) value "$@"; ENV="$2"; shift 2 ;;
    --domain) value "$@"; DOMAIN="$2"; shift 2 ;;
    --point-in-time) value "$@"; PIT="$2"; shift 2 ;;
    --zone) value "$@"; ZONE="$2"; shift 2 ;;
    --salvage-region) value "$@"; SALVAGE_REGION="$2"; SALVAGE_REGION_SET=1; shift 2 ;;
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
STAMP="$(date -u +%y%m%d%H%M%S)"
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
if [ "$ENV" = test ] && [ "$RECOVERY" = 1 ]; then
  die "the incident modes (--recovery) are for live; rehearse them on test with the drill"
fi
if [ -n "$DOMAIN" ] && [ "$MODE" != drill ] && [ "$MODE" != lost-instance ]; then
  die "--domain is only for the drill and --lost-instance"
fi
if [ "$SALVAGE_REGION_SET" = 1 ] && [ "$MODE" != drill ] && [ "$MODE" != salvage ]; then
  die "--salvage-region is only for the drill and --salvage"
fi
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
if [ -n "$ZONE" ] && [ "$MODE" != drill ] && [ "$MODE" != lost-instance ]; then
  die "--zone is only for the drill and --lost-instance: a damaged-rows or salvage copy needs no zone"
fi
if [ -n "$ZONE" ] && [[ ! "$ZONE" =~ ^$REGION-[a-z]$ ]]; then
  die "--zone must be a zone of $REGION, such as $REGION-b"
fi
# Records stay in the US (docs/runbook/backups.md; the lawyer checklist's data-residency question).
if [[ ! "$SALVAGE_REGION" =~ ^us-[a-z]+[0-9]+$ ]] || [ "$SALVAGE_REGION" = "$REGION" ]; then
  die "--salvage-region must be a US region other than $REGION, such as us-east1"
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
MARKER_COMPANY="<company>"
SERVING_IMAGES=""
RELEASE_COMMIT=""
RUNNING=0
GRANTS=()
PENDING_GRANT=""

finish() {
  local code=$?
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  revoke_all || [ "$code" != 0 ] || code=1
  rm -rf "$TMP"
  # Every run that started prints its result block, a failed one too.
  if [ "$DONE" = 0 ] && [ "$RUNNING" = 1 ]; then
    if [ -n "$PHASE" ]; then
      RESULTS+=("$PHASE: $((SECONDS - PHASE_T0))s fail")
    else
      RESULTS+=("stopped between phases: fail")
    fi
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
  local out="+" arg quoted
  for arg in "$@"; do
    [ -z "$ACCOUNT" ] || arg="${arg//"$ACCOUNT"/<your-account>}"
    printf -v quoted '%q' "$arg"
    out+=" $quoted"
  done
  printf '%s\n' "$out"
}

# Your account's name never reaches the transcript: every line of the input with it masked.
redact() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$ACCOUNT" ] || line="${line//"$ACCOUNT"/<your-account>}"
    printf '%s\n' "$line"
  done
}

# Runs the command; with MASK=1 (the commands that act as or on your account) its messages go
# through redact. Its output and exit status are its own.
call() {
  if [ "${MASK:-0}" = 1 ]; then
    { "$@" 2>&1 1>&3 3>&- | redact >&2; } 3>&1
  else
    "$@"
  fi
}

run() {
  show "$@"
  [ "$DRY" = 1 ] || call "$@"
}

# get VAR PLACEHOLDER command...: runs the command and keeps its output (never printed).
get() {
  local __var="$1" __placeholder="$2" __out
  shift 2
  show "$@"
  if [ "$DRY" = 1 ]; then
    printf -v "$__var" '%s' "$__placeholder"
  else
    __out="$(call "$@")" || return $?
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

# shellcheck source=restore-drill-print.sh
source "$HERE/restore-drill-print.sh"

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
    kill -0 "$PROXY_PID" 2>/dev/null || { sed -n '1,20p' "$TMP/proxy.log" | redact >&2; fail "the Auth Proxy stopped"; }
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

# Your account's temporary database user on a copy, listed only once this run created it: removed
# right after the checks and, through finish, on every exit. If a removal fails, the exact command
# is printed for you to run and the run fails. A create whose outcome is unknown (it failed or was
# interrupted) is never removed, since the user may have been there before; it is reported instead.
revoke_all() {
  local instance left=0
  if [ -n "$PENDING_GRANT" ]; then
    printf 'Your temporary access to %s may have been created: check gcloud sql users list --instance=%s --project=%s and, if your account is listed and was not there before this run, remove it: gcloud sql users delete "$(gcloud config get-value account --project=%s)" --instance=%s --project=%s --quiet\n' \
      "$PENDING_GRANT" "$PENDING_GRANT" "$PROJECT" "$PROJECT" "$PENDING_GRANT" "$PROJECT" >&2
    PENDING_GRANT=""
    left=1
  fi
  for instance in "${GRANTS[@]}"; do
    if ! MASK=1 run gcloud sql users delete "$ACCOUNT" --instance="$instance" --project="$PROJECT" --quiet; then
      printf 'Remove your temporary access to %s by hand now: gcloud sql users delete "$(gcloud config get-value account --project=%s)" --instance=%s --project=%s --quiet\n' \
        "$instance" "$PROJECT" "$instance" "$PROJECT" >&2
      left=1
    fi
  done
  GRANTS=()
  [ "$left" = 0 ]
}

auth_header() { # a fresh token in a private header file, never on a command line
  local token
  get token "<token>" gcloud auth print-access-token --project="$PROJECT" || return 1
  (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$TMP/auth-header")
}

# The release's drain rule (web/scripts/release-drain.ts; S8-2): stage a revision only once 15
# minutes have passed since the service last changed, since a revision that lost traffic can keep an
# idle instance holding database connections that long.
DRAIN_JQ='(.updateTime | (capture("^(?<s>[^.]+)(?<f>\\.[0-9]+)?Z$") // error("updateTime is not a UTC time")) | (.s + "Z" | fromdateiso8601) + ("0" + (.f // "") | tonumber)) + 900 - $now | if . < 0 then 0 elif . > 900 then 900 else ceil end'
SERVICE_URL="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/services/$API_SERVICE"

drain_wait() {
  local json left i
  for i in 1 2 3; do
    auth_header || fail "could not get a token"
    get json '{}' curl -fsS -H "@$TMP/auth-header" "$SERVICE_URL" || fail "could not read when $API_SERVICE last changed"
    [ "$DRY" = 0 ] || return 0
    left="$(printf '%s' "$json" | jq -r --argjson now "$(date -u +%s)" "$DRAIN_JQ")" ||
      fail "could not read when $API_SERVICE last changed"
    [ "$left" -gt 0 ] || return 0
    [ "$i" -lt 3 ] || fail "$API_SERVICE keeps changing: stage nothing until it has been still for 15 minutes"
    printf '   waiting %ss before staging: a revision that lost traffic can hold database connections for 15 minutes\n' "$left"
    sleep "$left"
  done
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
SELECT 'ledger|' || id || '|' || checksum FROM migration_ledger ORDER BY id;
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
SELECT 'marker_company|' || company_id FROM jobs WHERE id = :'before'::uuid;
SELECT 'marker_after|' || count(*) FROM jobs
WHERE company_id IN (SELECT company_id FROM jobs WHERE id = :'before'::uuid) AND id = :'after'::uuid;
\endif
SELECT 'rows|' || table_name || '|' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
ROLLBACK;
SQL
  local markers=()
  [ -z "$before" ] || markers=(-v "before=$before" -v "after=$after")
  [ -n "$ACCOUNT" ] || get ACCOUNT "<your-account>" gcloud config get-value account --project="$PROJECT"
  [ "$DRY" = 1 ] || PENDING_GRANT="$instance"
  MASK=1 run gcloud sql users create "$ACCOUNT" --instance="$instance" --type=cloud_iam_user \
    --database-roles="$MIGRATE_DB_USER" --project="$PROJECT"
  PENDING_GRANT=""
  GRANTS+=("$instance")
  proxy_start "$conn" --auto-iam-authn
  MASK=1 get out "<checks>" psql -X -A -t -q -v ON_ERROR_STOP=1 -v "migrator=$MIGRATE_DB_USER" "${markers[@]}" \
    -h "$PROXY_HOST" -U "$ACCOUNT" -d "$SQL_DATABASE" -f "$TMP/checks.sql"
  proxy_stop
  revoke_all || fail "your temporary access to $instance was not removed: remove it by hand as printed above"
  [ "$DRY" = 0 ] || return 0
  # Each row as id|checksum (the SHA-256 of the file's bytes, as web/src/db/migrate.ts records it).
  expected="$(ledger_of_checkout)"
  got="$(printf '%s\n' "$out" | sed -n 's/^ledger|//p' | sort)"
  [ -n "$got" ] || fail "the migration ledger on $instance is empty"
  level="$(printf '%s\n' "$got" | wc -l | tr -d ' ')"
  [ "$got" = "$(printf '%s\n' "$expected" | head -n "$level")" ] ||
    fail "the ledger on $instance (id and checksum) is not the first $level migrations of web/migrations (pull your checkout, then compare): $(printf '%s\n' "$got" | cut -d'|' -f1 | tr '\n' ' ')"
  # Damaged rows: exactly the original's ledger as it stood at the restore point.
  if [ "$MODE" = damaged-rows ] && [ "$got" != "$LEDGER_AT_PIT" ]; then
    # Its time is when the migration started: the newest, missing alone, may have been committing.
    [ "$(printf '%s\n' "$LEDGER_AT_PIT" | sed '$d')" != "$got" ] || [ -z "$LEDGER_RECENT" ] ||
      [ "$(printf '%s\n' "$LEDGER_AT_PIT" | tail -n 1 | cut -d'|' -f1)" != "$LEDGER_RECENT" ] ||
      fail "the copy lacks only migration $LEDGER_RECENT, which started within 15 minutes before $PIT and may still have been committing then: stop, and choose a minute when no migration ran"
    fail "the ledger on $instance is not the ledger of $SQL_SOURCE at $PIT (every migration applied by then, with its checksum)"
  fi
  # Up to the restore point: every migration of the release serving then, with the same checksums.
  if [ -n "$RELEASE_COMMIT" ]; then
    local release
    release="$(ledger_of_commit "$RELEASE_COMMIT")" ||
      fail "could not read the migrations of commit $RELEASE_COMMIT from your checkout"
    [ "$(printf '%s\n' "$got" | head -n "$(printf '%s\n' "$release" | wc -l)")" = "$release" ] ||
      fail "the ledger on $instance lacks or differs from the migrations of the release serving at the restore point (commit $RELEASE_COMMIT)"
  fi
  printf '   ledger: %s migrations with their checksums, through %s\n' "$level" "$(printf '%s\n' "$got" | tail -n 1 | cut -d'|' -f1)"
  FACTS+=("ledger on $instance: through $(printf '%s\n' "$got" | tail -n 1 | cut -d'|' -f1)")
  if [ -n "$before" ]; then
    [ "$(printf '%s\n' "$out" | sed -n 's/^marker_before|//p')" = 1 ] || fail "the first marker is not on the copy"
    [ "$(printf '%s\n' "$out" | sed -n 's/^marker_after|//p')" = 0 ] || fail "the second marker is on the copy"
    MARKER_COMPANY="$(printf '%s\n' "$out" | sed -n 's/^marker_company|//p')"
    printf '   markers: first there, second not\n'
  fi
  local counts
  counts="$(printf '%s\n' "$out" | sed -n 's/^rows|\([^|]*\)|\(.*\)$/\1=\2/p' | tr '\n' ' ')"
  FACTS+=("rows on $conn: ${counts% }")
}

# Damaged rows: the original is up, so the release at the restore point is its own ledger then:
# every migration applied by that minute, read as the migrator (Service Account Token Creator on
# it) in a read-only transaction.
LEDGER_AT_PIT=""
LEDGER_RECENT=""
ledger_at_pit() {
  printf '%s\n' 'BEGIN READ ONLY;' \
    "SELECT 'ledger|' || id || '|' || checksum FROM migration_ledger WHERE applied_at <= :'pit'::timestamptz ORDER BY id;" \
    "SELECT 'recent|' || max(id) FROM migration_ledger WHERE applied_at <= :'pit'::timestamptz AND applied_at > :'pit'::timestamptz - interval '15 minutes' HAVING count(*) > 0;" \
    'ROLLBACK;' >"$TMP/ledger.sql"
  printf '   Your account needs Service Account Token Creator on %s to read its ledger on %s.\n' "$MIGRATE_SA" "$SQL_SOURCE"
  proxy_start "$PROJECT:$REGION:$SQL_SOURCE" --auto-iam-authn --impersonate-service-account="$MIGRATE_SA"
  get LEDGER_AT_PIT "" psql -X -A -t -q -v ON_ERROR_STOP=1 -v "pit=$PIT" -h "$PROXY_HOST" -U "$MIGRATE_DB_USER" \
    -d "$SQL_DATABASE" -f "$TMP/ledger.sql"
  proxy_stop
  LEDGER_RECENT="$(printf '%s\n' "$LEDGER_AT_PIT" | sed -n 's/^recent|//p')"
  LEDGER_AT_PIT="$(printf '%s\n' "$LEDGER_AT_PIT" | sed -n 's/^ledger|//p' | sort)"
  [ "$DRY" = 1 ] || [ -n "$LEDGER_AT_PIT" ] || fail "no migration of $SQL_SOURCE was applied by $PIT"
}

# The release serving now, from its health answer (a 503 one too, while its database is down):
# releases are paused in the drill, and a zone recovery's copy is checked against the release that
# was serving, so its migrations are the ones the copy must hold.
serving_commit() {
  local body
  get body '{}' curl -sS --retry 3 "https://$PUBLIC_HOST/api/health" || fail "could not read health at $PUBLIC_HOST"
  [ "$DRY" = 0 ] || return 0
  RELEASE_COMMIT="$(printf '%s' "$body" | jq -r '.commit // empty')"
  [[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "health at $PUBLIC_HOST reports no commit"
  git -C "$REPO" cat-file -e "$RELEASE_COMMIT^{commit}" 2>/dev/null ||
    fail "commit $RELEASE_COMMIT is not in your checkout: git fetch, then run again"
  FACTS+=("release serving: commit $RELEASE_COMMIT")
}

# The web app's own database account logs in to the copy (after the data root admits it).
# A new IAM grant can take minutes to apply after Terraform reports it, so the login is retried
# every 30 seconds for up to 10 minutes.
login_check() { # connection name
  local i
  proxy_start "$1" --auto-iam-authn --impersonate-service-account="$API_SA"
  for i in $(seq 20); do
    if run psql -X -A -t -q -v ON_ERROR_STOP=1 -h "$PROXY_HOST" -U "$API_DB_USER" -d "$SQL_DATABASE" -c 'SELECT 1'; then
      proxy_stop
      return 0
    fi
    [ "$i" -lt 20 ] || { proxy_stop; fail "the web app's account could not log in to $1 within 10 minutes of the admission"; }
    printf '   login refused; the admission can take minutes to apply: trying again in 30s\n'
    sleep 30
  done
}

# A copy goes only into a destination that does not exist yet: a restore would replace its data.
must_be_new() { # instance
  if get _ "" gcloud sql instances describe "$1" --project="$PROJECT" --format='value(name)' 2>/dev/null; then
    [ "$DRY" = 1 ] || fail "$1 already exists: the run never restores over an existing instance"
  fi
}

# Both markers on the original, read as the web app's own account in the first marker's company
# inside a read-only transaction: the first made no later than the chosen minute, the second after.
markers_on_original() {
  local out
  cat >"$TMP/markers.sql" <<'SQL'
BEGIN READ ONLY;
SET LOCAL app.company_id = :'company';
SELECT count(*) FILTER (WHERE id = :'before'::uuid AND created_at <= :'pit'::timestamptz) || '|' ||
       count(*) FILTER (WHERE id = :'after'::uuid AND created_at > :'pit'::timestamptz)
FROM jobs WHERE id IN (:'before'::uuid, :'after'::uuid);
ROLLBACK;
SQL
  proxy_start "$PROJECT:$REGION:$SQL_SOURCE" --auto-iam-authn --impersonate-service-account="$API_SA"
  get out "1|1" psql -X -A -t -q -v ON_ERROR_STOP=1 -v "company=$MARKER_COMPANY" -v "before=$MARKER_BEFORE" \
    -v "after=$MARKER_AFTER" -v "pit=$PIT" -h "$PROXY_HOST" -U "$API_DB_USER" -d "$SQL_DATABASE" -f "$TMP/markers.sql"
  proxy_stop
  [ "$out" = "1|1" ] ||
    fail "the markers are not both on $SQL_SOURCE in one company, the first made by $PIT and the second after it"
  printf '   markers on %s: first by the chosen minute, second after it\n' "$SQL_SOURCE"
}

health() { # base address, https://...
  local body
  get body '{"status":"ok","env":"'"$ENV"'","database":"ok"}' curl -fsS --retry 3 "$1/api/health"
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

revision_images() { # revision JSON: its container images, in order, as one line
  printf '%s' "$1" | jq -c '[.spec.containers[].image]'
}

# A revision may take traffic only if it names the right database and runs the recorded revision's
# images: Terraform keeps the service template's image, which can be a later release's.
revision_uses() { # revision, the database connection it must name
  local json got images
  get json '{}' gcloud run revisions describe "$1" --region="$REGION" --project="$PROJECT" --format=json
  [ "$DRY" = 0 ] || return 0
  got="$(printf '%s' "$json" | jq -r '[.spec.containers[].env[]? | select(.name == "SQL_CONNECTION_NAME") | .value] | first // empty')"
  [ "$got" = "$2" ] || fail "revision $1 uses database ${got:-none}, not $2"
  images="$(revision_images "$json")"
  [ "$images" = "$SERVING_IMAGES" ] ||
    fail "revision $1 runs $images, not the recorded revision's $SERVING_IMAGES: it may need migrations the copy lacks, so do not move traffic to it"
}

# The copy holds every migration applied before its point in time, and a release migrates before
# its revision exists, so a serving revision made no later than that time finds its schema there.
# Records the serving revision's images: the only ones a repointed revision may run.
serving_fits_copy() {
  local json created
  get json '{}' gcloud run revisions describe "$SERVING" --region="$REGION" --project="$PROJECT" --format=json
  if [ "$DRY" = 1 ]; then SERVING_IMAGES="<serving-images>"; return 0; fi
  created="$(printf '%s' "$json" | jq -r '.metadata.creationTimestamp // empty')"
  SERVING_IMAGES="$(revision_images "$json")"
  not_after "$created" "$PIT" ||
    fail "revision $SERVING was made at ${created:-an unknown time}, after $PIT: the copy may lack migrations it needs, so do not repoint"
}

move_to() { # revision, its database connection: tagged candidate and checked there, then given all traffic
  revision_uses "$1" "$2"
  run gcloud run services update-traffic "$API_SERVICE" --update-tags="candidate=$1" --region="$REGION" --project="$PROJECT"
  traffic_is candidate "$1"
  health "https://$CANDIDATE_HOST"
  run gcloud run services update-traffic "$API_SERVICE" --to-revisions="$1=100" --region="$REGION" --project="$PROJECT"
  traffic_is "" "$1"
  health "https://$PUBLIC_HOST"
}

# A zone recovery's repoint is printed only once access on the copy matches every change made after
# the restore point, so no traffic can move to roles or homeowner links that were since withdrawn.
reconcile_access() {
  printf '\n>> Owner step: reconcile access on %s before any traffic moves\n' "$SQL_COPY"
  print_reconcile
  ask RECONCILED "Type reconciled once every access change made after $PIT is on $SQL_COPY, or none if there was none:"
  [ "$DRY" = 1 ] || [ "$RECONCILED" = reconciled ] || [ "$RECONCILED" = none ] ||
    fail "access on $SQL_COPY is not reconciled with the changes made after $PIT: no repoint is printed"
  FACTS+=("access on $SQL_COPY: $RECONCILED")
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
  ask MARKER_AFTER "Make a second new job in the same company through the app now (marker 2), then paste its job id:"
  local id
  for id in "$MARKER_BEFORE" "$MARKER_AFTER"; do
    [ "$DRY" = 1 ] || [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "a job id is a uuid"
  done
  [ "$MARKER_BEFORE" != "$MARKER_AFTER" ] || die "the two markers must be two different jobs"
  FACTS+=("point in time: $PIT" "markers: $MARKER_BEFORE before, $MARKER_AFTER after")
  pass
}

phase_copy() {
  phase 2 "point-in-time copy of $SQL_SOURCE to $PIT"
  local zone=() op latest i source_zone copy_zone
  [ -z "$ZONE" ] || zone=(--preferred-zone="$ZONE")
  # A zone recovery's copy must not land in the original's zone. The zone comes from Cloud SQL's
  # own record of the original; without it the recovery stops (it never assumes).
  if [ "$MODE" = drill ] || [ "$MODE" = lost-instance ]; then
    get source_zone "<original-zone>" gcloud sql instances describe "$SQL_SOURCE" --project="$PROJECT" \
      --format='value(gceZone)' || fail "could not read the zone of $SQL_SOURCE: a zone recovery needs it"
    [ "$DRY" = 1 ] || [ -n "$source_zone" ] || fail "no zone reported for $SQL_SOURCE: a zone recovery needs it"
    [ "$source_zone" != "$ZONE" ] || fail "--zone $ZONE is the zone of $SQL_SOURCE: choose another zone of $REGION"
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
  must_be_new "$SQL_COPY"
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
  if [ "$1" = 0 ]; then ledger_at_pit; else serving_commit; fi
  db_checks "$SQL_COPY" "$REGION" "${MARKER_BEFORE:-}" "${MARKER_AFTER:-}"
  if [ "$1" = 1 ]; then
    [ "$MODE" != drill ] || PUT_BACK="$(put_back data)"
    owner_step "apply the data root with the copy admitted (S8-6; the services stay on $SQL_SOURCE)" \
      "$(tf_lines data "$SQL_COPY")"
    printf '   Your account needs Service Account Token Creator on %s for this login check.\n' "$API_SA"
    login_check "$PROJECT:$REGION:$SQL_COPY"
  fi
  [ -z "${MARKER_BEFORE:-}" ] || markers_on_original
  pass
}

phase_salvage() {
  phase 4 "backup salvage into $SALVAGE_REGION"
  local json name start op age
  # A daily backup can predate the serving release's migrations: it is checked as a prefix only.
  local RELEASE_COMMIT=""
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
  must_be_new "$SQL_SALVAGE"
  get op "<operation>" gcloud sql backups restore "$name" --restore-instance="$SQL_SALVAGE" \
    --region="$SALVAGE_REGION" --project="$PROJECT" --async --format='value(name)'
  wait_op "$op"
  db_checks "$SQL_SALVAGE" "$SALVAGE_REGION" "" ""
  FACTS+=("salvage copy: $SQL_SALVAGE in $SALVAGE_REGION, backup age $age")
  pass "backup age $age"
}

fs_get() { # var, database id, path under documents/, with draft_snapshot's token
  get "$1" '{}' curl -fsS -H "@$TMP/auth-header" \
    "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$2/documents/$3"
}

# One draft as the app loads it (web/src/lib/field/store.ts, loadDraft): the draft document and
# its rooms and photos subcollections, each document by id with its fields, in one canonical
# form. Fails if a read fails, the draft is missing, or a list does not fit in one page.
draft_snapshot() { # var, database id. A fresh token each time, in a private header file, never on
  # a command line.
  local doc rooms photos snapshot
  auth_header || return 1
  fs_get doc "$2" "$DRAFT" || return 1
  fs_get rooms "$2" "$DRAFT/rooms?pageSize=300" || return 1
  fs_get photos "$2" "$DRAFT/photos?pageSize=300" || return 1
  if [ "$DRY" = 1 ]; then printf -v "$1" '%s' '{}'; return 0; fi
  # Through private files, never on a command line: the draft's text is private.
  (umask 077 && printf '%s' "$doc" >"$TMP/d.json" && printf '%s' "$rooms" >"$TMP/r.json" && printf '%s' "$photos" >"$TMP/p.json")
  snapshot="$(jq -cnS --slurpfile ds "$TMP/d.json" --slurpfile rs "$TMP/r.json" --slurpfile ps "$TMP/p.json" '
    $ds[0] as $d | $rs[0] as $r | $ps[0] as $p |
    def docs($list): if $list.nextPageToken then error("more than one page")
      else [($list.documents // [])[] | {id: (.name | split("/") | last), fields: (.fields // {})}] | sort_by(.id) end;
    if ($d.fields | type) != "object" then error("no draft") else
      {draft: $d.fields, rooms: docs($r), photos: docs($p)} end')" || return 1
  printf -v "$1" '%s' "$snapshot"
}

phase_field() {
  phase 5 "field database restore"
  local json name snap original restored i rooms photos op state
  get json '[]' gcloud firestore backups list --location="$REGION" --project="$PROJECT" --format=json
  if [ "$DRY" = 1 ]; then
    name="<backup-name>"
    snap="<snapshot-time>"
  else
    read -r name snap < <(printf '%s' "$json" | jq -r --arg db "projects/$PROJECT/databases/$FS_DB" \
      '[.[] | select(.database == $db and .state == "READY")] | sort_by(.snapshotTime) | last | select(. != null)
      | "\(.name) \(.snapshotTime)"') || fail "no ready backup of $FS_DB"
  fi
  get op "<operation>" gcloud firestore databases restore --source-backup="$name" --destination-database="$FS_COPY" \
    --project="$PROJECT" --format='value(name)'
  ask DRAFT "Path of one field draft that has not changed since $snap: companies/<company id>/drafts/<draft id>"
  [ "$DRY" = 1 ] || [[ "$DRAFT" =~ ^companies/[A-Za-z0-9_-]+/drafts/[A-Za-z0-9_-]+$ ]] ||
    die "a draft path is companies/<company id>/drafts/<draft id>"
  draft_snapshot original "$FS_DB" || fail "could not read the draft, its rooms and photos from $FS_DB"
  for i in $(seq 120); do
    get state '{"done":true}' gcloud firestore operations describe "$op" --database="$FS_COPY" --project="$PROJECT" \
      --format=json
    [ "$DRY" = 1 ] && break
    if [ "$(printf '%s' "$state" | jq -r '.done == true')" = true ]; then
      [ "$(printf '%s' "$state" | jq -r 'has("error")')" = false ] ||
        fail "the restore into $FS_COPY failed: $(printf '%s' "$state" | jq -r '.error.message // .error')"
      break
    fi
    [ "$i" -lt 120 ] || fail "the restore into $FS_COPY did not finish within an hour"
    sleep 30
  done
  draft_snapshot restored "$FS_COPY" || fail "could not read the draft, its rooms and photos from the restored $FS_COPY"
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
  local soft="gs://$BUCKET/$OBJ_SOFT" version="gs://$BUCKET/$OBJ_VERSION" gen md5 v1md5 now restored
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
  # A restore makes a new generation; the app and the records check open a registered file by the
  # generation recorded for it, so a restored registered photo or signature stays unreadable there.
  get restored "<new-generation>" gcloud storage objects describe "$soft" --project="$PROJECT" --format='value(generation)'
  [ "$DRY" = 1 ] || [ "$restored" != "$gen" ] || fail "the object restored from soft delete kept generation $gen: expected a new one"
  FACTS+=("soft delete: generation $gen restored as $restored; the app opens a registered file only by its recorded generation, so a deleted registered photo or signature stays unreadable in the app after this restore (owner decision)")
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
  PUT_BACK="$(put_back traffic)"
  drain_wait
  owner_step "apply the app root pointing the services at the copy (S8-6)" "$(tf_lines app "$SQL_COPY")"
  local fresh
  get fresh "<fresh-revision>" gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT" \
    --format='value(status.latestCreatedRevisionName)'
  [ "$DRY" = 1 ] || [ "$fresh" != "$SERVING" ] || fail "the app-root apply made no fresh revision"
  move_to "$fresh" "$PROJECT:$REGION:$SQL_COPY"
  printf '   Putting back: the recorded revision serves again before any admission is removed.\n'
  move_to "$SERVING" "$PROJECT:$REGION:$SQL_SOURCE"
  PUT_BACK="$(put_back app)"
  drain_wait
  owner_step "apply the app root with the override emptied" "$(tf_lines app "")"
  PUT_BACK="$(put_back data)"
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

preflight
RUNNING=1
case "$MODE" in
  drill)
    owner_step "tell everyone using test to stop writing there until this drill ends" \
      "Anything written on test during the drill (a job, a draft, a photo, a signature) is discarded:" \
      "traffic goes back to $SQL_SOURCE and the copy holding it is deleted. Your own two marker jobs" \
      "are the only writes the drill needs."
    phase_markers
    phase_copy
    phase_checks 1
    phase_salvage
    phase_field
    phase_files
    phase_repoint
    phase_cleanup
    printf '\n   Tell everyone using test that they may write there again.\n'
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
    phase 7 "repoint checks"
    serving_revision
    serving_fits_copy
    reconcile_access
    pass
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
