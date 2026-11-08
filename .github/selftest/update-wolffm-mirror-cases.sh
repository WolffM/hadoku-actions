#!/usr/bin/env bash
# Runs update-wolffm's mirror wait against a stand-in npm, WITHOUT the
# composite wrapper. The body is EXTRACTED from action.yml on every run, never
# retyped: a copy here would keep passing after the action changed under it.
#
# The stand-in answers GitHub Packages with $GH (or fails when it is empty), and
# npmjs with nothing for its first $LAG asks, then the version asked for. An
# @hadoku/* alias must wait until npmjs serves what GitHub Packages calls latest;
# a mirror that never catches up must fail inside the budget; a repo with no
# alias, or an unreadable GitHub Packages, must not wait at all.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 - "$root/update-wolffm/action.yml" "$work/body.sh" <<'PY'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["runs"]["steps"]
body = next(s for s in steps if s.get("id") == "mirror")["run"]
assert "${{" not in body, "an expression in the run body is untestable here"
open(sys.argv[2], "w").write(body)
PY

mkdir "$work/bin"
cat > "$work/bin/npm" <<'NPM'
#!/usr/bin/env bash
spec=$2
case "$*" in
  *npm.pkg.github.com*) [ -n "$GH" ] && echo "$GH" || exit 1 ;;
  *registry.npmjs.org*)
    n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CALLS"
    [ "$n" -gt "$LAG" ] && echo "${spec##*@}" ;;
esac
exit 0
NPM
chmod +x "$work/bin/npm"

git init -q "$work/repo"
fails=0

# case_ <name> <want-exit> <want-npmjs-asks> <package.json> <gh-latest> <lag> <budget-s>
case_() {
  local name=$1 want_rc=$2 want_asks=$3 rc=0
  printf '%s' "$4" > "$work/repo/package.json"; git -C "$work/repo" add package.json
  rm -f "$work/calls"
  (cd "$work/repo" && env PATH="$work/bin:$PATH" CALLS="$work/calls" GH="$5" LAG="$6" \
    MIRROR_WAIT_S="$7" MIRROR_POLL_S=0 bash -e -o pipefail "$work/body.sh") > "$work/log" 2>&1 || rc=$?
  local asks; asks=$(cat "$work/calls" 2>/dev/null || echo 0)
  if [ "$rc" != "$want_rc" ] || [ "$asks" != "$want_asks" ]; then
    echo "FAIL $name: exit=$rc npmjs-asks=$asks (wanted $want_rc, $want_asks)"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

ALIAS='{ "name": "t", "dependencies": { "@wolffm/themes": "npm:@hadoku/themes@5.13.29" } }'
PLAIN='{ "name": "t", "dependencies": { "@wolffm/themes": "^5.13.29" } }'

case_ 'npmjs already serves the latest'          0 1 "$ALIAS" 5.13.30 0 30
case_ 'npmjs lags two asks, then lands'          0 3 "$ALIAS" 5.13.30 2 30
case_ 'npmjs never catches up: fails at budget'  1 1 "$ALIAS" 5.13.30 99 0
case_ 'no @hadoku alias: nothing to wait for'    0 0 "$PLAIN" 5.13.30 99 0
case_ 'GitHub Packages unreadable: no wait'      0 0 "$ALIAS" ''      99 0

if [ "$fails" -gt 0 ]; then
  echo "::error::$fails update-wolffm mirror case(s) failed"
  exit 1
fi
echo "all update-wolffm mirror cases pass"
