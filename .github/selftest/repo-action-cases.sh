#!/usr/bin/env bash
# Runs repo-action/call.sh, the real file, against a stand-in curl that answers
# from a script, and a stand-in sleep that records instead of waiting. So the
# retry policy is asserted end to end in well under a second: how many tries,
# how long it waits, what it gives up on, and what it never retries.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

# Each call consumes one line of $ANSWERS: "<http code> <body>". The body is
# written where call.sh's -o points; the code goes to stdout for -w.
cat > "$work/bin/curl" <<'SH'
#!/usr/bin/env bash
out=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; esac; shift; done
n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CALLS"
line=$(sed -n "${n}p" "$ANSWERS"); [ -n "$line" ] || line=$(tail -1 "$ANSWERS")
printf '%s' "${line#* }" > "$out"
printf '%s' "${line%% *}"
SH
cat > "$work/bin/sleep" <<'SH'
#!/usr/bin/env bash
echo "$1" >> "$SLEPT"
SH
chmod +x "$work/bin/"*

fails=0
OK='{"success":true,"repo":"WolffM/x"}'
EDGE='<!DOCTYPE html><title>502 Bad Gateway</title>'

# case <name> <want-exit> <want-calls> <want-slept-total> -- answer lines...
case_() {
  local name=$1 want_rc=$2 want_calls=$3 want_slept=$4; shift 5
  : > "$work/calls"; : > "$work/slept"; printf '%s\n' "$@" > "$work/answers"
  local rc=0
  env -i PATH="$work/bin:$PATH" HOME="$work" RUNNER_TEMP="$work" GITHUB_OUTPUT="$work/out" \
    CALLS="$work/calls" SLEPT="$work/slept" ANSWERS="$work/answers" \
    REPO_ACTION_VERB=notify REPO_ACTION_KEY=k REPO_ACTION_BODY='{}' \
    REPO_ACTION_BROKER=https://example.invalid/mgmt \
    bash "$root/repo-action/call.sh" > "$work/log" 2>&1 || rc=$?
  local calls slept
  calls=$(cat "$work/calls"); slept=$(awk '{t += $1} END {print t + 0}' "$work/slept")
  if [ "$rc" != "$want_rc" ] || [ "$calls" != "$want_calls" ] || [ "$slept" != "$want_slept" ]; then
    echo "FAIL $name: exit=$rc calls=$calls slept=${slept}s (wanted exit=$want_rc calls=$want_calls slept=${want_slept}s)"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

case_ 'answered first time'                  0 1 0   -- "200 $OK"
# The measured shape: a redeploy, 6-11s of 502 from the edge, then up. The old
# policy (3 tries, 4s apart) gave up inside this window.
case_ 'a restart: 502 for ~12s, then up'     0 4 27  -- "502 $EDGE" "502 $EDGE" "502 $EDGE" "200 $OK"
case_ 'two restarts back to back'            0 6 87  -- "502 $EDGE" "502 $EDGE" "000 " "503 $EDGE" "502 $EDGE" "200 $OK"
case_ 'never answers: gives up after ~2min'  1 7 117 -- "502 $EDGE"
# Giving up must say how long it tried, or a 502 reads like a single blip.
if ! grep -q 'no answer from mgmt-api after 7 tries over ~117s' "$work/log"; then
  echo "FAIL the give-up message does not say how long it tried:"; sed 's/^/    /' "$work/log"
  fails=$((fails + 1))
fi
case_ 'a 4xx is a refusal, never retried'    1 1 0   -- '403 {"success":false,"error":"no grant"}'
case_ 'a 409 is exit 2, never retried'       2 1 0   -- '409 {"success":false,"error":"not a fast-forward"}'
case_ 'a non-JSON 200 is the edge, retried'  0 2 4   -- "200 $EDGE" "200 $OK"

if [ "$fails" -gt 0 ]; then echo "::error::$fails repo-action case(s) failed"; exit 1; fi
echo "all repo-action cases passed"
