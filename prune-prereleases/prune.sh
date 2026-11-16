#!/usr/bin/env bash
# Delete the oldest prereleases whose tag starts with PRUNE_PREFIX, keeping the
# newest PRUNE_KEEP, and each one's tag.
#
# What makes this safe to run unattended:
#   - an empty prefix is refused: it would match every prerelease in the repo;
#   - a release that is not a prerelease is never a candidate;
#   - keep is at least 1, so the newest build, the one being served, stays;
#   - a listing that could not be read fails the step and deletes nothing: a
#     short page must not read as "these are all there are".
set -euo pipefail
prefix=${PRUNE_PREFIX:-}
keep=${PRUNE_KEEP:-10}
[ -n "$prefix" ] || { echo "::error::prefix is empty: it would match every prerelease"; exit 1; }
case "$keep" in ''|*[!0-9]*) echo "::error::keep must be a whole number, got '$keep'"; exit 1 ;; esac
[ "$keep" -ge 1 ] || { echo "::error::keep must be at least 1: the newest prerelease is the one being served"; exit 1; }
[ -n "${PRUNE_TOKEN:-}" ] || { echo "::error::token is empty"; exit 1; }
api="${PRUNE_API:-https://api.github.com}/repos/${PRUNE_REPO:?}"

gh_api() { # method path -> body on stdout; non-2xx fails
  curl -fsS -m 60 -X "$1" -A 'hadoku-ci-prune-prereleases' \
    -H "Authorization: Bearer $PRUNE_TOKEN" -H 'Accept: application/vnd.github+json' "$api/$2"
}

# Every page, until one comes back short. `id created_at tag`, one per line.
all=''
page=1
while :; do
  body=$(gh_api GET "releases?per_page=100&page=$page") && count=$(jq -e 'length' <<<"$body") || {
    echo "::error::prune-prereleases: could not list releases (page $page): nothing deleted"
    exit 1
  }
  all+=$(jq -r --arg p "$prefix" \
    '.[] | select(.prerelease and (.tag_name | startswith($p))) | "\(.id) \(.created_at) \(.tag_name)"' <<<"$body")$'\n'
  [ "$count" -eq 100 ] || break
  page=$((page + 1))
done

# Newest first; everything after the first `keep` goes.
doomed=$(printf '%s' "$all" | sed '/^$/d' | sort -k2,2r | tail -n "+$((keep + 1))")
total=$(printf '%s' "$all" | sed '/^$/d' | wc -l | tr -d ' ')
if [ -z "$doomed" ]; then
  echo "prune-prereleases: $total '$prefix*' prerelease(s), keeping $keep: nothing to delete"
  echo "deleted=0" >> "$GITHUB_OUTPUT"
  exit 0
fi

n=0
while read -r id created tag; do
  if [ "${PRUNE_DRY_RUN:-false}" = 'true' ]; then
    echo "prune-prereleases: would delete $tag ($created)"
  else
    gh_api DELETE "releases/$id" > /dev/null
    # The tag outlives its release unless deleted too. 422 is GitHub's answer
    # for a ref that does not exist: already gone is fine, anything else is not.
    code=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X DELETE -A 'hadoku-ci-prune-prereleases' \
      -H "Authorization: Bearer $PRUNE_TOKEN" -H 'Accept: application/vnd.github+json' \
      "$api/git/refs/tags/$tag" || true)
    case "$code" in
      204|422|404) ;;
      *) echo "::error::prune-prereleases: deleted release $tag but not its tag (HTTP ${code:-000})"; exit 1 ;;
    esac
    echo "prune-prereleases: deleted $tag ($created)"
  fi
  n=$((n + 1))
done <<<"$doomed"
echo "prune-prereleases: $total '$prefix*' prerelease(s), kept the newest $keep"
echo "deleted=$n" >> "$GITHUB_OUTPUT"
