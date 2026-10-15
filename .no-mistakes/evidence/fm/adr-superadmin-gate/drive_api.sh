#!/bin/bash
# Drives the superadmin tools over HTTPS against the locally running backend (browser_server harness).
B=https://localhost:${PORT:-8799}
c(){ local who=$1 m=$2 p=$3 d=$4; shift 4
  local code body
  body=$(curl -sk -X $m "$B$p" -H "Authorization: Bearer test-owner-ws-$who" -H 'X-ADR-Workspace-Protocol: 1' -H 'Content-Type: application/json' "$@" ${d:+-d "$d"} -w '\n%{http_code}')
  code=$(tail -n1 <<<"$body"); body=$(head -n -1 <<<"$body" | cut -c1-110)
  printf '%-9s %-4s %-52s -> %s %s\n' "$who" "$m" "$p" "$code" "$body"; }
curl -sk -X POST $B/__test/workspaces -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
ROUTES=(
 "GET|/api/admin/companies|"
 "POST|/api/admin/companies|{\"name\":\"Forged Restoration\",\"owner_email\":\"forged@example.invalid\"}"
 "PUT|/api/admin/companies/other/status|{\"expected_version\":1,\"status\":\"suspended\"}"
 "PUT|/api/admin/companies/adr/status|{\"expected_version\":1,\"status\":\"suspended\"}"
 "PUT|/api/admin/companies/missing-co/status|{\"expected_version\":1,\"status\":\"suspended\"}"
 "GET|/api/admin/companies/other/jobs|"
 "GET|/api/admin/companies/adr/jobs|"
 "GET|/api/admin/companies/adr/authorizations|"
 "GET|/api/companies/other/team|"
 "GET|/api/companies/other/invitations|"
 "POST|/api/companies/other/invitations|{\"email\":\"forged-owner@example.invalid\",\"role\":\"owner\"}"
)
for who in estimator office other outsider; do
  echo "== caller: $who (not a superadmin)"
  for r in "${ROUTES[@]}"; do IFS='|' read m p d <<<"$r"
    [ "$who" = other ] && p=${p//companies\/other/companies\/adr-SWAP} && p=${p//companies\/adr\//companies\/other\/} && p=${p//adr-SWAP/adr}
    c $who $m "$p" "$d"; done
done
echo "== forged superadmin hints (office caller)"
c office GET /api/admin/companies "" -H 'X-Superadmin: true' -H 'X-Role: superadmin'
c office PUT /api/admin/companies/other/status '{"expected_version":1,"status":"suspended","superadmin":true,"role":"superadmin"}'
echo "== state after all refused calls (read by the real superadmin)"
c admin GET /api/admin/companies ""
echo "== positive control: active superadmin"
c admin PUT /api/admin/companies/missing-co/status '{"expected_version":1,"status":"suspended"}'
c admin GET /api/companies/other/team ""
c admin PUT /api/admin/companies/other/status '{"expected_version":1,"status":"suspended"}'
c admin PUT /api/admin/companies/other/status '{"expected_version":2,"status":"active"}'
