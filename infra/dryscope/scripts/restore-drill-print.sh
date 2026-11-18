# shellcheck shell=bash
# The commands restore-drill.sh prints for you to paste, sourced by it: the Terraform blocks, the
# put-back chain, the zone-recovery access reconciliation and repoint, and the damaged-rows
# copy-back; also the ledger of the checkout and of a commit. Each chain runs a step only after every step before it passed. Uses restore-drill.sh's
# names and settings; never run on its own.

# Printed commands for you to paste: one chain, each step only after every step before it passed.
chain() {
  local out="(set -o pipefail" step
  for step in "$@"; do out+=$' &&\n  '"${step//$'\n'/$'\n  '}"; done
  printf '%s)\n' "$out"
}
drain_read() {
  printf '%s' "curl -fsS -H @<(printf 'Authorization: Bearer %s\\n' \"\$(gcloud auth print-access-token --project=$PROJECT)\") $SERVICE_URL | jq -r --argjson now \"\$(date -u +%s)\" '$DRAIN_JQ'"
}
step_drain() { printf '%s' "sleep \"\$($(drain_read))\" && [ \"\$($(drain_read))\" = 0 ]"; }
step_uses() { # revision, connection
  printf '%s' "[ \"\$(gcloud run revisions describe $1 --region=$REGION --project=$PROJECT --format=json | jq -r '[.spec.containers[].env[]? | select(.name == \"SQL_CONNECTION_NAME\") | .value] | first // empty')\" = \"$2\" ]"
}
step_images() { # revision, images JSON
  printf '%s' "[ \"\$(gcloud run revisions describe $1 --region=$REGION --project=$PROJECT --format=json | jq -c '[.spec.containers[].image]')\" = '$2' ]"
}
step_tag() { printf '%s' "gcloud run services update-traffic $API_SERVICE --update-tags=candidate=$1 --region=$REGION --project=$PROJECT"; }
step_move() { printf '%s' "gcloud run services update-traffic $API_SERVICE --to-revisions=$1=100 --region=$REGION --project=$PROJECT"; }
step_reaches() { # tag ("" for all traffic), revision
  local select='.percent == 100'
  [ -z "$1" ] || select=".tag == \"$1\""
  printf '%s' "[ \"\$(gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format=json | jq -r '[.status.traffic[] | select($select) | .revisionName] | first // empty')\" = \"$2\" ]"
}
step_health() { printf '%s' "curl -fsS $1/api/health | jq -e --arg env $ENV '.status == \"ok\" and .database == \"ok\" and .env == \$env' >/dev/null"; }

# Your temporary access to the copy as the migrator's role, then psql through its own proxy; the
# closing line removes the access only if this session created it (C=1). psql keeps no history.
copy_session() {
  cat <<EOF
       ME="\$(gcloud config get-value account --project=$PROJECT)" && D="\$(mktemp -d /tmp/rd.XXXXXX)" && C="" &&
         gcloud sql users create "\$ME" --instance=$SQL_COPY --type=cloud_iam_user --database-roles=$MIGRATE_DB_USER --project=$PROJECT && C=1
       [ "\$C" = 1 ] && { cloud-sql-proxy --auto-iam-authn --unix-socket="\$D" $PROJECT:$REGION:$SQL_COPY & P=\$!; }
       [ "\$C" = 1 ] && psql -X -v HISTFILE=/dev/null -h "\$D/$PROJECT:$REGION:$SQL_COPY" -U "\$ME" -d $SQL_DATABASE
EOF
}
copy_session_end() {
  printf '       kill "$P"; rm -rf "$D"; [ "$C" = 1 ] && gcloud sql users delete "$ME" --instance=%s --project=%s --quiet\n' "$SQL_COPY" "$PROJECT"
  printf '     If the create failed or you stopped it, nothing removes the user: check gcloud sql users list\n'
  printf '     --instance=%s --project=%s and remove your account only if this session added it.\n' "$SQL_COPY" "$PROJECT"
}

