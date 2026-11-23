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
printf '%s\n' "$@" > "$CURL_RECORD.args"
while [ $# -gt 0 ]; do
  case "$1" in
    # $CURL_RECORD is the LAST payload, which is all the single-POST cases
    # need; .all appends every one, because `extra-jobs` makes one call post
    # several and "the last one won" is the very bug the slug exists to stop.
    --data) cp "${2#@}" "$CURL_RECORD"; jq -c . "${2#@}" >> "$CURL_RECORD.all"; shift ;;
    -D) printf '%b' "${FAKE_HEADERS:-}" > "$2"; shift ;;
  esac
  shift
done
printf '%s' "${FAKE_CODE:-200}"
SH
chmod +x "$work/bin/curl"

fails=0
now=$(date -u +%s)

# run <name> <expect-exit> <expect: unreported|succeeded|failed> <error-substring> -- env...
run() {
  local name=$1 want_rc=$2 want=$3 want_err=$4; shift 5
  local rec="$work/payload.json" out rc
  rm -f "$rec" "$rec.all"
  set +e
  out=$(env -i PATH="$work/bin:$PATH" HOME="$work" CURL_RECORD="$rec" \
        JOB_NAME=selftest:timeout SERVICE_KEY=k OUTCOME=success STARTED_AT= \
        ERROR_MESSAGE= TIMEOUT_MINUTES= EXTRA_JOBS= RUN_ID=1 RUN_URL=https://example.invalid/run \
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

# An unanswered POST must not hold the caller's job (hadoku-actions#4), so the
# curl is bounded on the connect and on the whole transfer.
run 'success, read for the curl bounds'    0 succeeded '' -- STARTED_AT=$((now - 30))
for flag in --connect-timeout --max-time; do
  if grep -qx -- "$flag" "$work/payload.json.args"; then
    echo "ok   curl carries $flag"
  else
    echo "FAIL curl carries no $flag: an unanswered POST would hold the job until its timeout"
    fails=$((fails + 1))
  fi
done

# `extra-jobs`: one job reporting N named units. Checked against .all, the
# whole sequence of POSTs, because the failure mode being guarded is N rows
# collapsing into one (the 2026-09-02 run_id collision, one level down).
batch() {
  local name=$1 want_rc=$2 want_rows=$3 want_out=$4; shift 5
  local rec="$work/payload.json" out rc rows
  rm -f "$rec" "$rec.all"
  set +e
  out=$(env -i PATH="$work/bin:$PATH" HOME="$work" CURL_RECORD="$rec" \
        JOB_NAME=selftest:batch SERVICE_KEY=k OUTCOME=success STARTED_AT= \
        ERROR_MESSAGE= TIMEOUT_MINUTES= EXTRA_JOBS= RUN_ID=7 RUN_URL=https://example.invalid/run \
        "$@" bash "$work/body.sh" 2>&1)
  rc=$?
  set -e
  # jq -s on a missing file prints `[]` AND exits non-zero, so a `||` fallback
  # would yield two lines rather than one.
  rows='[]'
  [ -s "$rec.all" ] && rows=$(jq -s -c '[.[] | {n: .job_name, s: .status, r: .run_id}]' "$rec.all")
  if [ "$rc" != "$want_rc" ] || [ "$rows" != "$want_rows" ] || [[ "$out" != *"$want_out"* ]]; then
    echo "FAIL $name: exit=$rc"
    echo "  rows   $rows"
    echo "  wanted $want_rows (exit=$want_rc, output~'$want_out')"
    echo "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

# The job's own row first, then one per entry, each with its OWN run_id slug —
# that suffix is the only thing stopping the upsert from folding them together.
batch 'every entry gets its own row' 0 \
  '[{"n":"selftest:batch","s":"succeeded","r":"gha_7_selftest-batch"},{"n":"site:deploy-worker:task-api","s":"succeeded","r":"gha_7_site-deploy-worker-task-api"},{"n":"site:deploy-worker:prefs-api","s":"failed","r":"gha_7_site-deploy-worker-prefs-api"}]' \
  'reported site:deploy-worker:prefs-api=failed' \
  -- EXTRA_JOBS='[{"name":"site:deploy-worker:task-api","outcome":"success"},{"name":"site:deploy-worker:prefs-api","outcome":"failure"}]'

# A failing unit must not hide the ones after it: the loop keeps going, and the
# job's own outcome is whatever the caller passed.
batch 'a failed unit does not stop the rest' 0 \
  '[{"n":"selftest:batch","s":"failed","r":"gha_7_selftest-batch"},{"n":"a:one","s":"failed","r":"gha_7_a-one"},{"n":"b:two","s":"succeeded","r":"gha_7_b-two"}]' \
  'reported b:two=succeeded' \
  -- OUTCOME=failure EXTRA_JOBS='[{"name":"a:one","outcome":"failure"},{"name":"b:two","outcome":"success"}]'

# A unit the job never reached carries no outcome. Not malformed — skipped,
# the same as a cancelled job, so no row claims it ran.
batch 'an empty outcome is skipped, not refused' 0 \
  '[{"n":"selftest:batch","s":"succeeded","r":"gha_7_selftest-batch"},{"n":"c:three","s":"succeeded","r":"gha_7_c-three"}]' \
  'extra-jobs[0] a:unreached outcome= — not reported' \
  -- EXTRA_JOBS='[{"name":"a:unreached","outcome":""},{"name":"c:three","outcome":"success"}]'

# Per-entry durations, because the work is sequential and the job's own
# duration is not any one unit's: the job here has no started-at (0ms) while
# its entry reports 45s. Asserted as a range, not a value — this harness takes
# a second or two to reach the case.
rm -f "$work/payload.json" "$work/payload.json.all"
env -i PATH="$work/bin:$PATH" HOME="$work" CURL_RECORD="$work/payload.json" \
  JOB_NAME=selftest:batch SERVICE_KEY=k OUTCOME=success STARTED_AT= \
  ERROR_MESSAGE= TIMEOUT_MINUTES= RUN_ID=7 RUN_URL=https://example.invalid/run \
  EXTRA_JOBS="[{\"name\":\"d:four\",\"outcome\":\"success\",\"started-at\":$(( $(date -u +%s) - 45 ))}]" \
  bash "$work/body.sh" > /dev/null 2>&1
own=$(jq -s -r '.[0].duration_ms' "$work/payload.json.all")
entry=$(jq -s -r '.[1].duration_ms' "$work/payload.json.all")
if [ "$own" = "0" ] && [ "$entry" -ge 45000 ] && [ "$entry" -lt 55000 ]; then
  echo "ok   each entry times itself (job ${own}ms, entry ${entry}ms)"
else
  echo "FAIL each entry times itself: job=${own}ms entry=${entry}ms (wanted job 0ms, entry ~45000ms)"
  fails=$((fails + 1))
fi

# A caller error message survives to the row.
run 'an entry carries its own error' 0 failed 'migrations refused' -- \
  EXTRA_JOBS='[{"name":"e:five","outcome":"failure","error":"migrations refused"}]'

# Malformed input is REFUSED, never skipped — an entry silently dropped is the
# silence this action exists to end. Each case stops before any entry posts.
batch 'a non-array is refused' 1 '[{"n":"selftest:batch","s":"succeeded","r":"gha_7_selftest-batch"}]' \
  'extra-jobs must be a JSON array' -- EXTRA_JOBS='{"name":"f:six","outcome":"success"}'
batch 'a non-object entry is refused' 1 '[{"n":"selftest:batch","s":"succeeded","r":"gha_7_selftest-batch"}]' \
  'extra-jobs[0] must be an object' -- EXTRA_JOBS='["g:seven"]'
batch 'a colon-less entry name is refused' 1 '[{"n":"selftest:batch","s":"succeeded","r":"gha_7_selftest-batch"}]' \
  'extra-jobs[0].name must be "worker:job"' -- EXTRA_JOBS='[{"name":"nocolon","outcome":"success"}]'
batch 'a non-numeric started-at is refused' 1 '[{"n":"selftest:batch","s":"succeeded","r":"gha_7_selftest-batch"}]' \
  'extra-jobs[0].started-at must be epoch seconds' \
  -- EXTRA_JOBS='[{"name":"h:eight","outcome":"success","started-at":"yesterday"}]'

# A superseded or keyless job reports NOTHING, not a partial set of its units.
batch 'a cancelled job posts no entries' 0 '[]' 'outcome=cancelled — not reported' \
  -- OUTCOME=cancelled EXTRA_JOBS='[{"name":"i:nine","outcome":"success"}]'
batch 'an unset key posts no entries' 0 '[]' 'service key unset' \
  -- SERVICE_KEY= EXTRA_JOBS='[{"name":"j:ten","outcome":"success"}]'

# What a failed POST says. A hosted runner is challenged by Cloudflare before
# any worker runs, and the warning has to name that, not "could not report".
said() {
  local name=$1 want=$2; shift 2
  local out
  out=$(env -i PATH="$work/bin:$PATH" HOME="$work" CURL_RECORD="$work/said.json" \
        JOB_NAME=selftest:said SERVICE_KEY=k OUTCOME=success STARTED_AT= \
        ERROR_MESSAGE= TIMEOUT_MINUTES= EXTRA_JOBS= RUN_ID=1 RUN_URL=https://example.invalid/run \
        "$@" bash "$work/body.sh" 2>&1)
  if [[ "$out" == *"$want"* ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name: wanted '$want' in:"
    echo "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  fi
}
said 'a 2xx is reported'                 'reported selftest:said=succeeded'
said 'a Cloudflare challenge is named'   'Cloudflare challenged this runner (HTTP 403)' FAKE_CODE=403 FAKE_HEADERS='server: cloudflare\ncf-mitigated: challenge\n'
said 'any other refusal shows its code'  'could not report selftest:said to monitoring-api (HTTP 403)' FAKE_CODE=403 FAKE_HEADERS='content-type: application/json\n'

if [ "$fails" -gt 0 ]; then
  echo "::error::$fails report-job case(s) failed"
  exit 1
fi
echo "all report-job cases passed"
