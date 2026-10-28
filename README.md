# hadoku-actions

Composite GitHub Actions shared across the hadoku fleet. Public **because it has
to be**: hadoku_site owns these contracts but is private, and a public repo
cannot `uses:` an action from a user-owned private repo.

Nothing here holds a secret. Actions receive credentials as inputs from the
calling repo.

## Actions

| Action | What it does |
| --- | --- |
| [`report-job`](report-job/action.yml) | POSTs a job's outcome to the fleet execution log, so a red run says so itself instead of waiting for the daily digest. |
| [`report-e2e`](report-e2e/action.yml) | Parses a Playwright or vitest JSON report into per-test rows, enforces the skip rule, and POSTs them to the nightly fleet e2e store. |
| [`setup-pnpm`](setup-pnpm/action.yml) | Node + the pinned pnpm via corepack, and refuses to continue without the registry credential. |
| [`setup-python-venv`](setup-python-venv/action.yml) | setup-python on the fleet's toolcache, then a throwaway venv under `RUNNER_TEMP` — so CI stops installing into an interpreter the whole box shares. |
| [`repo-action`](repo-action/action.yml) | Asks mgmt-api, with this repo's own service key, to promote a `bot/*` branch onto the default branch or to notify hadoku_site. What every child repo used `HADOKU_SITE_TOKEN` for. |
| [`update-wolffm`](update-wolffm/action.yml) | Bumps `@wolffm/*` to latest, pushes `bot/update-wolffm` with the job's own token, and promotes it through mgmt-api. Replaces twenty drifted `update-wolffm.yml` bodies and their `HADOKU_SITE_TOKEN`. |
| [`repo-action-cli`](repo-action-cli/action.yml) | Exports `$REPO_ACTION`, the path of `repo-action`'s script, for a step that must promote from inside its own retry loop. Exit 2 means the default branch moved. |
| [`publish-npmjs`](publish-npmjs/action.yml) | Republishes an already-built `@wolffm/*` package to npmjs as `@hadoku/*`, in the same job as its GitHub Packages publish, behind a leak gate. Only the names in `public-packages.json`. |

## Use

```yaml
- name: Mark the start, so the reported duration is real
  run: echo "JOB_STARTED_AT=$(date -u +%s)" >> "$GITHUB_ENV"

# ... the actual work ...

- name: Report the outcome so a silent failure can't hide
  if: always()
  uses: WolffM/hadoku-actions/report-job@v1
  with:
    job-name: myrepo:build          # "worker:job" — the colon is required
    service-key: ${{ secrets.KEY_SERVICE_MYREPO }}
    started-at: ${{ env.JOB_STARTED_AT }}
```

`if: always()` is load-bearing. Without the success side the alert state stays
broken and the next real failure arrives as a suppressed reminder rather than a
new alert.

**Pass `timeout-minutes` if the job sets one.** GitHub reports a
`timeout-minutes` kill as `cancelled`, the same outcome as concurrency
superseding a run, and cancels are not reported — so without it a timed-out job
writes no row and alerts nobody. hadoku-dataplatform's nightly e2e did exactly
that on 2026-10-24 (#2). With it, a cancel that arrives within a minute of the
limit (measured from `started-at`, which it therefore requires) is reported as
`failed`, error `timed out after N min`. An earlier cancel stays silent. Give it
the same value as the job's own limit:

```yaml
jobs:
  e2e:
    timeout-minutes: 60
    steps:
      # ...
      - if: always()
        uses: WolffM/hadoku-actions/report-job@v1
        with:
          job-name: myrepo:e2e
          service-key: ${{ secrets.KEY_SERVICE_MYREPO }}
          started-at: ${{ env.JOB_STARTED_AT }}
          timeout-minutes: 60
```

The service key must exist as a repo secret first — rotation refreshes
credentials, it does not decide which repo gets one. Seed it with
`POST /mgmt/api/keys/seed-github-secret {name}`, or let the daily
`keys:github-secret-seed` cron pick it up once a workflow on the default branch
references it. **An unset secret reads as an empty string, not as an error**;
the action warns and skips rather than failing your build, so check the run log
the first time.

## `report-e2e`

```yaml
- name: Run the suite
  run: pnpm test:e2e --reporter=json --outputFile=e2e-report.json

- name: Report the results so a silent skip can't hide
  if: always()
  uses: WolffM/hadoku-actions/report-e2e@v1
  with:
    report: e2e-report.json
    runner: vitest              # or 'playwright'
    app: myapp
    key: ${{ secrets.KEY_SERVICE_MYAPP }}
    nightly-run-id: ${{ inputs.nightly_run_id }}
```

Part of hadoku_site's programme 3 ("nightly fleet e2e" —
`docs/planning/wave3-2026-10-21.md` §Contract there). Parses the runner's
report into one row per test — `{spec, test_name, outcome, attempts,
duration_ms}`, `outcome` one of `passed | failed | flaky | skipped` — and POSTs
them to monitoring-api's `/health/api/e2e/results`, chunked at 2,000 rows per
request. `runner` is `playwright`, `vitest` or `pytest`; anything else fails
loudly rather than silently reporting nothing.

