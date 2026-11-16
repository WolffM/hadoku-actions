#!/usr/bin/env bash
# Runs wait-for-live/wait.sh, the real file, against a stand-in curl that
# answers from a script and a stand-in sleep that records instead of waiting.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

# Each call consumes one line of $ANSWERS: "<http code> <body>"; the last line
# repeats. Every argument is recorded, so a case can assert what was sent.
cat > "$work/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ARGS"
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
OLD='{"tag":"ppe-11","commit":"aaa"}'
NEW='{"tag":"ppe-12","commit":"bbb"}'
EDGE='<!DOCTYPE html><title>Sign in</title>'

# case <name> <want-exit> <want-calls> -- answer lines...   (env: KEY, EXPECT, TIMEOUT)
case_() {
  local name=$1 want_rc=$2 want_calls=$3; shift 4
  : > "$work/calls"; : > "$work/slept"; : > "$work/args"; : > "$work/out"
  printf '%s\n' "$@" > "$work/answers"
  local rc=0
  env -i PATH="$work/bin:$PATH" HOME="$work" RUNNER_TEMP="$work" GITHUB_OUTPUT="$work/out" \
    CALLS="$work/calls" SLEPT="$work/slept" ANSWERS="$work/answers" ARGS="$work/args" \
    WAIT_URL=https://example.invalid/app/version.json WAIT_EXPECT="${EXPECT-ppe-12}" WAIT_JQ=.tag \
    WAIT_KEY="${KEY-}" WAIT_TIMEOUT="${TIMEOUT-30}" WAIT_INTERVAL=10 \
    bash "$root/wait-for-live/wait.sh" > "$work/log" 2>&1 || rc=$?
  local calls; calls=$(cat "$work/calls" 2>/dev/null || true); calls=${calls:-0}
  if [ "$rc" != "$want_rc" ] || [ "$calls" != "$want_calls" ]; then
    echo "FAIL $name: exit=$rc calls=$calls (wanted exit=$want_rc calls=$want_calls)"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}
must() { # <what> <grep pattern> <file>
  grep -q -- "$2" "$3" || { echo "FAIL $1"; sed 's/^/    /' "$3"; fails=$((fails + 1)); }
}
must_not() {
  ! grep -q -- "$2" "$3" || { echo "FAIL $1"; sed 's/^/    /' "$3"; fails=$((fails + 1)); }
}

case_ 'already live'                               0 1 -- "200 $NEW"
must 'the wait is an output' '^waited-seconds=0$' "$work/out"
must_not 'no key, no X-User-Key header' 'X-User-Key' "$work/args"

# The shape of a real publish: the old build, then the new one.
case_ 'old build, then the new one'                0 3 -- "200 $OLD" "200 $OLD" "200 $NEW"
must 'the wait is counted' '^waited-seconds=20$' "$work/out"

# A deploy in progress from outside: the edge's HTML, a 502, a 404 before the
# first publish. None of them ends the wait early.
case_ 'edge page, 502 and 404 are all "not yet"'   0 4 -- "200 $EDGE" "502 $EDGE" "404 {}" "200 $NEW"

KEY=sekrit case_ 'a service key is sent as X-User-Key' 0 1 -- "200 $NEW"
must 'the key header' 'X-User-Key: sekrit' "$work/args"
must_not 'the key never reaches the log' 'sekrit' "$work/log"

case_ 'never goes live: fails, saying what it last saw' 1 4 -- "200 $OLD"
must 'names the stale value' 'did not report ppe-12 within 30s (last: HTTP 200, .tag = ppe-11)' "$work/log"

case_ 'refused throughout: fails, pointing at the key' 1 4 -- '401 {"error":"unauthorized"}'
must 'the 401 hint' 'last: HTTP 401). Is service-key set' "$work/log"

# An unset step output reads as ''. Waiting for '' would pass on the first
# answer that lacks the field.
EXPECT='' case_ 'an empty expectation is refused before any request' 1 0 -- "200 $NEW"
TIMEOUT=soon case_ 'a non-numeric timeout is refused'             1 0 -- "200 $NEW"

if [ "$fails" -gt 0 ]; then echo "::error::$fails wait-for-live case(s) failed"; exit 1; fi
