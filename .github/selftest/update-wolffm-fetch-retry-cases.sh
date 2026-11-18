#!/usr/bin/env bash
# Runs update-wolffm's update step against a stand-in pnpm, WITHOUT the
# composite wrapper. The body is EXTRACTED from action.yml on every run, never
# retyped: a copy here would keep passing after the action changed under it.
#
# The stand-in fails its first N calls with a chosen error, then succeeds, and
# records the arguments of every call. Every attempt must install the SAME
# pinned specs the mirror step resolved (#7: re-reading latest chased a publish
# burst). A 404 on an npmjs tarball, or a version npmjs does not list yet, must
# be retried until the shared deadline; any other failure must fail at once,
# and a race that outlasts the deadline must still fail.
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
echo "$*" >> "$ARGS"
if [ "$n" -le "$FAIL_TIMES" ]; then
  echo "[$FAIL_ERROR] GET $FAIL_URL: Not Found - 404"
  exit 1
fi
echo "Done in 1.0s"
SH
chmod +x "$work/bin/pnpm"

NPMJS='https://registry.npmjs.org/@hadoku/rooms-protocol/-/rooms-protocol-0.45.32.tgz'
# pnpm's real line: "No matching version found for @wolffm/rooms-protocol@npm:
# @hadoku/rooms-protocol@0.45.34 while fetching it from https://registry.npmjs.org/"
NPMJS_META='https://registry.npmjs.org/'
GHP='https://npm.pkg.github.com/download/@wolffm/rooms-protocol/0.45.32/abc'
fails=0

SPECS='@wolffm/rooms-protocol@npm:@hadoku/rooms-protocol@0.45.32 @wolffm/logger@1.4.4'
WANT_ARGS="--config.store-dir=$work/pnpm-store update @wolffm/rooms-protocol@npm:@hadoku/rooms-protocol@0.45.32 @wolffm/logger@1.4.4"

# case_ <name> <want-exit> <want-calls|any> <fail-times> <error> <url> [deadline-s] [specs]
case_() {
  local name=$1 want_rc=$2 want_calls=$3 rc=0 specs=${8-$SPECS}
  rm -f "$work/calls" "$work/args"
  env PATH="$work/bin:$PATH" CALLS="$work/calls" ARGS="$work/args" FAIL_TIMES="$4" FAIL_ERROR="$5" FAIL_URL="$6" \
    RECURSIVE=false RUNNER_TOOL_CACHE="$work" SPECS="$specs" RETRY_S=0 WAIT_BUDGET_S=60 \
    DEADLINE=$(( $(date -u +%s) + ${7:-60} )) \
    bash -e -o pipefail "$work/body.sh" > "$work/log" 2>&1 || rc=$?
  local calls; calls=$(cat "$work/calls" 2>/dev/null || echo 0)
  # Every attempt installed exactly the pinned specs, never a moving "latest".
  local pinned=yes
  if [ -s "$work/args" ] && grep -vqxF -- "$WANT_ARGS" "$work/args"; then pinned=no; fi
  if [ "$rc" != "$want_rc" ] || { [ "$want_calls" != any ] && [ "$calls" != "$want_calls" ]; } || [ "$pinned" != yes ]; then
    echo "FAIL $name: exit=$rc calls=$calls pinned=$pinned (wanted $want_rc, $want_calls, yes)"
    sed 's/^/    /' "$work/log" "$work/args" 2>/dev/null
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

case_ 'a clean update runs once, with the pinned specs'   0 1 0 ERR_PNPM_FETCH_404 "$NPMJS"
case_ 'an npmjs tarball 404 is retried until it lands'     0 3 2 ERR_PNPM_FETCH_404 "$NPMJS"
case_ 'a 404 that outlasts the deadline still fails'       1 any 999999 ERR_PNPM_FETCH_404 "$NPMJS" 1
case_ 'nothing resolved: no install at all'                0 0 9 ERR_PNPM_FETCH_404 "$NPMJS" 60 ''
case_ 'any other error fails at once'                      1 1 9 ERR_PNPM_FETCH_401 "$NPMJS"
case_ 'a 404 from GitHub Packages is not the mirror race'  1 1 9 ERR_PNPM_FETCH_404 "$GHP"
case_ 'a version npmjs does not list yet is retried'      0 3 2 ERR_PNPM_NO_MATCHING_VERSION "$NPMJS_META"
case_ 'no such version on GitHub Packages fails at once'   1 1 9 ERR_PNPM_NO_MATCHING_VERSION 'https://npm.pkg.github.com/'

[ "$fails" = 0 ] || { echo "$fails case(s) failed"; exit 1; }