**`pytest`** reads a `--junitxml` report, not JSON — a plain XML file, parsed
by a small regex-based reader in `parse.mjs` (no dependency: this is a
composite action with no `package.json`/`node_modules` to install into, and
pytest's `--junitxml` output has one fixed, well-known shape, which is what
makes that safe). **Flaky mapping with `pytest-rerunfailures`**: pytest's own
JUnit writer has no dedicated "flaky"/"rerun" tag, and a retried attempt
carries no `<failure>`/`<error>`/`<skipped>` of its own — it lands as an EMPTY
`<testcase>` under the same `classname`+`name` as the test's later attempt(s)
(verified empirically against a real `pytest --reruns 2 --junitxml=...` run,
see the comment above `parsePytest` in `report-e2e/parse.mjs`). So the parser
groups consecutive same-named `<testcase>` elements and reads the outcome off
the last one: group size 1 is a normal result; size >1 ending in a failure is
still `failed` (reruns exhausted); size >1 ending clean is `flaky`, with
`attempts` equal to the group size.

```yaml
- name: Run the suite
  run: python -m pytest --reruns 2 --junitxml=e2e-report.xml

- name: Report the results so a silent skip can't hide
  if: always()
  uses: WolffM/hadoku-actions/report-e2e@v1
  with:
    report: e2e-report.xml
    runner: pytest
    app: myapp
    key: ${{ secrets.KEY_SERVICE_MYAPP }}
    nightly-run-id: ${{ inputs.nightly_run_id }}
```

**It fails the job on four things, and `if: always()` is load-bearing** for
the same reason it is on `report-job` — a test command that itself failed must
still have its results reported, not swallowed by `if:` defaulting to
`success()`:

- **0 tests ran.** A suite that silently ran nothing is not a quiet night.
- **A test failed.** This duplicates what the test command's own exit code
  already told the job, so the action's own exit status is a complete answer
  on its own — a caller does not have to AND it with the command's result.
- **A test skipped without a declared reason.** Enrolling in nightly e2e means
  every skip is accounted for. `e2eSkipAllow` in `e2e.json` (read from the
  workspace root by default; `e2e-json` input overrides the path) is an object
  map of **`{"<test title>": "<one-line reason>"}`** — a title with no entry,
  or an entry whose value is not a non-empty string, fails the skip rule.
  Add an entry if a skip is genuinely expected, or fix the test — never add
  one just to turn a red run green without reading why it skips.

  **This is the one shape `e2eSkipAllow` may take.** It used to be a bare
  array of titles, with no room for a reason; the OLD code read
  `Array.isArray(j.e2eSkipAllow) ? j.e2eSkipAllow : []`, so ANY other shape —
  including this very map — silently became an empty allow-list. hadoku-task's
  real `e2e.json` hit this: 80 entries, each with its own reason, read as zero
  and would have failed every declared skip with no indication why. A missing
  `e2eSkipAllow` (or the file itself) is still fine — that is simply "nothing
  is allowed to skip" — but a PRESENT one of the wrong shape (an array, a
  string, a map with an empty/non-string reason) now fails LOUDLY, naming the
  shape or the offending key, instead of silently degrading.
