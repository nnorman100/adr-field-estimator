#!/bin/bash
# Drives /api/audit on the running harness as the workspace estimator.
B=http://127.0.0.1:8799; H='Authorization: Bearer test-owner-ws-estimator'; O='X-ADR-Workspace-Protocol: 1'
ID=ADR-INS-cccccccccccccccccccccccccccccccc
run() { # $1 name, $2 plan json
  echo "=== $1 ==="; echo "plan: $2"
  curl -s -X POST $B/__live/plan -H 'Content-Type: application/json' -d "$2" >/dev/null
  REV=$(curl -s $B/api/inspections/$ID -H "$H" -H "$O" | python3 -c 'import sys,json; print(json.load(sys.stdin)["revision"])')
  S=$(date +%s.%N)
  curl -s -o /tmp/adr-live/resp.json -w 'HTTP %{http_code}\n' -X POST $B/api/audit -H "$H" -H "$O" -H 'Content-Type: application/json' -d "{\"inspection_id\":\"$ID\",\"expected_revision\":$REV}"
  echo "wall: $(python3 -c "print(round($(date +%s.%N)-$S,2))") s"
  python3 -c 'import json; r=json.load(open("/tmp/adr-live/resp.json")); a=r.get("audit") if isinstance(r,dict) else None; print("detail:", r.get("detail")) if "detail" in r else print("audit saved, revision", a and a.get("revision"), "signable", a and a["documents"].get("signable"), "summary:", a and a["documents"].get("ai_summary", "")[:60] if a else "")' 2>&1 | head -3
  echo "provider calls: $(curl -s $B/__live/calls)"
  echo "saved audit on record: $(curl -s $B/api/inspections/$ID -H "$H" -H "$O" | python3 -c 'import sys,json; a=json.load(sys.stdin).get("audit"); print(None if a is None else {"revision": a.get("revision"), "hash": a.get("proposal_hash","")[:12]})')"
  echo
  sleep 21  # audit quota: 3 per minute
}
curl -s -X POST $B/__test/workspaces -H 'Content-Type: application/json' -d '{"enabled": true}'; echo
run "S1 healthy audit, workspaces on" '{"delays":[2]}'
run "S2 first attempt stalls (60s), retry succeeds" '{"delays":[60,3]}'
run "S3 both attempts stall" '{"delays":[60,60]}'
run "S4 provider error is not retried" '{"error":true}'
