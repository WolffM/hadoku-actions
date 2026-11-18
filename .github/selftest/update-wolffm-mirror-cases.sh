#!/usr/bin/env bash
# Runs update-wolffm's resolve-and-wait script (update-wolffm/resolve-targets.mjs,
# the file action.yml runs, not a copy) against a stand-in npm and a local
# tarball server.
#
# The stand-in answers GitHub Packages with $GH (or fails when it is empty).
# npmjs lists the asked version only after $LAG asks; its dist.tarball points
# at the local server, which 404s until $TGZ_LAG asks have passed, and its
# dependencies are $DEPS. $NEVER is a name npmjs never lists. Every @wolffm dependency must be pinned to what
# GitHub Packages calls latest, an @hadoku/* alias must wait until npmjs both
# lists it and serves its tarball, and so must an @hadoku/* version it pins
# exactly; a mirror that never catches up must fail inside the budget.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
script="$root/update-wolffm/resolve-targets.mjs"
grep -q 'resolve-targets.mjs' "$root/update-wolffm/action.yml" || { echo "::error::action.yml no longer runs resolve-targets.mjs"; exit 1; }
work=$(mktemp -d)
server_pid=''
trap '[ -n "$server_pid" ] && kill "$server_pid"; rm -rf "$work"' EXIT

# 404 for a tarball until it has been asked for $TGZ_LAG times, then 200.
cat > "$work/server.py" <<'PY'
import http.server, os, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        counts = self.server.counts
        counts[self.path] = counts.get(self.path, 0) + 1
        lag = int(open(os.environ["TGZ_LAG_FILE"]).read())
        self.send_response(200 if counts[self.path] > lag else 404)
        self.end_headers()
    def log_message(self, *a):
        pass
class S(http.server.ThreadingHTTPServer):
    counts = {}
    def server_activate(self):
        super().server_activate()
        open(sys.argv[1], "w").write(str(self.server_address[1]))
S(("127.0.0.1", 0), H).serve_forever()
PY
echo 0 > "$work/tgz-lag"
TGZ_LAG_FILE="$work/tgz-lag" python3 "$work/server.py" "$work/port" &
server_pid=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
port=$(cat "$work/port")

mkdir "$work/bin"
cat > "$work/bin/npm" <<'NPM'
#!/usr/bin/env bash
# npm view <spec> <field> --json --registry=<r>
spec=$2 field=$3
case "$*" in
  *npm.pkg.github.com*) [ -n "$GH" ] && echo "\"$GH\"" || exit 1 ;;
  *registry.npmjs.org*)
    [ "$field" = version ] && { echo "\"$NPMJS_LATEST\""; exit 0; }
    n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CALLS"
    [ "$n" -gt "$LAG" ] || exit 0
    name=${spec%@*} version=${spec##*@}
    [ "$name" = "$NEVER" ] && exit 0
    case "$field" in
      dist.tarball) echo "\"http://127.0.0.1:$PORT/${name}-${version}.tgz\"" ;;
      dependencies) [ "$name" = "$DEPS_OF" ] && echo "$DEPS" ;;
    esac ;;
esac
exit 0
NPM
chmod +x "$work/bin/npm"

git init -q "$work/repo"
fails=0

# case_ <name> <want-exit> <want-specs> <package.json> <gh-latest> <lag> <tgz-lag> <budget-s> [deps]
case_() {
  local name=$1 want_rc=$2 want_specs=$3 deps=${9:-'{}'} rc=0
  printf '%s' "$4" > "$work/repo/package.json"; git -C "$work/repo" add package.json
  rm -f "$work/calls"; : > "$work/out"
  echo "$7" > "$work/tgz-lag"
  # The server counts per path, so each case asks for a version of its own.
  (cd "$work/repo" && env PATH="$work/bin:$PATH" CALLS="$work/calls" GH="$5" LAG="$6" PORT="$port" \
    NPMJS_LATEST=5.13.29 DEPS_OF=@hadoku/themes DEPS="$deps" NEVER=@hadoku/logger RECURSIVE=false \
    WAIT_BUDGET_S="$8" POLL_S=0.2 GITHUB_OUTPUT="$work/out" node "$script") > "$work/log" 2>&1 || rc=$?
  local specs; specs=$(sed -n 's/^specs=//p' "$work/out")
  if [ "$rc" != "$want_rc" ] || [ "$specs" != "$want_specs" ]; then
    echo "FAIL $name: exit=$rc specs='$specs' (wanted $want_rc, '$want_specs')"
    sed 's/^/    /' "$work/log"
    fails=$((fails + 1))
  else
    echo "ok   $name"
  fi
}

ALIAS='{ "name": "t", "dependencies": { "@wolffm/themes": "npm:@hadoku/themes@5.13.29" } }'
PLAIN='{ "name": "t", "dependencies": { "@wolffm/themes": "^5.13.29" } }'
BOTH='{ "name": "t", "dependencies": { "@wolffm/themes": "npm:@hadoku/themes@5.13.29" }, "devDependencies": { "@wolffm/themes": "^5.13.29" } }'
A=@wolffm/themes@npm:@hadoku/themes

case_ 'npmjs already serves the latest'                0 "$A@5.13.30" "$ALIAS" 5.13.30 0  0  30
case_ 'npmjs lags two asks, then lands'                0 "$A@5.13.31" "$ALIAS" 5.13.31 2  0  30
case_ 'listed, but its tarball 404s twice first'       0 "$A@5.13.32" "$ALIAS" 5.13.32 0  2  30
case_ 'npmjs never lists it: fails at budget'          1 ''           "$ALIAS" 5.13.33 99 0  1
case_ 'its tarball never serves: fails at budget'      1 ''           "$ALIAS" 5.13.34 0  99 1
case_ 'an exact @hadoku dependency is waited on too'   1 ''           "$ALIAS" 5.13.35 0  0  1 \
  '{"@wolffm/logger":"npm:@hadoku/logger@1.4.99"}'
case_ 'a ranged @hadoku dependency is not'             0 "$A@5.13.36" "$ALIAS" 5.13.36 0  0  30 \
  '{"@wolffm/logger":"npm:@hadoku/logger@^1.4.99"}'
case_ 'plain @wolffm: pinned, nothing to wait for'     0 '@wolffm/themes@5.13.30' "$PLAIN" 5.13.30 99 99 1
case_ 'GitHub Packages unreadable: npmjs latest'       0 "$A@5.13.29" "$ALIAS" ''      0  0  30
case_ 'one name as alias and plain: refused'           1 ''           "$BOTH"  5.13.30 0  0  30

if [ "$fails" -gt 0 ]; then
  echo "::error::$fails update-wolffm mirror case(s) failed"
  exit 1
fi
echo "all update-wolffm mirror cases pass"
