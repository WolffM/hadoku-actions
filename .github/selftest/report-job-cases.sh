#!/usr/bin/env bash
# Runs report-job's shell against outcome/age cases WITHOUT the composite
# wrapper. The body is EXTRACTED from action.yml on every run, never retyped:
# a copy here would keep passing after the action changed under it.
#
# curl is a stand-in on PATH that records the payload instead of POSTing, so
# these cases reach past the point the `uses: ./report-job` steps stop at —
# what status and error a timed-out job actually sends — without writing a
# row to the live execution log.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 - "$root/report-job/action.yml" "$work/body.sh" <<'PY'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["runs"]["steps"]
assert len(steps) == 1, f"expected one step, found {len(steps)}"
body = steps[0]["run"]
# The env block is where expressions belong. One in the body would be
# substituted by the runner and NOT by this harness, so the two would differ.
assert "${{" not in body, "an expression in the run body is untestable here"
open(sys.argv[2], "w").write(body)
PY

mkdir "$work/bin"
cat > "$work/bin/curl" <<'SH'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in --data) cp "${2#@}" "$CURL_RECORD"; shift ;; esac
  shift
done
SH
chmod +x "$work/bin/curl"

fails=0
now=$(date -u +%s)

# run <name> <expect-exit> <expect: unreported|succeeded|failed> <error-substring> -- env...
run() {
  local name=$1 want_rc=$2 want=$3 want_err=$4; shift 5
  local rec="$work/payload.json" out rc
  rm -f "$rec"
  set +e
  out=$(env -i PATH="$work/bin:$PATH" HOME="$work" CURL_RECORD="$rec" \
        JOB_NAME=selftest:timeout SERVICE_KEY=k OUTCOME=success STARTED_AT= \
        ERROR_MESSAGE= TIMEOUT_MINUTES= RUN_ID=1 RUN_URL=https://example.invalid/run \
        "$@" bash "$work/body.sh" 2>&1)
  rc=$?
  set -e
  local got=unreported err=''
  if [ -f "$rec" ]; then
    got=$(jq -r .status "$rec")
    err=$(jq -r '.error // ""' "$rec")
  fi
  if [ "$rc" != "$want_rc" ] || [ "$got" != "$want" ] || [[ "$err" != *"$want_err"* ]]; then
    echo "FAIL $name: exit=$rc status=$got error='$err' (wanted exit=$want_rc status=$want error~'$want_err')"
    echo "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

# Backward compatibility: no timeout-minutes, behaviour exactly as before.
run 'success, no input'                    0 succeeded '' -- STARTED_AT=$((now - 30))
run 'failure, no input'                    0 failed 'selftest:timeout failed' -- OUTCOME=failure STARTED_AT=$((now - 30))
run 'cancelled, no input, old job'         0 unreported '' -- OUTCOME=cancelled STARTED_AT=$((now - 7200))
run 'cancelled, no input, no started-at'   0 unreported '' -- OUTCOME=cancelled
run 'skipped stays unreported'             0 unreported '' -- OUTCOME=skipped TIMEOUT_MINUTES=60 STARTED_AT=$((now - 7200))

# The bug: a cancel at the limit is a timeout.
run 'cancelled at the limit'               0 failed 'timed out after 60 min' -- OUTCOME=cancelled TIMEOUT_MINUTES=60 STARTED_AT=$((now - 3610))
run 'cancelled just inside the grace'      0 failed 'timed out after 60 min' -- OUTCOME=cancelled TIMEOUT_MINUTES=60 STARTED_AT=$((now - 3545))
run 'timeout beats a caller error-message' 0 failed 'timed out after 60 min' -- OUTCOME=cancelled TIMEOUT_MINUTES=60 STARTED_AT=$((now - 3700)) ERROR_MESSAGE=custom

# A supersede: cancelled well before the limit stays silent.
run 'cancelled early is a supersede'       0 unreported '' -- OUTCOME=cancelled TIMEOUT_MINUTES=60 STARTED_AT=$((now - 600))
run 'cancelled just before the grace'      0 unreported '' -- OUTCOME=cancelled TIMEOUT_MINUTES=60 STARTED_AT=$((now - 3500))

# The input does not change what success and failure send.
run 'success with the input'               0 succeeded '' -- TIMEOUT_MINUTES=60 STARTED_AT=$((now - 3700))
run 'failure with the input'               0 failed 'selftest:timeout failed' -- OUTCOME=failure TIMEOUT_MINUTES=60 STARTED_AT=$((now - 30))

# Misconfiguration is refused on ANY outcome, so the green run that wires it finds out.
run 'timeout without started-at'           1 unreported '' -- TIMEOUT_MINUTES=60
run 'non-numeric timeout'                  1 unreported '' -- TIMEOUT_MINUTES=60m STARTED_AT=$((now - 30))
run 'zero timeout'                         1 unreported '' -- TIMEOUT_MINUTES=0 STARTED_AT=$((now - 30))
run 'leading-zero timeout (octal in $(( )))' 1 unreported '' -- TIMEOUT_MINUTES=08 STARTED_AT=$((now - 30))

if [ "$fails" -gt 0 ]; then
  echo "::error::$fails report-job case(s) failed"
  exit 1
fi
echo "all report-job cases passed"
