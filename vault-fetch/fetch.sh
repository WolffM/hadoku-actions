#!/usr/bin/env bash
# Fetch ONE secret from the hadoku vault broker into a file. The shared core of
# `vault-fetch` and `setup-pnpm`'s vault path — one copy, so the fallback policy
# below cannot drift between them. Ported verbatim from hadoku_site's
# .github/actions/vault-fetch (the incident history in its comments is kept).
#
#   fetch.sh NAME OUTFILE
#   env: HADOKU_VAULT_KEY  the caller's service key (required)
#        VAULT_BROKER      broker base URL (default https://hadoku.me/mgmt)
#        VAULT_FALLBACK    value to use ONLY if the broker cannot be reached or
#                          declares itself not ready (non-JSON, 5xx/503) — never
#                          on a 403/404, which must stay loud
#
# Writes the value to OUTFILE (mode 600) and emits ::add-mask:: on STDOUT. It
# deliberately does not print the value: a caller capturing stdout with $(...)
# would swallow the mask command with it, and the runner only honours workflow
# commands that reach stdout.
set -euo pipefail
name="${1:?usage: fetch.sh NAME OUTFILE}"
outfile="${2:?usage: fetch.sh NAME OUTFILE}"
BROKER="${VAULT_BROKER:-https://hadoku.me/mgmt}"
KEY="${HADOKU_VAULT_KEY:-}"
if [ -z "$KEY" ]; then
  echo "ERROR: HADOKU_VAULT_KEY is not set; cannot fetch $name from the vault." >&2
  exit 1
fi

# GET the value. 200 = ok; 403 = ACL denied (operator must
# grant); 404 = key not in vault; 503 = vault sealed.
# Real UA: hadoku.me's WAF 403/challenges bare curl user-agents,
# and an HTML block page here reads as a vault outage.
#
# Retried, because the broker is mgmt-api under PM2 and a redeploy
# restarts it. The edge answers 502 for those few seconds, and on
# 2026-08-08 that took out four jobs at once — tests, typecheck, lint
# and auto-format all fetch here, all on the same commit, all with a
# message pointing at ACL grants and a sealed vault. None of those was
# the cause; the restart was.
#
# A retry, not a re-architecture: three tries, 4s apart. That covers a
# restart (~2-5s) and nothing else. The failure modes worth SEEING —
# 403 ACL denied, 404 missing key, 503 sealed — are answered by a
# running broker, so they still fail on the first attempt's message
# and are not slowed by the backoff. Only a transport-level failure,
# a 5xx, or a NON-JSON body is retried.
#
# The non-JSON case is the edge answering instead of the broker. On
# 2026-08-17 Cloudflare served the claw runners an HTML page for six
# hours; every fetch here piped `<!DOCTYPE html>` into jq, and under
# `set -e -o pipefail` jq's parse error killed this step at the
# assignment BELOW — so the diagnostic this action exists to print
# never ran, and four workflows (lint, test, typecheck, auto-format —
# four of the six required checks) failed with nothing but
#   jq: parse error: Invalid numeric literal at line 1, column 10
# The body is therefore shape-checked BEFORE it reaches jq, and the
# code/content-type/snippet are reported. An HTML block page is also
# usually transient (a challenge or a rate-limit on a burst of
# concurrent jobs), so it is retried rather than failed outright.
resp=''
code=''
ctype=''
is_json='no'
for attempt in 1 2 3; do
  # Two -w fields in one string: `read` from a process substitution
  # would put the assignment in a subshell under `set -e`.
  # `|| true`, NOT `|| echo '000 -'`: curl still writes its -w string
  # on a failed transfer (as `000 ` with an empty content_type), so an
  # echo on the failure branch APPENDS a second copy and every
  # transport failure reported `content-type: 000 -`.
  meta=$(curl -sS -m 30 -o /tmp/vault-resp.$$ -w '%{http_code} %{content_type}' \
    -A 'hadoku-ci-vault-fetch' \
    -H "X-User-Key: $KEY" \
    "$BROKER/api/secrets/get/$name" || true)
  [ -z "$meta" ] && meta='000 '
  code=${meta%% *}
  case "$meta" in *' '*) ctype=${meta#* } ;; *) ctype='' ;; esac
  [ -z "$ctype" ] && ctype='(none)'
  resp=$(cat /tmp/vault-resp.$$ 2>/dev/null || echo '')
  rm -f /tmp/vault-resp.$$
  # Shape check first — never let a non-JSON body reach jq below.
  if command -v jq >/dev/null 2>&1; then
    if printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then is_json='yes'; else is_json='no'; fi
  else
    case "$(printf '%s' "$resp" | tr -d '[:space:]' | cut -c1)" in
      '{') is_json='yes' ;;
      *) is_json='no' ;;
    esac
  fi
  # 000 = curl could not complete; 5xx = broker is up but unwell;
  # non-JSON = something other than the broker answered.
  retryable='no'
  case "$code" in
    000|5*) retryable='yes' ;;
    *) [ "$is_json" = 'no' ] && retryable='yes' ;;
  esac
  if [ "$retryable" = 'yes' ] && [ "$attempt" -lt 3 ]; then
    echo "vault fetch for $name: HTTP $code ($ctype) — retry $attempt/2 in 4s" >&2
    sleep 4
    continue
  fi
  break
