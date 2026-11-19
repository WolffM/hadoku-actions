#!/usr/bin/env bash
# Runs publish-npmjs/publish/publish.sh, the real file, against a stand-in npm
# that answers `view` and `publish` from a script, and a stand-in sleep that
# records instead of waiting. Nothing here reaches a registry.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin" "$work/dir"

# `npm view` answers $VIEW ("absent", "present" or "down"). Each `npm publish`
# consumes one line of $ANSWERS, the last line repeating: "ok", or the error
# code npm should fail with ("none" fails without naming one).
cat > "$work/bin/npm" <<'SH'
#!/usr/bin/env bash
case "$1" in
  view)
    case "$VIEW" in
      present) spec=$2; echo "${spec##*@}" ;;
      absent) echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/x" >&2; exit 1 ;;
      *) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;
    esac ;;
  publish)
    printf '%s\n' "$*" >> "$ARGS"
    n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CALLS"
    line=$(sed -n "${n}p" "$ANSWERS"); [ -n "$line" ] || line=$(tail -1 "$ANSWERS")
    echo "npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access" >&2
    case "$line" in
      ok) echo "+ published" ;;
      none) echo "npm error something broke without a code" >&2; exit 1 ;;
      TLOG_CREATE_ENTRY_ERROR)
        # Verbatim from hadoku-cardtable run 44447837922.
        echo "npm error code TLOG_CREATE_ENTRY_ERROR" >&2
        echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID 108e9186e8c5677a0633b98f96aad80cee82de100d1b43e77a0f67cdd26ab4472606de44963fc59a" >&2
        exit 1 ;;
      *) echo "npm error code $line" >&2; echo "npm error the registry said no" >&2; exit 1 ;;
    esac ;;
  *) echo "fake npm: unexpected $*" >&2; exit 2 ;;
esac
SH
cat > "$work/bin/sleep" <<'SH'
#!/usr/bin/env bash
echo "$1" >> "$SLEPT"
SH
chmod +x "$work/bin/"*

# pkg <name> <version> — stages $work/dir/<file>.tgz the way publish-npmjs does
pkg() {
  local src="$work/src/package"
  rm -rf "$work/src"; mkdir -p "$src"
  printf '{"name":"%s","version":"%s"}\n' "$1" "$2" > "$src/package.json"
  tar -czf "$work/dir/$(echo "$1-$2" | tr -d @ | tr / -).tgz" -C "$work/src" package
}

fails=0
# case <name> <want-exit> <want-publish-calls> -- publish answers...   (env: VIEW, DRY)
case_() {
  local name=$1 want_rc=$2 want_calls=$3; shift 4
  : > "$work/calls"; : > "$work/slept"; : > "$work/args"
  printf '%s\n' "$@" > "$work/answers"
  local rc=0
  env -i PATH="$work/bin:$PATH" HOME="$work" TMPDIR="$work" \
    CALLS="$work/calls" SLEPT="$work/slept" ANSWERS="$work/answers" ARGS="$work/args" \
    VIEW="${VIEW-absent}" DIR="$work/dir" DRY_RUN="${DRY-false}" \
    bash "$root/publish-npmjs/publish/publish.sh" > "$work/log" 2>&1 || rc=$?
  local calls; calls=$(cat "$work/calls" 2>/dev/null || true); calls=${calls:-0}
  if [ "$rc" != "$want_rc" ] || [ "$calls" != "$want_calls" ]; then
    echo "FAIL $name: exit=$rc publishes=$calls (wanted exit=$want_rc publishes=$want_calls)"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}
must() { # <what> <fixed string> <file>
  grep -qF -- "$2" "$3" || { echo "FAIL $1"; sed 's/^/    /' "$3"; fails=$((fails + 1)); }
}
must_not() {
  ! grep -qF -- "$2" "$3" || { echo "FAIL $1"; sed 's/^/    /' "$3"; fails=$((fails + 1)); }
}

