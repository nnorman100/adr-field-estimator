# shellcheck shell=bash
# The commands restore-drill.sh prints for you to paste, sourced by it: the put-back chain, the
# zone-recovery repoint and the damaged-rows copy-back. Each chain runs a step only after every
# step before it passed. Uses restore-drill.sh's names and settings; never run on its own.

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
# Health at the candidate tag's own Cloud Run address, which only the tagged revision answers.
step_revision_health() { # revision
  step_health "\"\$(gcloud run services describe $API_SERVICE --region=$REGION --project=$PROJECT --format=json | jq -r --arg rev $1 '[.status.traffic[] | select(.tag == \"candidate\" and .revisionName == \$rev) | .url] | first // empty')\""
}

print_copy_back() {
  local copy="$PROJECT:$REGION:$SQL_COPY" source="$PROJECT:$REGION:$SQL_SOURCE"
  cat <<EOF

The validated copy is $SQL_COPY. Nothing was repointed and nothing was deleted.
Copy back only the damaged rows (docs/runbook/backups.md, "Damaged rows"). Row-level security is
forced on every table, so each read and write below lifts it inside its own transaction.
  1. Read the damaged rows from the copy, by the table's full primary key, as the migrator's role,
     through your own account; the access is temporary, so the last command removes it:
       ME="\$(gcloud config get-value account --project=$PROJECT)" && D="\$(mktemp -d /tmp/rd.XXXXXX)" &&
         gcloud sql users create "\$ME" --instance=$SQL_COPY --type=cloud_iam_user --database-roles=$MIGRATE_DB_USER --project=$PROJECT
       cloud-sql-proxy --auto-iam-authn --unix-socket="\$D" $copy & P=\$!
       psql -h "\$D/$copy" -U "\$ME" -d $SQL_DATABASE
         BEGIN; SET LOCAL ROLE "$MIGRATE_DB_USER";
         ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;
         SELECT * FROM <table> WHERE (<primary key columns>) IN ((<a damaged row's key>), ...);
         ROLLBACK;
       kill "\$P"; rm -rf "\$D"; gcloud sql users delete "\$ME" --instance=$SQL_COPY --project=$PROJECT --quiet
  2. Read the same rows on $SQL_SOURCE as the migrator itself (Service Account Token Creator on
     $MIGRATE_SA), the same way:
       S="\$(mktemp -d /tmp/rd.XXXXXX)" &&
         cloud-sql-proxy --auto-iam-authn --impersonate-service-account=$MIGRATE_SA --unix-socket="\$S" $source & Q=\$!
       psql -h "\$S/$source" -U $MIGRATE_DB_USER -d $SQL_DATABASE
         BEGIN; ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY;
         SELECT * FROM <table> WHERE (<primary key columns>) IN ((<a damaged row's key>), ...);
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
       UPDATE <table> SET (<columns>) = (<values from the copy>)
         WHERE (<primary key columns>) = (<the row's key>)
           AND (<every column>) IS NOT DISTINCT FROM (<the whole row as read in step 2>);
       -- a row missing on $SQL_SOURCE: INSERT INTO <table> (<all columns>) VALUES (<the copy's values>);
       -- psql prints UPDATE 1 or INSERT 0 1 for each: on any other count, ROLLBACK; (someone
       -- changed the row since you compared it) and compare again.
       ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
       COMMIT;
     Rows written since $PIT stay, and so does any edit made since you compared. Then stop the
     proxy and remove its directory: kill "\$Q"; rm -rf "\$S"
  5. Run the records check for each company (operator screen, "Check records").
  6. Delete $SQL_COPY only when you decide to; this script never does.
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
    "$(step_tag '"$FRESH"')" "$(step_reaches candidate '$FRESH')" "$(step_revision_health '"$FRESH"')" \
    "$(step_health "https://$CANDIDATE_HOST")" \
    "$(step_move '"$FRESH"')" "$(step_reaches "" '$FRESH')" "$(step_health "https://$PUBLIC_HOST")" | sed 's/^/  /'
  cat <<EOF
If the images check fails, the service template holds a later release that may need migrations
the copy lacks: move no traffic; that is an owner decision. Keep the recovered database serving;
a return to the original is a separate owner decision. Your temporary access to the copy was
removed when the checks ended.

Once traffic has moved, before anyone else works on it: the copy restored every role, membership,
invitation and operator grant as it was at $PIT. Re-apply every access change made after that
minute (a member removed, a role lowered, an invitation revoked), or revoke every member's
sessions in the company's sign-in tenant so each signs in again under the roles now in force.
EOF
}
