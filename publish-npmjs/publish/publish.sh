#!/usr/bin/env bash
# Publishes every tarball in $DIR to npmjs. Its own file so the self-test runs
# these exact lines against a stand-in npm (.github/selftest/publish-npmjs-publish-cases.sh).
#
#   DIR       where the staged *.tgz are
#   DRY_RUN   'true' runs `npm publish --dry-run`
set -euo pipefail

REGISTRY=https://registry.npmjs.org/
# One publish is tried this many times, and only a transparency-log failure
# earns another try.
ATTEMPTS=3

cd "$DIR"
log=$(mktemp)
trap 'rm -f "$log"' EXIT
failed=0
dry=(); [ "$DRY_RUN" = 'true' ] && dry=(--dry-run)

# npm prints "npm error code <CODE>" for every failure it can name. Read from
# its output because the exit status is 1 for all of them.
npm_code() { sed -n 's/^npm \(error\|ERR!\) code //p' "$log" | head -1; }

for tgz in *.tgz; do
  name=$(tar -xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).name')
  version=$(tar -xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version')
  # Checked BEFORE publishing rather than parsed from a failed publish:
  # npm's "cannot publish over" wording has changed between releases.
  set +e
  out=$(npm view "$name@$version" version --registry "$REGISTRY" 2>&1); code=$?
  set -e
  if [ $code -eq 0 ] && [ "$out" = "$version" ]; then
    echo "✓ $name@$version is already on npmjs — no-op (bump the version to release)"
    continue
  elif ! echo "$out" | grep -q E404; then
    echo "$out"
    echo "::error::could not ask npmjs whether $name@$version exists (exit $code)"
    failed=1
    continue
  fi

  # npm refuses a prerelease without a tag; `next` keeps it off `latest`.
  tag=(); [[ "$version" == *-* ]] && tag=(--tag next)
  attempt=1
  while :; do
    set +e
    npm publish "$tgz" --access public --registry "$REGISTRY" "${tag[@]}" "${dry[@]}" 2>&1 | tee "$log"
    code=${PIPESTATUS[0]}
    set -e
    [ "$code" -eq 0 ] && break
    # npm signs the provenance and writes it to Sigstore's transparency log
    # BEFORE it uploads, so this failure leaves nothing on npmjs. Its usual
    # shape is a 409 "an equivalent entry already exists": the log took the
    # entry, the answer was lost, and npm's own retry met the entry it had just
    # made (hadoku-cardtable run 44447837922, twice in one job). A new
    # `npm publish` signs with a new certificate, so its entry is a new one.
    [ "$(npm_code)" = TLOG_CREATE_ENTRY_ERROR ] && [ "$attempt" -lt "$ATTEMPTS" ] || break
    echo "::warning::$name@$version: the transparency log refused the provenance entry (TLOG_CREATE_ENTRY_ERROR), attempt $attempt of $ATTEMPTS — publishing again"
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done

  if [ "$code" -eq 0 ]; then
    if [ ${#dry[@]} -eq 0 ]; then echo "📦 Published $name@$version to npmjs"
    else echo "dry run: would publish $name@$version to npmjs"; fi
    continue
  fi
  failed=1
  npm_error=$(npm_code)
  case "$npm_error" in
    # With the version absent, these two mean the package has no trusted
    # publisher for THIS repo and workflow file.
    E404|ENEEDAUTH)
      echo "::error::npm refused $name@$version ($npm_error) — check its trusted publisher (npm trust list $name)" ;;
    TLOG_CREATE_ENTRY_ERROR)
      echo "::error::npm could not publish $name@$version: TLOG_CREATE_ENTRY_ERROR on all $ATTEMPTS attempts. That is Sigstore's transparency log, not the package's trusted publisher, and nothing was uploaded — re-run this job" ;;
    '')
      echo "::error::npm publish of $name@$version failed (exit $code) and named no error code — its output is above" ;;
    *)
      echo "::error::npm publish of $name@$version failed: $npm_error — npm's own message is above" ;;
  esac
done
exit $failed
