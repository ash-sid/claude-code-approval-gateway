#!/usr/bin/env bash
# Reproduces the hook round-trips against a running gateway (default :4517).
# Usage: ./scripts/smoke-test.sh
set -euo pipefail
GW="${GATEWAY_URL:-http://localhost:4517}"

post() {
  curl -s --max-time 20 -X POST "$GW/pre-tool-use" -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"smoke\",\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$(pwd)\",\"permission_mode\":\"default\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$1\"}}"
}

echo "1) auto-allow (git status):"
post "git status"; echo
echo "2) ask (unknown command):"
post "npm install left-pad"; echo

echo "3) dangerous hold + approve (rm -rf build):"
post "rm -rf build" > /tmp/gw_held.json &
HELD=$!
sleep 1
ID=$(curl -s "$GW/api/approvals" | python3 -c 'import sys,json;a=[x for x in json.load(sys.stdin)["approvals"] if x["status"]=="pending"];print(a[0]["id"] if a else "")')
echo "   holding as approval id: $ID"
curl -s -X POST "$GW/api/approvals/$ID/decide" -H 'Content-Type: application/json' -d '{"action":"approve"}' >/dev/null
wait $HELD
echo "   held response -> $(cat /tmp/gw_held.json)"

echo
echo "Done. Try Deny / Alter / Stop from the dashboard at $GW/"
