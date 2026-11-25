# hadoku-actions

**Guide:** [overview](docs/guide/index.md) · [features](docs/guide/features.md) · [contributing](docs/guide/contributing.md) · [history](docs/guide/history.md) · [trivia](docs/guide/trivia.md)

Composite GitHub Actions shared across the hadoku fleet. Public **because it has
to be**: hadoku_site owns these contracts but is private, and a public repo
cannot `uses:` an action from a user-owned private repo.

Nothing here holds a secret. Actions receive credentials as inputs from the
calling repo. What each one does, its limits, and the incident that shaped
it is in [features.md](docs/guide/features.md); this page is the usage
reference.

## Actions

| Action | What it does |
| --- | --- |
| [`report-job`](report-job/action.yml) | POSTs a job's outcome to the fleet execution log, so a red run says so itself instead of waiting for the daily digest. |
| [`report-e2e`](report-e2e/action.yml) | Parses a Playwright, vitest or pytest report into per-test rows with each failure's error, location and steps, enforces the skip rule, prints and annotates every failure, uploads its traces, and records the run (environment, class, commits since the last green run) in the fleet e2e store. |
| [`report-tests`](report-tests/action.yml) | Reads every test report a job wrote (Playwright, vitest, jest, pytest, node:test, any JUnit XML) into one per-test document, prints counts, slowest tests and failures, and posts it to the fleet test store. Advisory: never fails the job. |
| [`setup-pnpm`](setup-pnpm/action.yml) | Node + the pinned pnpm via corepack, and refuses to continue without the registry credential. |
| [`setup-python-venv`](setup-python-venv/action.yml) | setup-python on the fleet's toolcache, then a throwaway venv under `RUNNER_TEMP` — so CI stops installing into an interpreter the whole box shares. |
| [`setup-nextest`](setup-nextest/action.yml) | A pinned, sha256-checked prebuilt cargo-nextest on `PATH`, so a Rust test step writes JUnit for `report-tests`. |
| [`repo-action`](repo-action/action.yml) | Asks mgmt-api, with this repo's own service key, to promote a `bot/*` branch onto the default branch or to notify hadoku_site. What every child repo used `HADOKU_SITE_TOKEN` for. |
| [`update-wolffm`](update-wolffm/action.yml) | Bumps `@wolffm/*` to latest, pushes `bot/update-wolffm` with the job's own token, and promotes it through mgmt-api. Replaces twenty drifted `update-wolffm.yml` bodies and their `HADOKU_SITE_TOKEN`. |
| [`repo-action-cli`](repo-action-cli/action.yml) | Exports `$REPO_ACTION`, the path of `repo-action`'s script, for a step that must promote from inside its own retry loop. Exit 2 means the default branch moved. |
| [`publish-npmjs`](publish-npmjs/action.yml) | Republishes an already-built `@wolffm/*` package to npmjs as `@hadoku/*`, in the same job as its GitHub Packages publish, behind a leak gate. Only the names in `public-packages.json`. |
| [`next-version`](next-version/action.yml) | Sets `package.json`'s version, in the CI workspace only, to one patch above the newest on the registry. Nothing is committed back. |
| [`wait-for-live`](wait-for-live/action.yml) | Polls a URL until a field of its JSON answer equals the value this run published, so a deploy job goes green only once the deploy is being served. |
| [`prune-prereleases`](prune-prereleases/action.yml) | Deletes this repo's oldest prereleases under a tag prefix, and their tags, keeping the newest N. |

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

Pass `timeout-minutes` with the same value as the job's own limit, so a
cancel at the timeout is reported as a failure rather than silence:

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

A job that does several named units of work in one go posts a row for each,
with its own duration, through `extra-jobs`:

```yaml
- if: always()
  uses: WolffM/hadoku-actions/report-job@v1
  with:
    job-name: myrepo:deploy
    service-key: ${{ secrets.KEY_SERVICE_MYREPO }}
    started-at: ${{ env.JOB_STARTED_AT }}
    # [{"name": "myrepo:deploy-a", "outcome": "success", "duration-ms": 12000},
    #  {"name": "myrepo:deploy-b", "outcome": "failure", "error": "migrations refused"}]
    extra-jobs: ${{ steps.deploy.outputs.report }}
```

Each entry carries the duration the caller MEASURED, never a start time: the
entries are all posted after the last unit finished, so a start time would
measure until the end of the job. A start time on an entry is refused. An
entry with no `outcome` is a unit the job never reached and is not reported.
A malformed one fails the step.