- **The report never reached the store** — an unset/empty `key`, a non-2xx
  response, or a network error. monitoring-api's digest and the roster read
  `e2e_results` as the record of what happened; an app whose report silently
  failed to land reads as an app that just didn't run that night, not as a red
  one, and that is strictly worse — a job measuring something must fail on
  zero rows. So, unlike `report-job`'s philosophy of never gating CI on
  monitoring-api's own availability, this action deliberately DOES: a missing
  row is itself the failure it exists to catch.

The three steps still run in order — parse, POST (always, even when tests
already failed), then one step failing on the union of test failures, the
skip rule, and any POST failure — so the store gets whatever rows could be
posted before the job goes red.

`gh-run-id` and `repo` default to the calling run's own id and `owner/name`;
override them only for a caller that posts on behalf of another run (none
today). `nightly-run-id` correlates this run with `nightly-e2e.yml`'s dispatch
— leave it unset for a standalone `workflow_dispatch` of your own `e2e.yml`.

## `setup-pnpm`

```yaml
- uses: actions/checkout@v6

- uses: WolffM/hadoku-actions/setup-pnpm@v1
  id: pnpm
  with:
    npm-token: ${{ secrets.HADOKU_NPM_READ_TOKEN }}
    vault-key: ${{ secrets.KEY_SERVICE_<REPO> }}

- name: Install
  env:
    NODE_AUTH_TOKEN: ${{ steps.pnpm.outputs.npm-token }}
  run: pnpm install --frozen-lockfile
```

