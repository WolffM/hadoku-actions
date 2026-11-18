# Features

Every action below is referenced with `uses: WolffM/hadoku-actions/<path>@v1`
from any workflow in any repo — public or private, on this account or anyone
else's. None of them hold a secret; a caller always passes its own credential
in as an input or an env var.

## report-job

[`report-job/action.yml`](../../report-job/action.yml) POSTs one job's outcome
(`succeeded` / `failed`) to the fleet's execution log, so a red run is visible
the moment it happens instead of waiting on a digest. It needs a `job-name`
shaped `worker:job` (the colon is required — it is how the log groups rows by
worker), a `service-key`, and, to measure a duration, a `started-at` epoch
timestamp stamped by the caller's own first step.

It never fails the job it is reporting on: a missing `service-key` only
warns, and the POST itself is bounded (`--max-time 30`) so a hung store
cannot hold a caller's job hostage. It did exactly that for 38 minutes
before the bound was added (`065ad77`, issue #4). A `cancelled` outcome is
treated as normal (concurrency superseding a run) and is not reported,
unless `timeout-minutes` is also passed. In that case a cancel landing at
or after that limit is reported as `failed`, because GitHub reports a
`timeout-minutes` kill as `cancelled` too, and that *is* a real failure
(issue #2). `if: always()` at the
call site is required: without it, a recovery after a red run is never
reported and the alert state stays stuck broken.

**Limits**: `report-job` is one row per CI job, not per test — see `report-e2e`
for that. It only ever warns on a reporting failure; it deliberately never
fails a caller's build over the execution log being unavailable.

## report-e2e

[`report-e2e/action.yml`](../../report-e2e/action.yml) turns a Playwright,
vitest or pytest report into one row per test — `{spec, test_name, outcome,
attempts, duration_ms}`, `outcome` one of `passed | failed | flaky | skipped`
— and POSTs the rows, chunked at 2,000 per request, to the nightly e2e store.
`runner` must be `playwright`, `vitest` or `pytest`; anything else fails
loudly. Playwright and vitest read a JSON reporter file; pytest reads a plain
`--junitxml` file through a small hand-written regex parser
([`report-e2e/parse.mjs`](../../report-e2e/parse.mjs)), because this is a
composite action with no `package.json` to install an XML library into.

A retried pytest test (`pytest-rerunfailures`) has no dedicated "rerun" tag in
JUnit XML — a retried attempt lands as an *empty* `<testcase>` under the same
name as the one that follows it. `parse.mjs` groups consecutive same-named
`<testcase>` elements and reads the outcome off the last one: group size 1 is
a normal result, a group ending in failure is still `failed`, and a group
ending clean after more than one entry is `flaky`. That mapping was checked
empirically against a real `pytest --reruns 2 --junitxml=...` run, not read
out of pytest-rerunfailures' own docs — the fixture it produced is committed
at [`report-e2e/fixtures/pytest-report.xml`](../../report-e2e/fixtures/pytest-report.xml).

The skip rule: a workspace's `e2e.json` may declare `e2eSkipAllow`, a map of
`{"<test title>": "<one-line reason>"}`. Any test that skipped without an
entry there fails the job. The map is the *only* shape accepted. An older
convention used a bare array of titles, and a map read against that old
code silently became an empty allow-list. That would have failed every one
of a real 80-entry allow-list with no indication why (`9771b81`). Today a
present `e2eSkipAllow` of any other shape fails loudly instead, naming the
bad key.

**Fails the job on four things**, not just a failing test: zero tests ran,
an unallowed skip, a failed test, or the report failing to reach the store
at all (an unset key, a non-2xx response, or a network error). Unlike
`report-job`, this action deliberately *does* gate CI on the store's own
availability, because a report that silently never arrived reads as a
quiet night rather than a red one.

**Limits**: `post: 'false'` runs every check but sends nothing, for a
per-push/PR gate that is not the nightly run of record (and may have no key at
all, e.g. a fork PR). `nightly-run-id` only makes sense for a run dispatched by
the fleet's own nightly workflow.

## setup-pnpm and vault-fetch

[`setup-pnpm/action.yml`](../../setup-pnpm/action.yml) installs Node,
activates the pinned pnpm through corepack (never `pnpm/action-setup`, whose
self-installer races concurrent jobs on one host), and refuses to continue
unless a registry credential is present. An unset secret reads as an empty
string, not an error, and a job with a warm pnpm store can install
everything from cache and go green having authenticated with nothing. Pass
`vault-key` and the registry token is read from the vault broker at job
time instead of a GitHub Secret, so a credential rotation is one write
every later job sees rather than a sweep across every repo's secrets one at
a time. A 403/404 from the broker still fails outright, so a missing grant
is never silently masked by a stale fallback value.

It also pins the pnpm store for the rest of the job
(`pnpm_config_store_dir`), because pnpm 11 re-checks dependencies before
every `pnpm run`. Left on the default store, a later build step re-links
everything under *its own* env, which — unlike the install step — never got
the real registry token and so carries only `setup-node`'s placeholder.
Anything missing from the default store then 401s, which in practice was
always the package just published (issue #5).

[`vault-fetch/action.yml`](../../vault-fetch/action.yml) is the same vault-read
logic ([`vault-fetch/fetch.sh`](../../vault-fetch/fetch.sh), shared with
`setup-pnpm`'s own vault path) exposed as a standalone action for any secret,
not only the registry token: `keys: SOME_SECRET, OTHER_SECRET` exports each
one into `GITHUB_ENV`, masked. A `VAULT_FALLBACK_<NAME>` env var is used only
when the broker could not be reached or declared itself not ready — never on a
403/404, which means "no" and must stay loud.

**Limits**: `setup-pnpm` does not install dependencies; a caller still runs
`pnpm install` itself, with the token from this action's output on that one
step's env, never exported ambiently. Do not add `cache: pnpm` to a caller —
it makes `actions/setup-node` shell out to pnpm before corepack has activated
it, which this action's own ordering is built to avoid.

## setup-python-venv

[`setup-python-venv/action.yml`](../../setup-python-venv/action.yml) runs
`actions/setup-python` first (so a machine missing the Python toolcache
still fails loudly, which is by design), then builds a throwaway venv under
`RUNNER_TEMP`, installs the project into it (`pip install -e`, target
configurable via `install`). It then asserts that every name passed in
`assert-imports` actually resolved from inside the venv or the checkout —
not from a shared, persistent interpreter that other jobs on the same
self-hosted machine also write into. `cache` is off by default: the runner's own pip cache
already persists, and `setup-python`'s own cache option archives and restores
that *entire* shared directory rather than just this project's wheels.

**Limits**: `assert-imports` only accepts third-party package names; the
standard library resolves from the base interpreter by design, so naming a
stdlib module there always fails. `install: ''` creates the venv and installs
nothing, for a job that pins its own tool versions another way.

## repo-action and repo-action-cli

[`repo-action/action.yml`](../../repo-action/action.yml) sends one request to
the account's management API, authenticated with the calling repo's own
service key (which the API resolves back to exactly that repo — a key can
never act on another repo). `verb: promote` fast-forwards this repo's default
branch onto the head of a `bot/*` branch the caller already pushed; GitHub
itself refuses anything that is not a fast-forward. `verb: notify` sends a
`redeploy_service`, `packages_updated` or `game_bundle_updated` event. A refusal (4xx) fails immediately with its reason. A transport failure or
5xx is retried with a backoff (4, 8, 15, 30, 30, 30 seconds, about two
minutes total), long enough to outlast an API redeploy — measured at 6-11
seconds over 25 redeploys on 2026-10-25 (`9b3a70c`). The old
three-tries-4s-apart retry gave up inside that window and lost at least two
publishes that way.

[`repo-action-cli/action.yml`](../../repo-action-cli/action.yml) exposes the
same script ([`repo-action/call.sh`](../../repo-action/call.sh)) as
`$REPO_ACTION`, for a step that must retry its own promote from inside a loop
(for example, re-reading state and rebasing after the default branch moved)
rather than calling it once through `uses:`. Exit code 2 from that script
means specifically "the default branch moved since the branch was cut" —
every other failure is exit 1.

**Limits**: `notify`'s `redeploy_service` only works when the named service
actually deploys from this repo; there is no verification here that it does.

## update-wolffm

[`update-wolffm/action.yml`](../../update-wolffm/action.yml) resolves
the version each `@wolffm/*` dependency should move to once, from GitHub
Packages' latest, and runs `pnpm update -r` with those pinned versions (via
`setup-pnpm`). It then restores any in-repo
workspace package the update rewrote away from `workspace:*`, and asserts
every `@wolffm/*` dependency across the workspace is now at the registry's
latest (majors included — "pin back" is not an option it offers). It then
commits the result to a `bot/*` branch with the job's own `GITHUB_TOKEN`,
and promotes that branch through `repo-action`. A caller can inject its own `post-update` and `verify`
shell before anything is pushed, for a repo that needs to do more than bump a
version number.

It also waits, within a time budget, for npmjs to catch up before
installing. A consumer on the `@hadoku/*` npmjs aliases that updates while
GitHub Packages is ahead of npmjs's own mirror by a couple of minutes would
otherwise 404 on a tarball, or resolve a dependency before its own
dependency (issue #6). npmjs also lists a version 4-5 minutes before its
tarball serves, so the wait is on the tarball itself, and on every
`@hadoku/*` version a target pins exactly (issue #7). Because the targets are
pinned, a retry never chases a release published mid-run. A release
published *while* this job is running is
forgiven rather than flagged as drift, as long as nothing older was missed
(issue #1). A re-run of a promote that already landed is recognised and
ends cleanly rather than conflicting with its own prior commit (issue #3).

**Limits**: the wait and the install's retries share `wait-budget-s` (390 s
by default), and the rest of a run takes about two minutes plus `verify`, so
the caller's `timeout-minutes` must be at least 10. The caller must check out
with the default `GITHUB_TOKEN` (no `token:` override) and grant `contents:
write` — that token can push the bot
branch but, deliberately, not the protected default branch directly.

## publish-npmjs

[`publish-npmjs/action.yml`](../../publish-npmjs/action.yml) packs an
already-built `@wolffm/*` workspace package, rewrites its name and its
`@wolffm/*` dependencies to `@hadoku/*` (peer dependencies are left alone —
the consumer's own alias satisfies them), runs a leak gate over every file,
and uploads the result as a build artifact. It refuses to do any of this unless the package's short name is listed in
[`publish-npmjs/public-packages.json`](../../publish-npmjs/public-packages.json),
and every one of its own `@wolffm/*` dependencies is listed too. Otherwise
the mirrored package would 401 for anyone outside the fleet the moment it
tried to resolve a private dependency. The leak gate
([`publish-npmjs/prepare.mjs`](../../publish-npmjs/prepare.mjs)) refuses a
`.env`/`.npmrc`/key file, or any file containing something that looks like a
token, a private key, a JWT, a webhook URL, a home-directory path, or a
private IPv4 address.

[`publish-npmjs/publish/action.yml`](../../publish-npmjs/publish/action.yml)
is the second half: a separate job, on a GitHub-hosted runner (never
self-hosted — npm's trusted publishing over OIDC refuses those), that
downloads whatever this run staged and runs `npm publish` with no token at
all. Because that hosted job cannot report its own outcome (every request from
a GitHub-hosted runner's IP range is challenged before it reaches the account's
infrastructure), a third, self-hosted job reports on its behalf using
`report-job`.

**Limits**: a publish to npmjs is permanent — an unpublish is only honored for
72 hours and a version number can never be reused — so `dry-run: 'true'` on
either half is the only way to preview the result before it ships. Each
`@hadoku/*` package must separately register this repo and the calling
workflow file as its trusted publisher on npmjs before its first real
publish.

## next-version

[`next-version/action.yml`](../../next-version/action.yml) reads every
published version of the workspace's package at once and writes one patch
above the newest into `package.json`, in the CI workspace only — nothing is
committed back to the repo. A version already committed above the registry's newest is left as it
stands, so a deliberate minor or major bump in a commit still works. A 404
(never published) falls back to the committed version unmodified, but any
other registry failure fails the step rather than guess. It also writes a
`gitHead` field recording the publishing commit, because `pnpm publish`
(unlike `npm publish`) does not record one itself. Without it, a re-run
after a later step failed could not tell it had already published, and
would ship the same build again as a fresh patch. The `published: 'true'`
output tells the caller to skip the publish and resume from there.

**Limits**: needs `actions/setup-node` already configured with the package's
`registry-url` and `scope`, and a `NODE_AUTH_TOKEN` with at least read access,
before it runs.

## wait-for-live and prune-prereleases

[`wait-for-live/action.yml`](../../wait-for-live/action.yml) polls a `url`
until a `jq` filter (default `.version`) of its JSON answer equals `expect`,
as strings. That is for a repo that publishes a build per `main` commit to
a pre-production environment and needs to know the new build is actually
being served before the next step smoke-tests it. A notify or dispatch
succeeding only means the request was accepted; the real publish or
restart happens afterwards in another repo's workflow, so a smoke test
started immediately would run against the previous build and pass. Every
outcome but a match — the old value, a 401/404, a 5xx, a non-JSON edge
page — keeps it polling until `timeout-seconds` (default 600). Giving up
names what it last saw, so a deploy that never started reads differently
from a wrong key or a wrong field. `service-key` is sent as `X-User-Key` for a route behind the
edge's tier gate; it refuses an empty `expect` outright, because an unset
step output reads as `''`.

[`prune-prereleases/action.yml`](../../prune-prereleases/action.yml) deletes
a repo's oldest prereleases whose tag starts with `prefix` (default `ppe-`),
and their tags, keeping the newest `keep` (default 10, at least 1, so the
build currently being served is never a candidate). A full release is never
touched, whatever its tag. It reads every page of the listing and deletes
nothing if any page fails to read, rather than treat a short page as "these
are all there are." `dry-run: 'true'` lists what would go without deleting
anything.

**Limits**: `wait-for-live` only knows the deploy happened once the URL it is
told to poll actually changes; it cannot tell a deploy that never started
from one that is simply slow, short of its own timeout. `prune-prereleases`
needs `contents: write` on its caller's token and only ever considers
PRERELEASES — a renamed or promoted full release is safe from it by design.

## Trivia

`next-version` and two other actions, `promote` and `sync-main-to-ppe`, were
all added in one commit on 2026-11-01 that added 2,090 lines across 19
files (`37e983e`) — and the other two left again, the same day, for a
different repo (`bc516f5`). `next-version` is the one piece of that commit
that was never meant to move.
