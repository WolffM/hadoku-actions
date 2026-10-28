#!/usr/bin/env bash
# Runs publish-npmjs/prepare.mjs against built-on-the-fly tarballs. Everything
# here stops before the publish: a real one is permanent, so the cases prove
# the rewrite and every refusal instead, and the first real caller proves the
# npm call itself.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fails=0

# tarball <case> <package.json> [path content]... — writes $work/<case>.tgz
tarball() {
  local name=$1 json=$2
  shift 2
  local dir="$work/src-$name/package"
  mkdir -p "$dir"
  printf '%s\n' "$json" > "$dir/package.json"
  while [ $# -gt 0 ]; do
    mkdir -p "$(dirname "$dir/$1")"
    printf '%s\n' "$2" > "$dir/$1"
    shift 2
  done
  tar -czf "$work/$name.tgz" -C "$work/src-$name" package
}

# run <case> <expect-exit> <must-print> [must-not-print]
run() {
  local name=$1 want=$2 needle=$3 forbidden=${4:-}
  local code=0
  node "$root/publish-npmjs/prepare.mjs" "$work/$name.tgz" "$work/out-$name" > "$work/$name.log" 2>&1 || code=$?
  if [ "$code" != "$want" ]; then
    echo "FAIL $name: exit $code, want $want"; cat "$work/$name.log"; fails=$((fails + 1)); return
  fi
  if ! grep -qF -- "$needle" "$work/$name.log"; then
    echo "FAIL $name: output lacks '$needle'"; cat "$work/$name.log"; fails=$((fails + 1)); return
  fi
  if [ -n "$forbidden" ] && grep -qF -- "$forbidden" "$work/$name.log"; then
    echo "FAIL $name: output contains '$forbidden'"; fails=$((fails + 1)); return
  fi
  echo "ok   $name"
}

tarball clean '{"name":"@wolffm/themes","version":"1.2.3",
  "dependencies":{"@wolffm/prefs-client":"^1.0.19","zod":"^4.0.0"},
  "peerDependencies":{"@wolffm/task-ui-components":">=4"},
  "devDependencies":{"@wolffm/logger":"1.0.0"},
  "scripts":{"build":"tsc","prepack":"pnpm build","postinstall":"node setup.js"},
  "publishConfig":{"registry":"https://npm.pkg.github.com"}}' \
  dist/index.js 'export const x = 1;'
run clean 0 '@wolffm/themes -> @hadoku/themes@1.2.3'
pkg="$work/out-clean/package/package.json"
check() {
  if [ "$(node -p "JSON.stringify(require('$pkg')$1)")" = "$2" ]; then echo "ok   clean: $1"
  else echo "FAIL clean: $1 = $(node -p "JSON.stringify(require('$pkg')$1)"), want $2"; fails=$((fails + 1)); fi
}
check '.name' '"@hadoku/themes"'
check '.dependencies["@wolffm/prefs-client"]' '"npm:@hadoku/prefs-client@^1.0.19"'
check '.dependencies.zod' '"^4.0.0"'
check '.peerDependencies["@wolffm/task-ui-components"]' '">=4"'
check '.devDependencies' 'undefined'
check '.publishConfig' 'undefined'
check '.scripts' '{"postinstall":"node setup.js"}'

tarball not-public '{"name":"@wolffm/dev-vault","version":"1.0.0"}'
run not-public 1 '@wolffm/dev-vault is not in public-packages.json'

tarball private-dep '{"name":"@wolffm/themes","version":"1.0.0","dependencies":{"@wolffm/logger":"1.0.0"}}'
run private-dep 1 'dependencies: @wolffm/logger is not public'

tarball private-peer '{"name":"@wolffm/themes","version":"1.0.0","peerDependencies":{"@wolffm/logger":"*"}}'
run private-peer 1 'peerDependencies: @wolffm/logger is not public'

tarball unresolved '{"name":"@wolffm/themes","version":"1.0.0","dependencies":{"@wolffm/prefs-client":"workspace:*"}}'
run unresolved 1 'has spec "workspace:*"'

# Assembled at run time so this file does not itself look like a credential.
fake_token="ghp_$(printf 'A%.0s' $(seq 36))"
tarball token '{"name":"@wolffm/themes","version":"1.0.0"}' dist/a.js "const t = '$fake_token';"
run token 1 'dist/a.js:1: GitHub token' "$fake_token"

tarball home-path '{"name":"@wolffm/themes","version":"1.0.0"}' dist/a.js.map '{"sources":["/home/someone/repo/src/a.ts"]}'
run home-path 1 'dist/a.js.map:1: home directory path'

tarball host '{"name":"@wolffm/themes","version":"1.0.0"}' README.md 'Deployed on claw-9 behind the edge.'
run host 1 'README.md:1: fleet host name'

tarball npmrc '{"name":"@wolffm/themes","version":"1.0.0"}' .npmrc '@wolffm:registry=https://npm.pkg.github.com'
run npmrc 1 '.npmrc: npmrc must never ship'

tarball not-wolffm '{"name":"left-pad","version":"1.0.0"}'
run not-wolffm 1 'package name left-pad is not @wolffm/*'

if [ "$fails" -ne 0 ]; then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all publish-npmjs cases passed"
