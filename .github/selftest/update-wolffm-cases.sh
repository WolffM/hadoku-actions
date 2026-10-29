#!/usr/bin/env bash
# Runs update-wolffm's commit-and-promote shell against a throwaway origin,
# WITHOUT the composite wrapper. The body is EXTRACTED from action.yml on every
# run, never retyped: a copy here would keep passing after the action changed
# under it.
#
# repo-action/call.sh is a stand-in that records the promote and fast-forwards
# the origin's main onto the bot branch, so each case asserts whether a promote
# happened at all — the 2026-10-28 re-run that conflicted with its own landed
# commit must end green WITHOUT one, and a real conflict must still fail.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 - "$root/update-wolffm/action.yml" "$work/body.sh" <<'PY'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["runs"]["steps"]
body = next(s for s in steps if s.get("id") == "commit")["run"]
# The env block is where expressions belong. One in the body would be
# substituted by the runner and NOT by this harness, so the two would differ.
assert "${{" not in body, "an expression in the run body is untestable here"
open(sys.argv[2], "w").write(body)
PY

mkdir -p "$work/action/update-wolffm" "$work/action/repo-action"
cat > "$work/action/repo-action/call.sh" <<'SH'
#!/usr/bin/env bash
echo promote >> "$PROMOTES"
git push -q origin HEAD:refs/heads/main
SH

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fails=0

# state <dir> <task-ui-components> <themes> <themes integrity>
state() {
  cat > "$1/package.json" <<JSON
{
  "name": "selftest",
  "devDependencies": {
    "@wolffm/task-ui-components": "^$2",
    "@wolffm/themes": "^$3"
  }
}
JSON
  cat > "$1/pnpm-lock.yaml" <<YAML
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@wolffm/task-ui-components': $2
      '@wolffm/themes': $3
packages:
  themes: $4
YAML
}

# commit_on_main <state args...>: someone lands a commit on origin's main.
commit_on_main() {
  rm -rf "$work/other"
  git clone -q "$work/origin.git" "$work/other"
  state "$work/other" "$@"
  git -C "$work/other" commit -qam "landed on main"
  git -C "$work/other" push -q origin HEAD:main
}

# case_ <name> <want-exit> <want-changed> <want-promotes> <main-moves: none|args...> -- <bump args...>
# The checkout is taken BEFORE main moves, as a dispatch pins it.
case_() {
  local name=$1 want_rc=$2 want_changed=$3 want_promotes=$4; shift 4
  local moves=()
  while [ "$1" != -- ]; do moves+=("$1"); shift; done; shift
  rm -rf "$work/origin.git" "$work/seed" "$work/co"
  git init -q --bare -b main "$work/origin.git"
  git init -q -b main "$work/seed"
  state "$work/seed" 4.20.5 5.12.18 old
  git -C "$work/seed" add -A && git -C "$work/seed" commit -qm seed
  git -C "$work/seed" push -q "$work/origin.git" HEAD:main
  git clone -q "$work/origin.git" "$work/co"
  [ "${moves[0]}" = none ] || commit_on_main "${moves[@]}"
  state "$work/co" "$@"
  : > "$work/promotes"; : > "$work/out"
  local rc=0
  (cd "$work/co" && env PROMOTES="$work/promotes" GITHUB_OUTPUT="$work/out" \
    GITHUB_ACTION_PATH="$work/action/update-wolffm" \
    BOT_BRANCH=bot/update-wolffm DEFAULT_BRANCH=main \
    REPO_ACTION_KEY=k REPO_ACTION_BROKER=https://example.invalid/mgmt REPO_ACTION_VERB=promote \
    bash -e -o pipefail "$work/body.sh") > "$work/log" 2>&1 || rc=$?
  local changed promotes
  changed=$(sed -n 's/^changed=//p' "$work/out")
  promotes=$(wc -l < "$work/promotes" | tr -d ' ')
  if [ "$rc" != "$want_rc" ] || [ "$changed" != "$want_changed" ] || [ "$promotes" != "$want_promotes" ]; then
    echo "FAIL $name: exit=$rc changed=$changed promotes=$promotes (wanted exit=$want_rc changed=$want_changed promotes=$want_promotes)"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

case_ 'a fresh bump is promoted'                       0 true  1 none                  -- 4.20.6 5.12.19 new
case_ 'nothing to bump: no commit, no promote'         0 false 0 none                  -- 4.20.5 5.12.18 old
# 2026-10-28: attempt 1 landed the bump, attempt 2 replayed it from the stale
# dispatch checkout and its lockfile came out different.
case_ 're-run after a landed bump, lockfile differs'   0 false 0 4.20.6 5.12.19 landed -- 4.20.6 5.12.19 new
case_ 're-run after a landed bump, identical'          0 false 0 4.20.6 5.12.19 new    -- 4.20.6 5.12.19 new
case_ 'main already moved PAST the bump'               0 false 0 4.20.7 5.13.0 later   -- 4.20.6 5.12.19 new
# main carries only part of the bump: task-ui-components is still older there.
case_ 'main carries part of the bump: a real conflict' 1 ''    0 4.20.5 5.12.19 landed -- 4.20.6 5.12.19 new
case_ 'main moved elsewhere, lockfile-only bump'       1 ''    0 4.20.5 5.12.18 other  -- 4.20.5 5.12.18 new

if [ "$fails" -gt 0 ]; then
  echo "::error::$fails update-wolffm case(s) failed"
  exit 1
fi
echo "all update-wolffm cases pass"
