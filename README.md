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
`docs/planning/wave3-2026-10-21.md` §Contract there). Parses the runner's JSON
report into one row per test — `{spec, test_name, outcome, attempts,
duration_ms}`, `outcome` one of `passed | failed | flaky | skipped` — and POSTs
them to monitoring-api's `/health/api/e2e/results`, chunked at 2,000 rows per
request. **`pytest` is wave 4**: an unrecognised `runner` fails loudly rather
than silently reporting nothing.

**It fails the job on three things, and `if: always()` is load-bearing** for
the same reason it is on `report-job` — a test command that itself failed must
still have its results reported, not swallowed by `if:` defaulting to
`success()`:

- **0 tests ran.** A suite that silently ran nothing is not a quiet night.
- **A test failed.** This duplicates what the test command's own exit code
  already told the job, so the action's own exit status is a complete answer
  on its own — a caller does not have to AND it with the command's result.
- **A test skipped without a declared reason.** Enrolling in nightly e2e means
  every skip is accounted for. Add a one-line reason per test to `e2eSkipAllow`
  in `e2e.json` (read from the workspace root by default; `e2e-json` input
  overrides the path) if a skip is genuinely expected, or fix the test — never
  add an entry just to turn a red run green without reading why it skips.

**A transport failure to the store (an unset key, or the store itself
refusing) WARNS and never fails the job** — same philosophy as `report-job`:
this action's job is to judge the TEST outcome, not to gate your CI on
monitoring-api's own availability.

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

**`report-job`** — the three guards that decide whether a report is honest: an
unset key warns rather than failing the caller, a cancelled outcome stays
silent, and a colon-less `job-name` is refused. The refusal is proven by running
it and asserting the step failed — a guard nothing fires reads as coverage.

*Stated gap:* every case stops before the `curl`. Exercising the POST means
writing rows to the live execution log, and a self-test that fabricates
monitoring data is worse than one with a known gap. The real callers cover it.

**`report-e2e`** — against a stand-in results store
(`.github/selftest/fake-e2e-store.py`, same shape as `fake-broker.py`), driven
by two REAL committed report fixtures (`report-e2e/fixtures/`, generated by
actually running a 2-test Playwright suite and a 2-test vitest suite, one test
passing and one skipped — never hand-written JSON): both fixtures' unallow­ed
skip fails the job (proven by running it and checking the step failed, same
"a guard nothing fires reads as coverage" rule as everywhere else here) while
still reaching the store — asserted by reading back the store's own
`{"inserted": N}` response, not just trusting the curl exited 0. An
`e2eSkipAllow` entry in `e2e.json` turns the same fixture green. Separately: 0
tests ran fails the job, `runner: pytest` is refused loudly (pytest is wave 4),
an unset key warns rather than failing the caller, and a store refusal (403)
also warns rather than failing the caller — a transport problem must never gate
CI on monitoring-api's own availability.

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
