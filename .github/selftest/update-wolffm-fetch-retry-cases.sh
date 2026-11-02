#!/usr/bin/env bash
# Runs update-wolffm's update step against a stand-in pnpm, WITHOUT the
# composite wrapper. The body is EXTRACTED from action.yml on every run, never
# retyped: a copy here would keep passing after the action changed under it.
#
# The stand-in fails its first N calls with a chosen error, then succeeds. A
# 404 on an npmjs tarball (its metadata listed the version before the tarball
# could be fetched) must be retried; any other failure must fail at once, and a
# 404 that outlasts every retry must still fail.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 - "$root/update-wolffm/action.yml" "$work/body.sh" <<'PY'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["runs"]["steps"]
body = next(s for s in steps if s.get("id") == "update")["run"]
assert "${{" not in body, "an expression in the run body is untestable here"
open(sys.argv[2], "w").write(body)
PY

mkdir "$work/bin"
cat > "$work/bin/pnpm" <<'SH'
#!/usr/bin/env bash
n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CALLS"
if [ "$n" -le "$FAIL_TIMES" ]; then
  echo "[$FAIL_ERROR] GET $FAIL_URL: Not Found - 404"
  exit 1
fi
echo "Done in 1.0s"
SH
chmod +x "$work/bin/pnpm"

NPMJS='https://registry.npmjs.org/@hadoku/rooms-protocol/-/rooms-protocol-0.45.32.tgz'
GHP='https://npm.pkg.github.com/download/@wolffm/rooms-protocol/0.45.32/abc'
fails=0

# case_ <name> <want-exit> <want-calls> <fail-times> <error> <url>
case_() {
  local name=$1 want_rc=$2 want_calls=$3 rc=0
  rm -f "$work/calls" "$work/out"
  env PATH="$work/bin:$PATH" CALLS="$work/calls" FAIL_TIMES="$4" FAIL_ERROR="$5" FAIL_URL="$6" \
    RECURSIVE=false RUNNER_TOOL_CACHE="$work" GITHUB_OUTPUT="$work/out" FETCH_RETRY_DELAYS='0 0 0 0' \
    bash -e -o pipefail "$work/body.sh" > "$work/log" 2>&1 || rc=$?
  local calls; calls=$(cat "$work/calls" 2>/dev/null || echo 0)
  local resolved=no; grep -q '^resolved-at=[0-9]\+$' "$work/out" 2>/dev/null && resolved=yes
  local want_resolved=no; [ "$want_rc" = 0 ] && want_resolved=yes
  if [ "$rc" != "$want_rc" ] || [ "$calls" != "$want_calls" ] || [ "$resolved" != "$want_resolved" ]; then
    echo "FAIL $name: exit=$rc calls=$calls resolved-at=$resolved (wanted $want_rc, $want_calls, $want_resolved)"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

case_ 'a clean update runs once and records resolved-at'   0 1 0 ERR_PNPM_FETCH_404 "$NPMJS"
case_ 'an npmjs tarball 404 is retried until it lands'     0 3 2 ERR_PNPM_FETCH_404 "$NPMJS"
case_ 'a 404 that outlasts every retry still fails'        1 5 9 ERR_PNPM_FETCH_404 "$NPMJS"
case_ 'any other error fails at once'                      1 1 9 ERR_PNPM_FETCH_401 "$NPMJS"
case_ 'a 404 from GitHub Packages is not the mirror race'  1 1 9 ERR_PNPM_FETCH_404 "$GHP"

[ "$fails" = 0 ] || { echo "$fails case(s) failed"; exit 1; }
