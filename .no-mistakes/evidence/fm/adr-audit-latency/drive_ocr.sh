#!/bin/bash
# Adversarial: a 30 s pending-OCR wait eats the budget before the audit model call starts.
B=http://127.0.0.1:8799; H='Authorization: Bearer test-owner-ws-estimator'; O='X-ADR-Workspace-Protocol: 1'
ID=ADR-INS-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
PNG=$(/tmp/adr-test-venv/bin/python -c "import sys; sys.path.insert(0,'$ADR_ROOT'); from tests.fakes import png; print(png())")
n=0
curl -s -o /dev/null -w "create job HTTP %{http_code}\n" -X POST $B/api/inspections -H "$H" -H "$O" -H "Content-Type: application/json" -d "{\"inspection_id\":\"$ID\",\"data\":{\"address\":\"Synthetic OCR-wait property\",\"year_built\":2000,\"rooms\":[{\"name\":\"Bathroom\",\"category\":1,\"finished_sf\":10}],\"air_movers\":3,\"dehumidifiers\":1,\"scope_confirmed\":true}}"
run() {
  n=$((n+1)); echo "=== $1 ==="; echo "plan: $2"
  REV=$(curl -s $B/api/inspections/$ID -H "$H" -H "$O" | python3 -c 'import sys,json; print(json.load(sys.stdin)["revision"])')
  PID=$(printf 'd%031d' $n)
  curl -s -o /dev/null -w 'photo upload HTTP %{http_code} (OCR left pending)\n' -X POST $B/api/inspections/$ID/photos -H "$H" -H "$O" -H 'Content-Type: application/json' \
    -d "{\"expected_revision\":$REV,\"photo_id\":\"$PID\",\"room\":\"Bathroom\",\"captured_at\":\"2026-10-14T19:00:00Z\",\"data_url\":\"$PNG\"}"
  REV=$(curl -s $B/api/inspections/$ID -H "$H" -H "$O" | python3 -c 'import sys,json; print(json.load(sys.stdin)["revision"])')
  curl -s -X POST $B/__live/plan -H 'Content-Type: application/json' -d "$2" >/dev/null
  S=$(date +%s.%N)
  curl -s -o /tmp/adr-live/resp.json -w 'HTTP %{http_code}\n' -X POST $B/api/audit -H "$H" -H "$O" -H 'Content-Type: application/json' -d "{\"inspection_id\":\"$ID\",\"expected_revision\":$REV}"
  echo "wall: $(python3 -c "print(round($(date +%s.%N)-$S,2))") s"
  python3 -c 'import json; r=json.load(open("/tmp/adr-live/resp.json")); print("detail:", r["detail"]) if "detail" in r else print("audit saved for revision", r["audit"]["revision"])'
  echo "provider calls: $(curl -s $B/__live/calls)"; echo
}
run "S5 OCR wait leaves ~20 s: stalled single attempt gets whole budget, no retry, 504 before deadline" '{"delays":[60]}'
sleep 25
run "S6 OCR wait leaves ~20 s: an 18 s healthy call gets the whole remaining budget and succeeds" '{"delays":[18]}'
