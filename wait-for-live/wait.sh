#!/usr/bin/env bash
# Poll WAIT_URL until `jq WAIT_JQ` of its JSON answer equals WAIT_EXPECT.
#
# Every outcome but "the value matches" keeps polling until the deadline: a
# 401/404, a 5xx, a non-JSON edge page and the OLD value are all what a deploy
# in progress looks like from outside. The give-up message says what was last
# seen, because "timed out" alone cannot tell a deploy that never started from
# a wrong key or a wrong field.
set -euo pipefail
: "${WAIT_URL:?url is required}"
if [ -z "${WAIT_EXPECT:-}" ]; then
  echo "::error::expect is empty: nothing to wait for. An unset output or input reads as ''."
  exit 1
fi
filter=${WAIT_JQ:-.version}
timeout=${WAIT_TIMEOUT:-600}
interval=${WAIT_INTERVAL:-10}
case "$timeout$interval" in *[!0-9]*) echo "::error::timeout-seconds and interval-seconds must be whole numbers"; exit 1 ;; esac
[ "$interval" -ge 1 ] || { echo "::error::interval-seconds must be at least 1"; exit 1; }

out="$RUNNER_TEMP/wait-for-live.$$"
trap 'rm -f "$out"' EXIT
headers=(-A 'hadoku-ci-wait-for-live' -H 'Cache-Control: no-cache')
[ -z "${WAIT_KEY:-}" ] || headers+=(-H "X-User-Key: $WAIT_KEY")

waited=0
last='nothing yet'
while :; do
  code=$(curl -sS -m 30 -o "$out" -w '%{http_code}' "${headers[@]}" "$WAIT_URL" 2>/dev/null || true)
  [ -n "$code" ] || code='000'
  if [ "$code" = '200' ] && got=$(jq -r "$filter | tostring" "$out" 2>/dev/null); then
    if [ "$got" = "$WAIT_EXPECT" ]; then
      echo "wait-for-live: $WAIT_URL reports $got after ${waited}s"
      echo "waited-seconds=$waited" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    last="HTTP 200, $filter = $got"
  elif [ "$code" = '200' ]; then
    last='HTTP 200, not JSON (or the jq filter failed)'
  else
    last="HTTP $code"
  fi
  if [ "$waited" -ge "$timeout" ]; then
    hint=''
    case "$code" in
      401|403) hint=' Is service-key set, and may this key read the route?' ;;
      404) hint=' Is the URL right, and has anything been published there yet?' ;;
    esac
    echo "::error::wait-for-live: $WAIT_URL did not report $WAIT_EXPECT within ${timeout}s (last: $last).$hint"
    exit 1
  fi
  echo "wait-for-live: $last, want $WAIT_EXPECT (${waited}s of ${timeout}s)"
  sleep "$interval"
  waited=$((waited + interval))
done
