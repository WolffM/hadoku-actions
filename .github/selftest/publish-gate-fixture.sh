#!/bin/sh
# Builds publish-gate's composite fixture under $1: a stand-in registry whose
# newest @wolffm/selftest-gate is 1.0.1, a workspace equal to it at 1.0.2, and
# one whose code changed. fake-gate-npm.mjs serves it ($FAKE_REGISTRY=$1).
set -eu
root=$1
mkdir -p "$root/prev/dist" "$root/equal/dist" "$root/changed/dist"
pkg() { printf '{\n  "name": "@wolffm/selftest-gate",\n  "version": "%s",\n  "gitHead": "%s"\n}\n' "$1" "$2"; }
pkg 1.0.1 38ddd15916cce904c43620666cdaf2180573f36c > "$root/prev/package.json"
pkg 1.0.2 "$GITHUB_SHA" > "$root/equal/package.json"
pkg 1.0.2 "$GITHUB_SHA" > "$root/changed/package.json"
echo 'export const v = "1.0.1";' > "$root/prev/dist/index.js"
echo 'export const v = "1.0.2";' > "$root/equal/dist/index.js"
echo 'export const v = "1.0.2"; export const more = 1;' > "$root/changed/dist/index.js"
echo '{"@wolffm/selftest-gate":{"versions":["1.0.0","1.0.1"],"tarballs":{"1.0.1":"prev"}}}' > "$root/registry.json"