pkg @hadoku/game-ui 0.1.66

case_ 'absent, published first time'                 0 1 -- ok
must 'it says so' '📦 Published @hadoku/game-ui@0.1.66 to npmjs' "$work/log"
must 'public, to npmjs' '--access public --registry https://registry.npmjs.org/' "$work/args"
must_not 'a release takes no tag' '--tag' "$work/args"
[ ! -s "$work/slept" ] || { echo "FAIL a clean publish waited"; fails=$((fails + 1)); }

VIEW=present case_ 'already on npmjs: a no-op'       0 0 -- ok
VIEW=down case_ 'npmjs unreachable: red, no publish' 1 0 -- ok
must 'named as the lookup failing' 'could not ask npmjs whether @hadoku/game-ui@0.1.66 exists' "$work/log"

DRY=true case_ 'dry run passes --dry-run'            0 1 -- ok
must 'the flag' '--dry-run' "$work/args"
must 'and says it published nothing' 'dry run: would publish' "$work/log"

# Issue #8: the log took the entry and npm's own retry met it. Publishing again
# is the fix, and the job stays green.
case_ 'TLOG 409 once, then published'                0 2 -- TLOG_CREATE_ENTRY_ERROR ok
must 'the retry is a warning naming the code' '::warning::@hadoku/game-ui@0.1.66: the transparency log refused the provenance entry (TLOG_CREATE_ENTRY_ERROR), attempt 1 of 3' "$work/log"
must_not 'no error annotation on a publish that landed' '::error::' "$work/log"
must_not 'never blamed on the trusted publisher' 'trusted publisher' "$work/log"
[ "$(cat "$work/slept")" = 10 ] || { echo "FAIL one retry waits 10s, got: $(tr '\n' ' ' < "$work/slept")"; fails=$((fails + 1)); }

case_ 'TLOG 409 every time: red after three'         1 3 -- TLOG_CREATE_ENTRY_ERROR
must 'the error names the code' 'TLOG_CREATE_ENTRY_ERROR on all 3 attempts' "$work/log"
must 'and what to do' 'nothing was uploaded — re-run this job' "$work/log"
must_not 'and does not send the reader to npm trust' 'npm trust list' "$work/log"
[ "$(tr '\n' ' ' < "$work/slept")" = '10 20 ' ] || { echo "FAIL the waits grow, got: $(tr '\n' ' ' < "$work/slept")"; fails=$((fails + 1)); }

# The two codes that DO mean the trusted publisher keep the hint, and are not retried.
for code in E404 ENEEDAUTH; do
  case_ "$code: the trusted publisher, one try"      1 1 -- "$code"
  must "$code is named beside the hint" "npm refused @hadoku/game-ui@0.1.66 ($code) — check its trusted publisher (npm trust list @hadoku/game-ui)" "$work/log"
done

case_ 'any other code is named, one try'             1 1 -- E403
must 'named' 'npm publish of @hadoku/game-ui@0.1.66 failed: E403' "$work/log"
must_not 'no trusted-publisher guess' 'trusted publisher' "$work/log"

case_ 'a failure with no code says so'               1 1 -- none
must 'said' 'failed (exit 1) and named no error code' "$work/log"
must_not 'no trusted-publisher guess' 'trusted publisher' "$work/log"

# A prerelease stays off `latest`, and one package failing does not stop the next.
pkg @hadoku/themes 0.0.0-selftest.1
case_ 'two tarballs: the first fails, the second still publishes' 1 2 -- E403 ok
must 'the prerelease is tagged next' 'hadoku-themes-0.0.0-selftest.1.tgz --access public --registry https://registry.npmjs.org/ --tag next' "$work/args"
must 'the second landed' '📦 Published @hadoku/themes@0.0.0-selftest.1 to npmjs' "$work/log"

[ "$fails" -eq 0 ] || { echo "$fails case(s) failed"; exit 1; }
echo "all publish-npmjs/publish cases pass"
