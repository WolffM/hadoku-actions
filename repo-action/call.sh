#!/usr/bin/env bash
# One POST to mgmt-api's /api/repo/<verb>. Retried only when mgmt-api did not
# answer (transport failure, 5xx, or a non-JSON body from the edge), three
# tries 4s apart, the same policy and reasons as vault-fetch/fetch.sh. A 4xx
# is mgmt-api saying no and fails at once with its reason.
#
# Both verbs are safe to repeat: promote to the same sha is a no-op, and a
# repeated redeploy or packages_updated is folded downstream.
set -euo pipefail
case "${REPO_ACTION_VERB:-}" in
  promote|notify) ;;
  *) echo "::error::verb must be promote or notify, got '${REPO_ACTION_VERB:-}'"; exit 1 ;;
esac
if [ -z "${REPO_ACTION_KEY:-}" ]; then
  echo "::error::service-key is empty: this repo's KEY_SERVICE_<REPO> secret is not set."
  exit 1
fi
url="${REPO_ACTION_BROKER}/api/repo/${REPO_ACTION_VERB}"
out="$RUNNER_TEMP/repo-action.$$"
for attempt in 1 2 3; do
  code=$(curl -sS -m 60 -o "$out" -w '%{http_code}' -X POST \
    -A 'hadoku-ci-repo-action' \
    -H "X-User-Key: $REPO_ACTION_KEY" \
    -H 'Content-Type: application/json' \
    --data "$REPO_ACTION_BODY" "$url" || true)
  [ -z "$code" ] && code='000'
  resp=$(cat "$out" 2>/dev/null || echo '')
  if printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then is_json='yes'; else is_json='no'; fi
  case "$code" in
    000|5*) retry='yes' ;;
    *) [ "$is_json" = 'no' ] && retry='yes' || retry='no' ;;
  esac
  if [ "$retry" = 'yes' ] && [ "$attempt" -lt 3 ]; then
    echo "repo-action ${REPO_ACTION_VERB}: HTTP $code — retry $attempt/2 in 4s" >&2
    sleep 4
    continue
  fi
  break
done
rm -f "$out"
# Safe to print: mgmt-api's answers carry repo names, shas and errors, never a credential.
if [ "$code" = '200' ] && [ "$is_json" = 'yes' ] && [ "$(printf '%s' "$resp" | jq -r .success)" = 'true' ]; then
  echo "repo-action ${REPO_ACTION_VERB}: $resp"
  { echo "response<<EOF_REPO_ACTION"; printf '%s\n' "$resp"; echo "EOF_REPO_ACTION"; } >> "$GITHUB_OUTPUT"
  exit 0
fi
if [ "$is_json" = 'yes' ]; then
  echo "::error::repo-action ${REPO_ACTION_VERB} refused (HTTP $code): $(printf '%s' "$resp" | jq -r '.error // .' | head -c 300)"
else
  echo "::error::repo-action ${REPO_ACTION_VERB}: no answer from mgmt-api (HTTP $code; body: $(printf '%s' "$resp" | head -c 200 | tr '\n' ' '))"
fi
exit 1