print_copy_back() {
  local source="$PROJECT:$REGION:$SQL_SOURCE"
  cat <<EOF

The validated copy is $SQL_COPY. Nothing was repointed and nothing was deleted.
Copy back only the damaged rows (docs/runbook/backups.md, "Damaged rows"). Row-level security is
forced on every table, so each read and write below lifts it inside its own transaction.
  1. Read the damaged rows from the copy, by the table's full primary key, as the migrator's role,
     through your own account; the access is temporary, so the last command removes it:
$(copy_session)
         BEGIN; SET LOCAL ROLE "$MIGRATE_DB_USER";
         ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;
         SELECT * FROM <table> WHERE (<primary key columns>) IN ((<a damaged row's key>), ...);
         ROLLBACK;
$(copy_session_end)
  2. Read the same rows on $SQL_SOURCE as the migrator itself (Service Account Token Creator on
     $MIGRATE_SA), the same way:
       S="\$(mktemp -d /tmp/rd.XXXXXX)" &&
         cloud-sql-proxy --auto-iam-authn --impersonate-service-account=$MIGRATE_SA --unix-socket="\$S" $source & Q=\$!
       psql -X -v HISTFILE=/dev/null -h "\$S/$source" -U $MIGRATE_DB_USER -d $SQL_DATABASE
         BEGIN; ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;
         SELECT * FROM <table> WHERE (<primary key columns>) IN ((<a damaged row's key>), ...);
         -- a row of a job (jobs, or a table with job_id): its job too, in this same transaction
         ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
         SELECT status, revision FROM jobs WHERE (company_id, id) = (<company>, <job id>);
         ROLLBACK;
     The primary key is the table's full key, as \\d <table> shows it: on a company's table it
     includes company_id (company_id and id; job_customers and job_claims: company_id and job_id).
     Never read or write by id alone: two companies can hold the same id. Compare the two reads.
  3. Never write a signed record or a guarded table's rows (the guard triggers refuse it; never
     disable one). A damaged signed record is an owner decision, recorded in a sidecar.
  4. In that same session on $SQL_SOURCE, one transaction per table and one statement per damaged
     row, by its full primary key, writing only while the whole row (every column, updated_at and
     revision too) is still exactly as read in step 2:
       BEGIN;
       ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;
       -- a row of a job: first lock its job and advance its revision, as a normal save does; a
       -- submitted or signed job, or one changed since step 2, gives UPDATE 0: ROLLBACK; and stop.
       ALTER TABLE jobs NO FORCE ROW LEVEL SECURITY;
       UPDATE jobs SET revision = revision + 1, last_change_id = gen_random_uuid(), updated_at = now()
         WHERE (company_id, id) = (<company>, <job id>) AND status NOT IN ('submitted', 'signed')
           AND revision = <its revision as read in step 2>;
       -- (a damaged jobs row itself: set its columns in that same UPDATE, with no second one)
       UPDATE <table> SET (<columns>) = (<values from the copy>)
         WHERE (<primary key columns>) = (<the row's key>)
           AND (<every column>) IS NOT DISTINCT FROM (<the whole row as read in step 2>);
       -- a row missing on $SQL_SOURCE: INSERT INTO <table> (<all columns>) VALUES (<the copy's values>);
       -- psql prints UPDATE 1 or INSERT 0 1 for each: on any other count, ROLLBACK; (someone
       -- changed the row since you compared it) and compare again.
       ALTER TABLE <table> FORCE ROW LEVEL SECURITY; ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
       COMMIT;
     Rows written since $PIT stay, and so does any edit made since you compared. Then stop the
     proxy and remove its directory: kill "\$Q"; rm -rf "\$S"
  5. Run the records check for each company (operator screen, "Check records").
  6. Delete $SQL_COPY only when you decide to; this script never does.
EOF
}

# Before any traffic can move to a zone recovery's copy: the copy holds every role, membership,
# invitation, operator grant and homeowner link as it stood at the restore point.
print_reconcile() {
  cat <<EOF
On $SQL_COPY, re-apply every access change made after $PIT, before any traffic moves: a member
removed or disabled or a role lowered (memberships), an invitation revoked (invitations), an
operator grant removed (platform_admins), a company suspended (companies.status), a job assignment
ended (job_assignments), a field owner transferred (jobs.field_owner_actor_id), a job archived
(jobs), and a homeowner link revoked or its token rotated (signing_links and document_links). This
list is kept by hand: anything else that grants or withdraws access counts too.
Through temporary access of your own:
$(copy_session)
         BEGIN; SET LOCAL ROLE "$MIGRATE_DB_USER";
         ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;  -- each table you change
         UPDATE <table> SET ... WHERE (<primary key columns>) = (<the row's key>);
         ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
         COMMIT;
$(copy_session_end)
A session revoked in the sign-in tenant is no substitute: signing in again reads the role from
the copy.
EOF
}

print_repoint() {
  local sql="$PROJECT:$REGION:$SQL_COPY"
  cat <<EOF

The copy $SQL_COPY passed its checks and the web app's account logs in to it.
The revision serving now is $SERVING, running $SERVING_IMAGES. Repoint the app (S8-6) with the
one command below, pasted as it is. It stops at the first step that fails and moves no traffic
before every check before it passed: the drain wait, the app-root apply, the fresh revision naming
the copy and running the recorded images, the candidate tag and its health, then all traffic and
the serving address.
EOF
  chain "$(step_drain)" "$(tf_lines app "$SQL_COPY")" \
    "FRESH=\"\$(gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format='value(status.latestCreatedRevisionName)')\"" \
    "[ -n \"\$FRESH\" ] && [ \"\$FRESH\" != \"$SERVING\" ]" \
    "$(step_uses '"$FRESH"' "$sql")" "$(step_images '"$FRESH"' "$SERVING_IMAGES")" \
    "$(step_tag '"$FRESH"')" "$(step_reaches candidate '$FRESH')" "$(step_health "https://$CANDIDATE_HOST")" \
    "$(step_move '"$FRESH"')" "$(step_reaches "" '$FRESH')" "$(step_health "https://$PUBLIC_HOST")" | sed 's/^/  /'
  cat <<EOF
If the images check fails, the service template holds a later release that may need migrations
the copy lacks: move no traffic; that is an owner decision. Keep the recovered database serving;
a return to the original is a separate owner decision. Your temporary access to the copy was
removed when the checks ended. Access on the copy was reconciled before this command was printed.
EOF
}

# A Terraform block as one command: each step runs only if the one before it passed, so nothing is
# applied unless the plan check accepted the plan, and the subshell leaves your own directory as it
# was. Your other variables come from the TF_VAR_ values you exported before the run (see the top).
tf_lines() { # root, override value or "" for emptied
  local root="$1"
  printf '%s\n' \
    "(cd $(printf '%q' "$INFRA/$root") &&" \
    "  terraform init -reconfigure -backend-config=envs/backend-$ENV.hcl &&" \
    "  terraform plan -var-file=envs/$ENV.tfvars -var sql_instance_override=$2 -out=$ENV.tfplan &&" \
    "  terraform show -json $ENV.tfplan | node ../scripts/check-plan.js $root $ENV - &&" \
    "  terraform apply $ENV.tfplan)"
}

# The put-back still owed, as one chain: the recorded revision tagged candidate and checked, then
# all traffic, then the serving address; only then the drain wait and the two applies that clear
# the override. Prints from the step named on.
put_back() { # from: traffic, app or data
  local steps=()
  case "$1" in
    traffic)
      steps+=("$(step_uses "$SERVING" "$PROJECT:$REGION:$SQL_SOURCE")" "$(step_images "$SERVING" "$SERVING_IMAGES")"
        "$(step_tag "$SERVING")" "$(step_reaches candidate "$SERVING")" "$(step_health "https://$CANDIDATE_HOST")"
        "$(step_move "$SERVING")" "$(step_reaches "" "$SERVING")" "$(step_health "https://$PUBLIC_HOST")")
      ;&
    app) steps+=("$(step_drain)" "$(tf_lines app "")") ;&
    data) steps+=("$(tf_lines data "")") ;;
  esac
  chain "${steps[@]}"
}

# The ledger as web/migrations and git hold it, for the checks on a copy.
# id|checksum for each file of web/migrations, in order, hashed in one call (once per run).
CHECKOUT_LEDGER=""
ledger_of_checkout() {
  local sum=sha256sum
  command -v sha256sum >/dev/null || sum="shasum -a 256"
  [ -n "$CHECKOUT_LEDGER" ] ||
    CHECKOUT_LEDGER="$( (cd "$REPO/web/migrations" && $sum -- *.sql) | sed 's/^\([0-9a-f]*\) [ *]\(.*\)\.sql$/\2|\1/' | sort)"
  printf '%s\n' "$CHECKOUT_LEDGER"
}

# id|checksum for each migration file at a commit, in order: the commit's files, each of which must
# have the same bytes in your checkout (the same git blob), with the checkout's checksums.
ledger_of_commit() {
  local listed blobs here ids
  listed="$(git -C "$REPO" ls-tree "$1" web/migrations/ | grep '\.sql$')" || return 1
  blobs="$(printf '%s\n' "$listed" | awk '{print $3}')"
  ids="$(printf '%s\n' "$listed" | sed 's#.*/##; s/\.sql$//')"
  # shellcheck disable=SC2046,SC2086 # one path per line, no spaces (NNNN_words.sql)
  here="$(cd "$REPO" && git hash-object -- $(printf '%s\n' "$listed" | cut -f2))" || return 1
  [ "$blobs" = "$here" ] || {
    printf 'a migration of commit %s differs in your checkout\n' "$1" >&2
    return 1
  }
  ledger_of_checkout | grep -F -f <(printf '%s|\n' $ids) | sort
}