**With `vault-key`, the token is read from the vault at job time.** A rotation
is then one vault write that every later job sees, instead of a sweep across
~20 repos' GH Secrets that leaves a window where the old value is dead and the
new one has not arrived (2026-10-07: 19:13:25 to 19:14:24, six jobs 401'd).
`npm-token` stays as the fallback for an UNREACHABLE broker only; a 403/404 from
the broker fails, so a missing grant is never hidden behind a stale copy. The
key needs a grant: declare `HADOKU_NPM_READ_TOKEN` in the repo's `.devvault.json`
and run hadoku_site's `node scripts/admin/sync-service-acl.mjs --confirm`.

Without `vault-key` the `npm-token` output is just the input, so moving the
install step onto `steps.pnpm.outputs.npm-token` is safe before the grant exists.

`node-version` (`22`), `pnpm-version` (`11.5.0`), `registry-url` and `scope`
all default to the fleet's values. Keep `pnpm-version` equal to the repo's
`package.json` `packageManager` — corepack is pinned by that field locally, and
a workflow disagreeing with it is drift nothing reports.

**The token goes on the install step, not on this action.** `setup-node` writes
a TOKENLESS npmrc whose `${NODE_AUTH_TOKEN}` pnpm expands at install time. This
action takes `npm-token` only to assert it is non-empty — an unset secret reads
as an empty string, and on a self-hosted runner with a warm pnpm store that is
invisible: the install resolves from cache and CI goes green having
authenticated with nothing. hadoku-hopper did exactly that on 2026-08-24 and
found out at publish, on another machine, as a bare 401.

So **never hand-write an npmrc containing a token.** A repo whose `.npmrc` is
not gitignored then hands its credential to any commit-back workflow it later
gains. Deleting those hand-rolled steps is most of what adopting this action
does.

Pass `assert-token: 'false'` only for a job that installs nothing from the
private registry. Do not add `cache: pnpm` to a caller: it makes `setup-node`
shell out to pnpm to find the store, and corepack has to run *after*
`setup-node`, so the two orderings are mutually exclusive.

## `setup-python-venv`

```yaml
- uses: actions/checkout@v6

- uses: WolffM/hadoku-actions/setup-python-venv@v1
  with:
    assert-imports: ruff mypy pytest my_package

- name: Ruff
  run: python -m ruff check .

- name: Tests
  run: python -m pytest -q
```

`python-version` (`3.11`), `cache` (off) and `install` (`.[dev]`) default to
the fleet's values. `cache` is off because the self-hosted runner's
`~/.cache/pip` already persists, and setup-python's `cache: pip` archives that
whole shared directory: 5.8 GB on 2026-10-01, which cost 20 minutes to *fail*
to restore. The action prepends the venv to `PATH`, so a later bare
`python` is the venv's and every repo can write the same command. Prefer the
`python` output (`${{ steps.<id>.outputs.python }}`) where you want it explicit.

**Why a venv on top of `setup-python`.** `hadoku-builder` is self-hosted, and
its tool cache is not per-run scratch — it is a persistent interpreter every job
on the box shares, provisioned differently per machine. hadoku-scraper ran one
unchanged workflow twice and resolved its dependencies from two different
directories (claw-8's `~/.local`, claw-2's uv python). Installing there is not
hermetic: pip answers *already satisfied* against whatever the box holds, so
`pyproject.toml`'s constraints go unenforced. It drops console scripts, because
an install that is skipped writes no entry point and `~/.local/bin` is not on
`PATH` — that is the `ruff: command not found`, exit 127, that reddened
scraper's `main` on 2026-09-24 with ruff installed the whole time. And it
mutates a machine other repos build on: that run uninstalled `rich` 15.0.0 and
put 13.9.4 in its place, under up to three runner slots sharing one `$HOME`.

**This is not the workaround pygmalion reverted** in `f9a66cc`, and whose
warning still sits in its `tests.yml`. That one *dropped* `setup-python` for the
runner's system `python3` and needed a venv because system `python3` has no pip
— it routed around a node missing the `python-toolcache` capability and so hid
drift the fleet exists to fix. `setup-python` still runs here, first, and a node
without the toolcache still fails loudly. The fleet keeps owning *which* python.
This owns only *where packages land*, which the fleet does not manage.

`assert-imports` is the step that keeps this fixed — a regression to the shared
interpreter looks exactly like a passing build until the day a machine's `$HOME`
drifts. Name third-party packages and your own; the stdlib lives in the base
interpreter and fails by design.

## Why referenced, not vendored

A local `uses: ./.github/actions/...` is a path into the workspace, so every
caller must run `actions/checkout` first. tenhands' `deploy.yml` is a pure
dispatch job that needs no checkout, and it went red on 2026-08-30 the moment it
gained that step — the failure was in the reporter that exists so a silent
failure cannot hide.

Vendoring also made adding a repo a 5.5KB copy-paste, which nobody does 21
times: 21 of the 26 repos in fleet coverage reported nothing at all. One of them
was hadoku-fleet-manager, whose CI sat red for 46 runs across ten hours with the
daily digest as the first and only notice.

Referenced, the runner fetches the action before the job's first step. No
checkout, one copy, and adding a repo is the five lines above.

## `vault-fetch`

```yaml
- uses: WolffM/hadoku-actions/vault-fetch@v1
  with:
    keys: SOME_SECRET, OTHER_SECRET
  env:
    HADOKU_VAULT_KEY: ${{ secrets.KEY_SERVICE_<REPO> }}
    VAULT_FALLBACK_SOME_SECRET: ${{ secrets.SOME_SECRET }}   # optional
```

Exports each key into `GITHUB_ENV`, masked. `VAULT_FALLBACK_<NAME>` is used only
when the broker cannot be reached or says it is not ready (non-JSON, 5xx, 503),
never on a 403/404. The logic is `vault-fetch/fetch.sh`, shared with
`setup-pnpm`, ported from hadoku_site's local copy with its incident history.

## `repo-action`

```yaml
permissions:
  contents: write   # GITHUB_TOKEN pushes bot/update-wolffm; it cannot touch protected main
steps:
  # ... commit the change, then:
  - run: git push --force origin HEAD:refs/heads/bot/update-wolffm
  - uses: WolffM/hadoku-actions/repo-action@v1
    with:
      verb: promote
      body: '{"branch":"bot/update-wolffm"}'
      service-key: ${{ secrets.KEY_SERVICE_<REPO> }}
```

`promote` fast-forwards the default branch to the head of a `bot/*` branch;
GitHub refuses anything that is not a fast-forward. `notify` sends one of
`redeploy_service` (`{service, sha}`, the service must deploy from this repo),
`packages_updated` (`{packages: ["@wolffm/..."], sha}`) or `game_bundle_updated`
to hadoku_site. mgmt-api works out the repo from the key's registry row and
never from the request, so a key can only act on its own repo. Retries only
when mgmt-api did not answer, backing off 4, 8, 15, 30, 30, 30s (about two
minutes) so a call outlasts a mgmt-api redeploy, which is down for 6-11s each
time (measured over 25 on 2026-10-25). The old three tries 4s apart gave up
inside that window. A refusal fails at once with its reason. The same script
runs under `repo-action-cli` and `update-wolffm`.

## publish-npmjs

GitHub Packages asks for a token even for a public package, so nothing that
depends on `@wolffm/*` can be built from outside the fleet. The packages in
[`publish-npmjs/public-packages.json`](publish-npmjs/public-packages.json) are
therefore ALSO published to npmjs as `@hadoku/*`, in the same run as the GitHub
Packages publish. It takes two halves, because npmjs publishes through trusted
publishing (OIDC) and that refuses self-hosted runners:

```yaml
jobs:
  publish:                       # the existing job, on our runner
    steps:
      # ... build, publish to GitHub Packages, notify ...
      - uses: WolffM/hadoku-actions/publish-npmjs@v1
        with:
          package-dir: packages/rooms-protocol

  npmjs:
    needs: publish
    runs-on: ubuntu-latest       # trusted publishing needs a GitHub-hosted runner
    permissions:
      id-token: write
      actions: read
    steps:
      - uses: WolffM/hadoku-actions/publish-npmjs/publish@v1
```

`publish-npmjs` packs, rewrites and gates the package and uploads the tarball as
an `npmjs-<name>` artifact. `publish-npmjs/publish` publishes every tarball the
run staged; it checks nothing out and holds no secret. Each package must name
that repo and workflow file as its trusted publisher, once:
`npm trust github @hadoku/<name> --repo WolffM/<repo> --file <workflow>.yml --allow-publish`.

The fleet keeps installing from GitHub Packages and nothing in it changes. A
consumer outside it keeps importing `@wolffm/*` and aliases the names:
`"@wolffm/themes": "npm:@hadoku/themes@5.12.12"`. Dependencies between public
packages are rewritten to those aliases on the way out, so the alias works
transitively; peer dependencies keep their `@wolffm/*` names, which the
consumer's alias satisfies.

**A publish to npmjs is permanent**: an unpublish is allowed for 72 h only, and
a version can never be reused. So the package is refused, before it leaves our
runner, when it is not on the public list, when it depends on a `@wolffm/*`
package that is not, or when the leak gate finds a token, key, private key,
JWT, webhook, home-directory path, fleet host name or private IP, or an
`.env`/`.npmrc`/key file. `dry-run: 'true'` on either half stops short of the
upload. An already-published version is a no-op, as on GitHub Packages.

## Versioning

**`v1` is a release tag, moved deliberately. It is never a branch alias.**

This is the cost of sharing: a bad push breaks every caller at once, where a
vendored copy broke one. So:

1. Land the change on `main`. The self-test runs.
2. Confirm green, then move the tag:
   ```sh
   git tag -f v1 && git push -f origin v1
   ```

Callers that cannot afford a fleet-wide break should pin a commit SHA instead of
`@v1`.

## Self-test

`.github/workflows/selftest.yml` has a job per action, and a second one for
`setup-python-venv`'s guard.

**`report-job`** — the guards that decide whether a report is honest: an
unset key warns rather than failing the caller, a cancelled outcome stays
silent, a colon-less `job-name` is refused, and so is `timeout-minutes` without
`started-at`. The refusals are proven by running them and asserting the step
failed — a guard nothing fires reads as coverage.

`.github/selftest/report-job-cases.sh` then runs the action's shell, EXTRACTED
from `action.yml` rather than retyped, against a stand-in `curl` that records
the payload. That reaches what the `uses:` cases cannot: a cancel at the
timeout sends `failed` / `timed out after N min`, a cancel well before it sends
nothing, and every case without `timeout-minutes` behaves as it did before the
input existed. Run it locally with `bash .github/selftest/report-job-cases.sh`.

*Stated gap:* nothing calls the real endpoint. Exercising the POST means
writing rows to the live execution log, and a self-test that fabricates
monitoring data is worse than one with a known gap. The real callers cover it.

**`report-e2e`** — against a stand-in results store
(`.github/selftest/fake-e2e-store.py`, same shape as `fake-broker.py`), driven
by REAL committed report fixtures (`report-e2e/fixtures/`, generated by
actually running a 2-test Playwright suite, a 2-test vitest suite, and a
2-test pytest suite under `pytest --reruns 2` — one test passing and one
skipped (or, for pytest, flaky) in each — never hand-written): the
Playwright/vitest fixtures' unallowed skip fails the job (proven by running it
and checking the step failed, same "a guard nothing fires reads as coverage"
rule as everywhere else here) while still reaching the store — asserted by
reading back the store's own `{"inserted": N}` response, not just trusting
the curl exited 0. An `e2eSkipAllow` map entry in `e2e.json` turns the same
fixture green; the OLD array shape, and a map entry with an empty reason, each
fail LOUDLY instead of the array silently reading as an empty allow-list (the
bug hadoku-task's real 80-entry map actually hit). The pytest fixture has no
skip, so it passes end-to-end on its own — and the self-test reads the
action's own parsed-rows file back out of `$RUNNER_TEMP` to assert the
rerun was actually mapped to `outcome: flaky, attempts: 2`, not merely that
nothing errored. Separately: 0 tests ran fails the job for both playwright and
pytest's own real empty-run capture, `runner: cypress` (an unrecognised
runner) is refused loudly, and — unlike every other guard in this repo — an
unset key and a store refusal (403) also fail the job rather than warn:
`report-e2e` deliberately gates CI on monitoring-api's own availability,
because a row that never arrived is itself the failure it exists to catch
(see the README section above). All of these are proven the same way as every
other refusal here, by running them and checking the step failed.