done
value=''
# The two shapes a fallback may rescue, and nothing else. Neither says
# anything about whether THIS caller is authorized — see the header.
#   non-JSON : nothing speaking the broker's protocol answered (the
#              edge, Cloudflare's WAF, or the request never arrived)
#   503      : the broker answered and declared itself not ready
rescuable='no'
[ "$is_json" != 'yes' ] && rescuable='yes'
[ "$code" = '503' ] && rescuable='yes'
if [ "$rescuable" = 'yes' ]; then
  fb_var="VAULT_FALLBACK"
  fb="${VAULT_FALLBACK:-}"
  if [ "$is_json" = 'yes' ]; then
    echo "vault broker is not ready for $name (HTTP $code)." >&2
    # Safe to echo: a 503 body is the guard's own error string, never
    # a secret-bearing response.
    echo "  response: $(printf '%s' "$resp" | head -c 200 | tr '\n' ' ')" >&2
    echo "  Likely cause: mgmt-api booted while the vault was" >&2
    echo "  unreachable, so MGMT_EDGE_TOKEN is missing from its env." >&2
    echo "  bw.ts retries this in the background; it should clear on" >&2
    echo "  its own within ~30s of vaultwarden answering again." >&2
  else
    echo "vault broker did not return JSON for $name." >&2
    echo "  HTTP $code, content-type: $ctype" >&2
    # Safe to echo: a non-JSON body is not a secret-bearing response.
    echo "  body (first 200 bytes): $(printf '%s' "$resp" | head -c 200 | tr '\n' ' ')" >&2
    echo "  Likely causes:" >&2
    echo "    - Cloudflare served a challenge/block page to this runner" >&2
    echo "      (an HTML body here is the edge answering, not the broker)" >&2
    echo "    - $BROKER is not routing to mgmt-api" >&2
  fi
  if [ -z "$fb" ]; then
    echo "  No $fb_var is set on this step, so there is nothing to" >&2
    echo "  fall back to. Add it to the calling step's env if this" >&2
    echo "  workflow must survive an unreachable broker." >&2
    exit 1
  fi
  # An annotation, not just a log line: a run that quietly succeeded
  # on the fallback must still be visibly degraded in the UI, or the
  # broker stays broken because nothing ever looks red.
  echo "::warning title=Vault unreachable — used GH Secret fallback::${name} came from ${fb_var}, not the vault (HTTP ${code}, ${ctype}). The value is only as fresh as the last rotation push to GH Secrets. Fix the broker path; do not leave CI running on this."
  value="$fb"
else
  # Use jq if available, else fall back to a simple grep.
  if command -v jq >/dev/null 2>&1; then
    value=$(printf '%s' "$resp" | jq -r '.value // empty')
  else
    value=$(printf '%s' "$resp" | sed -n 's/.*"value":"\([^"]*\)".*/\1/p')
  fi
  if [ -z "$value" ]; then
    # The broker ANSWERED and declined. Never fall back here: a
    # missing grant or a retired key must stay loud.
    echo "ERROR: vault returned no value for $name." >&2
    echo "  HTTP $code — response: $resp" >&2
    echo "  Likely causes:" >&2
    echo "    - HADOKU_VAULT_KEY missing ACL grant for $name (declare it in the repo's .devvault.json; operator: node scripts/admin/sync-service-acl.mjs in hadoku_site)" >&2
    echo "    - $name not in vault" >&2
    # NOT "vault sealed" any more: a sealed broker answers 503, which
    # is now rescued above and never reaches this branch. Leaving it
    # here sent a 2026-09-20 investigation looking for an ACL problem.
    echo "    - the key was retired, or its grant was pruned" >&2
    exit 1
  fi
fi

echo "::add-mask::$value"
umask 077
printf '%s' "$value" > "$outfile"