## `report-tests`

```yaml
- name: Test
  run: |
    pnpm vitest run --reporter=default --reporter=json --outputFile.json=vitest.json
    node --test --test-reporter=spec --test-reporter-destination=stdout \
      --test-reporter=junit --test-reporter-destination=node-test.xml

- name: Report the tests
  if: always()
  uses: WolffM/hadoku-actions/report-tests@v1
  with:
    suite: unit
    kind: unit                  # or e2e
    key: ${{ secrets.KEY_SERVICE_MYAPP }}   # unset: written and printed, not posted
    reports: |
      vitest vitest.json
      node-test node-test.xml
```

Runners: `playwright` (`--reporter=json`), `vitest` and `jest` (their JSON
reporters), `pytest` (`--junitxml`), `node-test` (`--test-reporter=junit`) and
`junit` (any other JUnit XML: cargo-nextest's `[profile.ci.junit]`). Keep the
runner's console reporter beside the file one, so the log still reads.
A path may be a glob (`vitest packages/*/reports/vitest.json`): every match
is read, and a pattern that matches nothing warns as a missing report.
`relay: 'true'` (with no `key`) uploads the document as the artifact
`report-tests-<suite>` for the hub to post, for a repo on GitHub-hosted
runners that cannot reach the store and must not hold a key.

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

`pytest` reads a `--junitxml` report instead of JSON:

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

A workspace's `e2e.json` may declare `e2eSkipAllow`, an object map of
**`{"<test title>": "<one-line reason>"}`** — the only shape accepted; a
title with no entry, or an entry whose value is not a non-empty string,
fails the skip rule. See [features.md#report-e2e](docs/guide/features.md#report-e2e)
for why that's the only shape it takes.

Every run also leaves its evidence, with nothing to configure:

- **In the log**: an annotation on each failure's file and line, and a
  collapsed group per failed or flaky test with its whole error, its step
  timings and where its trace is. A suite whose reporter prints nothing (vitest
  with only `--reporter=json`) still shows why it failed.
- **As an artifact** (`e2e-evidence-<app>-<attempt>`, `retention-days`, default
  14) on any run that is not green: each failing test's output directory
  (trace, screenshot, video, error-context), the report, and the `artifacts`
  paths (default `e2e-logs/`).
- **In the store**: each row's `error`, `error_location`, `failure_class`
  (`infra | app`, [`classify.mjs`](report-e2e/classify.mjs)) and `steps`, and
  one run record (`POST …/e2e/runs`): the claw, the tool and Node versions, the
  report's status, the run's class (`green | flaky | app | infra | harness`),
  the artifact link, and the commits and package version changes since the
  app's last green run on the branch, read with `github-token` (default the
  job's own; `contents: read` is enough).

A run whose report is missing or unreadable, or whose suite failed outside any
test (a crashed `globalSetup`, a `beforeAll` that threw), is posted as a
`harness` run with the reason, not dropped. Playwright failures with no trace
attached are counted (`evidence_missing`) and warned on; the
`@wolffm/e2e-harness` Playwright preset keeps them.

`gh-run-id` and `repo` default to the calling run's own id and `owner/name`;
override them only for a caller that posts on behalf of another run.
`nightly-run-id` correlates this run with `nightly-e2e.yml`'s dispatch —
leave it unset for a standalone `workflow_dispatch` of your own `e2e.yml`.

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

`node-version` (`22`), `pnpm-version` (`11.5.0`), `registry-url` and `scope`
all default to the fleet's values. Keep `pnpm-version` equal to the repo's
`package.json` `packageManager` — corepack is pinned by that field locally,
and a workflow disagreeing with it is drift nothing reports. The pnpm store
is pinned for the rest of the job at `store-dir` (default
`<tool cache>/pnpm-store`); pnpm 11 reads `pnpm_config_*`, not `npm_config_*`.

Do not add `cache: pnpm` to a caller: it makes `setup-node` shell out to
pnpm to find the store, and corepack has to run *after* `setup-node`, so the
two orderings are mutually exclusive.

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
the fleet's values. The action prepends the venv to `PATH`, so a later bare
`python` is the venv's; prefer the `python` output
(`${{ steps.<id>.outputs.python }}`) where you want it explicit.

## `setup-nextest`

```yaml
- uses: WolffM/hadoku-actions/setup-nextest@v1

- name: Test
  id: test
  run: cargo nextest run --workspace --profile ci

- name: Report the tests
  if: always() && steps.test.outcome != 'skipped'
  uses: WolffM/hadoku-actions/report-tests@v1
  with:
    suite: <stable name>
    reports: junit target/nextest/ci/junit.xml
    key: ${{ secrets.KEY_SERVICE_<REPO> }}
```

with `.config/nextest.toml` beside `Cargo.toml`:

```toml
[profile.ci]
fail-fast = false

[profile.ci.junit]
path = "junit.xml"
```

No inputs: the version and its sha256 per architecture are pinned in the
action, one place for the fleet. nextest runs no doctests; keep
`cargo test --doc` where a crate has them.

## `vault-fetch`

```yaml
- uses: WolffM/hadoku-actions/vault-fetch@v1
  with:
    keys: SOME_SECRET, OTHER_SECRET
  env:
    HADOKU_VAULT_KEY: ${{ secrets.KEY_SERVICE_<REPO> }}
    VAULT_FALLBACK_SOME_SECRET: ${{ secrets.SOME_SECRET }}   # optional
```

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

## `publish-npmjs`

It takes two halves, because npmjs publishes through trusted publishing
(OIDC) and that refuses self-hosted runners:

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
    outputs:
      started-at: ${{ steps.start.outputs.at }}
    steps:
      - id: start
        run: echo "at=$(date -u +%s)" >> "$GITHUB_OUTPUT"
      - uses: WolffM/hadoku-actions/publish-npmjs/publish@v1

  npmjs-report:                  # a hosted runner cannot reach hadoku.me; ours reports for it
    needs: npmjs
    if: always()
    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}
    steps:
      - run: echo "JOB_STARTED_AT=${{ needs.npmjs.outputs.started-at }}" >> "$GITHUB_ENV"
      - if: always()
        uses: WolffM/hadoku-actions/report-job@v1
        with:
          job-name: <repo>:publish-npmjs
          outcome: ${{ needs.npmjs.result }}
          service-key: ${{ secrets.KEY_SERVICE_<APP> }}
          started-at: ${{ env.JOB_STARTED_AT }}
```

Each package must name that repo and workflow file as its trusted
publisher, once:
`npm trust github @hadoku/<name> --repo WolffM/<repo> --file <workflow>.yml --allow-publish`.

## `next-version`

```yaml
- uses: WolffM/hadoku-actions/next-version@v1
  id: version
  env:
    NODE_AUTH_TOKEN: ${{ env.HADOKU_NPM_READ_TOKEN }}   # read access is enough
- if: steps.version.outputs.published != 'true'
  run: npm publish --no-git-checks
  env:
    NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Needs `setup-node` with the package's `registry-url` and `scope` first.

## `wait-for-live` and `prune-prereleases`

For a repo that ships a build per `main` commit to a pre-production
environment and promotes by release: publish, ask for the deploy, then wait
until the deployed thing itself says it is the new build.

```yaml
- name: Ask hadoku_site to publish this build
  uses: WolffM/hadoku-actions/repo-action@v1
  with:
    verb: notify
    body: '{"event_type":"game_bundle_updated","client_payload":{"env":"ppe","tag":"${{ steps.tag.outputs.tag }}"}}'
    service-key: ${{ secrets.KEY_SERVICE_MYREPO }}

- name: Wait until it is being served
  uses: WolffM/hadoku-actions/wait-for-live@v1
  with:
    url: https://hadoku.me/games/myrepo-ppe/version.json
    expect: ${{ steps.tag.outputs.tag }}
    service-key: ${{ secrets.KEY_SERVICE_MYREPO }}

# ... smoke tests, now against the new build ...

- name: Keep the last ten PPE builds
  uses: WolffM/hadoku-actions/prune-prereleases@v1   # job needs contents: write
```

## Versioning

**`v1` is a release tag, moved deliberately through an automated release
gate — never a branch alias, never by hand.**

```sh
gh workflow run actions-release.yml --repo WolffM/hadoku_site -f sha=<full sha>
```

`-f move_tag=false` runs the gate's real-consumer canaries alone, without
moving `v1`. See [contributing.md#releasing](docs/guide/contributing.md#releasing)
for what the gate checks. Callers that cannot afford a fleet-wide break
should pin a commit SHA instead of `@v1`.
