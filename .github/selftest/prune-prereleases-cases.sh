#!/usr/bin/env bash
# Runs prune-prereleases/prune.sh, the real file, against a stand-in curl that
# serves a fixture release list and records every DELETE.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

# GET …/releases?…&page=N prints $PAGES/N.json (an empty list past the end);
# a DELETE is recorded as "DELETE <path>" and answers $TAG_CODE to a -w.
cat > "$work/bin/curl" <<'SH'
#!/usr/bin/env bash
method=GET; fmt=; url=
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift ;;
    -w) fmt=$2; shift ;;
    -o|-m|-A|-H) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
path=${url#*/repos/o/r/}
if [ "$method" = DELETE ]; then
  echo "DELETE $path" >> "$DELETES"
  [ -z "$fmt" ] || printf '%s' "${TAG_CODE:-204}"
  exit 0
fi
[ -z "${LIST_FAILS:-}" ] || exit 22
page=${path##*page=}
if [ -f "$PAGES/$page.json" ]; then cat "$PAGES/$page.json"; else echo '[]'; fi
SH
chmod +x "$work/bin/curl"

rel() { # id tag created prerelease
  printf '{"id":%s,"tag_name":"%s","created_at":"%s","prerelease":%s}' "$1" "$2" "$3" "$4"
}
fixture() { # one page: every argument is a release object
  rm -rf "$work/pages"; mkdir "$work/pages"
  (IFS=,; echo "[$*]") > "$work/pages/1.json"
}

fails=0
# case <name> <want-exit> <want-deletes, space separated, in order> (env: KEEP, PREFIX, DRY, TAG_CODE, LIST_FAILS)
case_() {
  local name=$1 want_rc=$2 want=$3
  : > "$work/deletes"; : > "$work/out"
  local rc=0
  env -i PATH="$work/bin:$PATH" HOME="$work" GITHUB_OUTPUT="$work/out" \
    DELETES="$work/deletes" PAGES="$work/pages" TAG_CODE="${TAG_CODE-}" LIST_FAILS="${LIST_FAILS-}" \
    PRUNE_PREFIX="${PREFIX-ppe-}" PRUNE_KEEP="${KEEP-2}" PRUNE_TOKEN=t PRUNE_DRY_RUN="${DRY-false}" \
    PRUNE_REPO=o/r PRUNE_API=https://example.invalid \
    bash "$root/prune-prereleases/prune.sh" > "$work/log" 2>&1 || rc=$?
  local got; got=$(tr '\n' ' ' < "$work/deletes" | sed 's/ $//')
  if [ "$rc" != "$want_rc" ] || [ "$got" != "$want" ]; then
    echo "FAIL $name: exit=$rc deletes=[$got] (wanted exit=$want_rc deletes=[$want])"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

# Listed out of order on purpose: the order is creation time, not the listing's.
fixture \
  "$(rel 3 ppe-3 2026-01-03T00:00:00Z true)" \
  "$(rel 1 ppe-1 2026-01-01T00:00:00Z true)" \
  "$(rel 9 v1.0.0 2026-01-01T12:00:00Z false)" \
  "$(rel 4 ppe-4 2026-01-04T00:00:00Z true)" \
  "$(rel 8 rc-1 2026-01-01T06:00:00Z true)" \
  "$(rel 7 ppe-old-but-released 2025-01-01T00:00:00Z false)" \
  "$(rel 2 ppe-2 2026-01-02T00:00:00Z true)"

case_ 'keeps the newest 2, deletes the rest oldest-last, each with its tag' 0 \
  'DELETE releases/2 DELETE git/refs/tags/ppe-2 DELETE releases/1 DELETE git/refs/tags/ppe-1'
grep -q '^deleted=2$' "$work/out" || { echo 'FAIL deleted output'; fails=$((fails + 1)); }

KEEP=10 case_ 'fewer than keep: nothing deleted' 0 ''
grep -q '^deleted=0$' "$work/out" || { echo 'FAIL deleted=0 output'; fails=$((fails + 1)); }

# A full release whose tag has the prefix, and a prerelease with another
# prefix, are never candidates: only 4 ppe-* prereleases exist.
KEEP=1 case_ 'a full release and another prefix are never touched' 0 \
  'DELETE releases/3 DELETE git/refs/tags/ppe-3 DELETE releases/2 DELETE git/refs/tags/ppe-2 DELETE releases/1 DELETE git/refs/tags/ppe-1'

DRY=true case_ 'a dry run deletes nothing and says what it would' 0 ''
grep -q 'would delete ppe-1' "$work/log" && grep -q '^deleted=2$' "$work/out" \
  || { echo 'FAIL dry-run report'; sed 's/^/    /' "$work/log"; fails=$((fails + 1)); }

TAG_CODE=422 case_ 'a tag that is already gone is fine' 0 \
  'DELETE releases/2 DELETE git/refs/tags/ppe-2 DELETE releases/1 DELETE git/refs/tags/ppe-1'
TAG_CODE=403 case_ 'a tag it may not delete fails the step' 1 \
  'DELETE releases/2 DELETE git/refs/tags/ppe-2'

PREFIX='' case_ 'an empty prefix is refused: it would match everything' 1 ''
KEEP=0 case_ 'keep 0 is refused: the newest is the one being served'    1 ''
KEEP=all case_ 'a non-numeric keep is refused'                           1 ''
LIST_FAILS=1 case_ 'an unreadable listing deletes nothing'               1 ''

# Paging: 100 on the first page means there is a second. 105 prereleases, keep
# 2: all but the two newest go, including the five only page 2 lists.
rm -rf "$work/pages"; mkdir "$work/pages"
mk() { local i=$1; rel "$i" "ppe-$i" "2026-02-01T00:$(printf '%02d' $((i / 60))):$(printf '%02d' $((i % 60)))Z" true; }
(first=1; printf '['; for i in $(seq 1 100); do [ $first = 1 ] || printf ','; first=0; mk "$i"; done; printf ']') > "$work/pages/1.json"
(first=1; printf '['; for i in $(seq 101 105); do [ $first = 1 ] || printf ','; first=0; mk "$i"; done; printf ']') > "$work/pages/2.json"
: > "$work/deletes"; : > "$work/out"
env -i PATH="$work/bin:$PATH" HOME="$work" GITHUB_OUTPUT="$work/out" DELETES="$work/deletes" PAGES="$work/pages" \
  PRUNE_PREFIX=ppe- PRUNE_KEEP=2 PRUNE_TOKEN=t PRUNE_REPO=o/r PRUNE_API=https://example.invalid \
  bash "$root/prune-prereleases/prune.sh" > "$work/log" 2>&1
if grep -q '^deleted=103$' "$work/out" && ! grep -qE 'releases/(104|105)$' "$work/deletes" \
  && grep -q 'releases/103$' "$work/deletes" && grep -q 'releases/1$' "$work/deletes"; then
  echo 'ok   reads every page: 105 listed, the newest 2 kept'
else
  echo 'FAIL paging'; tail -5 "$work/log"; cat "$work/out"; fails=$((fails + 1))
fi

if [ "$fails" -gt 0 ]; then echo "::error::$fails prune-prereleases case(s) failed"; exit 1; fi
