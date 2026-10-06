#!/usr/bin/env bash
# Runs every local test suite. Usage: bash tests/run.sh [name-filter]   (e.g. `bash tests/run.sh phaseD`)
# Needs Node 20+ and `npm install` once inside tests/. The page-level suites use the local dev server, started here if it is not running.
cd "$(dirname "$0")" || exit 1
ROOT="$(cd .. && pwd)"
[ -d node_modules ] || { echo "Run 'npm install' inside tests/ first."; exit 2; }
node browser/extract-component.mjs >/dev/null || exit 2
STARTED=""
if ! curl -s -o /dev/null -m 2 http://localhost:8000/; then (cd "$ROOT" && node dev-server.js >/tmp/2ace-dev-server.log 2>&1 &) ; STARTED=1; sleep 1.5; fi
FILTER="${1:-}"; FAILED=0; TOTAL=0
run() {
  local f="$1"; [[ -n "$FILTER" && "$f" != *"$FILTER"* ]] && return
  local out; out="$(node "$f" 2>&1)"; local code=$?
  local line; line="$(printf '%s\n' "$out" | grep -E "[0-9]+ passed|errors at end" | tail -1)"
  if [ -z "$line" ]; then   # suites that print one PASS/FAIL line per check and no summary
    local np nf; np="$(printf '%s\n' "$out" | grep -c '^PASS')"; nf="$(printf '%s\n' "$out" | grep -c '^FAIL')"
    [ "$np" -gt 0 ] && line="$np passed, $nf failed"
  fi
  local bad=0
  printf '%s\n' "$out" | grep -qE "^[0-9]+ passed, [1-9][0-9]* failed" && bad=1
  printf '%s\n' "$line" | grep -qE "errors at end: [1-9]" && bad=1
  [ -z "$line" ] && bad=1
  [ "$code" -ne 0 ] && [ -z "$(printf '%s\n' "$line" | grep -E 'passed|errors at end')" ] && bad=1
  TOTAL=$((TOTAL+1)); [ "$bad" -eq 1 ] && FAILED=$((FAILED+1))
  printf '%-34s %s %s\n' "$f" "$([ $bad -eq 1 ] && echo FAIL || echo ok)" "${line:-(no summary line)}"
  [ "$bad" -eq 1 ] && printf '%s\n' "$out" | grep -E "^FAIL|Error|error:" | head -8 | sed 's/^/      /'
}
for f in sql/*.test.mjs ui/*.test.mjs browser/*_test.js; do run "$f"; done
[ -n "$STARTED" ] && pkill -f "node dev-server.js"
echo; echo "$((TOTAL-FAILED)) of $TOTAL suites passed"; [ "$FAILED" -eq 0 ]