*Stated gap:* the real store is never called, for the same reason `report-job`
states one — a public repo's hosted runner holds no real service key, and a
self-test that wrote fake rows into the live e2e_results table would be worse
than a known gap. The real callers (hadoku-merchant, hadoku-contact-ui,
hadoku-task) cover that path.

**`setup-python-venv`** — two jobs, because the guard has to meet a runner with
no venv already under `RUNNER_TEMP`. The first installs a throwaway package with
an extras target, then asserts the contract a caller depends on: the outputs
point at a real interpreter under `RUNNER_TEMP`, a later bare `python` is the
venv's, and the pinned `ruff` console script is on `PATH` — the exact artifact
whose absence is exit 127. The second fires the isolation assert both ways, a
module living outside the venv and a module missing entirely, and fails if
either was accepted.

**`vault-fetch`** and **`setup-pnpm`'s vault path** — against a stand-in broker
(`.github/selftest/fake-broker.py`): a read, a passthrough without `vault-key`,
an unreachable broker falling back, and a 403 FAILING even with a fallback set.
*Stated gap:* the real broker is never called; a public repo's hosted runner
holds no service key. The first caller to adopt `vault-key` covers it.

**`setup-pnpm`** — that the pins actually landed (`pnpm --version`,
`node --version`, and a custom `pnpm-version`, so an input that silently stops
working is caught), that `setup-node` wrote a *tokenless* npmrc carrying
`${NODE_AUTH_TOKEN}`, that an empty credential is refused — again by firing it —
and that `assert-token: 'false'` still skips the check.

**`publish-npmjs`** — `.github/selftest/publish-npmjs-cases.sh` packs
throwaway tarballs and runs `prepare.mjs` on them: the name and dependency
rewrite on a clean package, then each refusal (a name not on the public list, a
private dependency or peer, an unresolved `workspace:` spec, a planted token
that must not be echoed, a home path in a source map, a fleet host name, a
shipped `.npmrc`, a non-`@wolffm` name). `publish-npmjs-stage` and
`publish-npmjs-publish` then run the real handoff across two runners: a
throwaway package is staged, and the publish half finds its artifact, asks npmjs
whether the version exists and runs `npm publish --dry-run`. Nothing is published.
