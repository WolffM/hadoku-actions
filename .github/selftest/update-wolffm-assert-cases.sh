#!/usr/bin/env bash
# Runs update-wolffm's latest-version assert against registry fixtures, WITHOUT
# the composite wrapper. The body is EXTRACTED from action.yml on every run,
# never retyped: a copy here would keep passing after the action changed under
# it.
#
# npm is a stand-in on PATH that answers `npm view <name> ...` from a fixture,
# so each case pins what the registry says was published, and when, relative
# to the moment the update resolved. A release published mid-run must pass
# (its own dispatch bumps it, #1); real drift must still fail.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 - "$root/update-wolffm/action.yml" "$work/body.sh" <<'PY'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["runs"]["steps"]
body = next(s for s in steps if s.get("id") == "assert")["run"]
# The env block is where expressions belong. One in the body would be
# substituted by the runner and NOT by this harness, so the two would differ.
assert "${{" not in body, "an expression in the run body is untestable here"
open(sys.argv[2], "w").write(body)
PY

mkdir "$work/bin"
cat > "$work/bin/npm" <<'SH'
#!/usr/bin/env bash
cat "$FIXTURE" 2>/dev/null || exit 1
SH
chmod +x "$work/bin/npm"

git init -q "$work/repo"
cat > "$work/repo/package.json" <<'JSON'
{ "name": "selftest", "devDependencies": { "@wolffm/themes": "^5.12.19" } }
JSON
git -C "$work/repo" add package.json

resolved=$(date -u +%s)
iso() { date -u -d "@$(( resolved + $1 ))" +%Y-%m-%dT%H:%M:%SZ; }
fails=0

# case_ <name> <want-exit> <resolved-at> <fixture json, or '' for an unreachable registry>
case_() {
  local name=$1 want_rc=$2 at=$3 fixture=$4 rc=0
  if [ -n "$fixture" ]; then printf '%s' "$fixture" > "$work/fixture"; else rm -f "$work/fixture"; fi
  (cd "$work/repo" && env PATH="$work/bin:$PATH" FIXTURE="$work/fixture" RESOLVED_AT="$at" \
    bash -e -o pipefail "$work/body.sh") > "$work/log" 2>&1 || rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL $name: exit=$rc (wanted $want_rc)"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

old=$(iso -86400); prev=$(iso -3600); mid=$(iso 300)

case_ 'at latest'                                      0 "$resolved" \
  "{\"version\":\"5.12.19\",\"time\":{\"5.12.18\":\"$old\",\"5.12.19\":\"$prev\"}}"
case_ 'behind a release that predates the run'         1 "$resolved" \
  "{\"version\":\"5.12.20\",\"time\":{\"5.12.19\":\"$old\",\"5.12.20\":\"$prev\"}}"
# 2026-10-23: a burst published 5.12.20 while the job ran.
case_ 'latest published mid-run'                       0 "$resolved" \
  "{\"version\":\"5.12.20\",\"time\":{\"5.12.19\":\"$prev\",\"5.12.20\":\"$mid\"}}"
case_ 'latest mid-run, but an older miss predates it'  1 "$resolved" \
  "{\"version\":\"5.12.21\",\"time\":{\"5.12.19\":\"$old\",\"5.12.20\":\"$prev\",\"5.12.21\":\"$mid\"}}"
# The registry's metadata lags a publish; a release seconds before the update
# resolved is one it may not have seen, and its own dispatch is in flight.
case_ 'published seconds before the update resolved'   0 "$resolved" \
  "{\"version\":\"5.12.20\",\"time\":{\"5.12.19\":\"$prev\",\"5.12.20\":\"$(iso -30)\"}}"
case_ 'an earlier prerelease is not a miss'           0 "$resolved" \
  "{\"version\":\"5.12.20\",\"time\":{\"5.12.19\":\"$prev\",\"5.12.20-rc.1\":\"$prev\",\"5.12.20\":\"$mid\"}}"
case_ 'no publish times from the registry'             1 "$resolved" \
  '{"version":"5.12.20"}'
case_ 'no resolved-at: nothing is forgiven'            1 '' \
  "{\"version\":\"5.12.20\",\"time\":{\"5.12.19\":\"$prev\",\"5.12.20\":\"$mid\"}}"
case_ 'registry unreachable'                           1 "$resolved" ''

if [ "$fails" -gt 0 ]; then
  echo "::error::$fails update-wolffm assert case(s) failed"
  exit 1
fi
echo "all update-wolffm assert cases pass"
