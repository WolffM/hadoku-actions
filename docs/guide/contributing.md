# Contributing

This is a map of the repo and its checks. [`README.md`](../../README.md) is
the longer reference — every action has its own section there with the
incident that shaped it; read it before changing one.

## Layout

```
<action>/action.yml          one composite action per top-level directory
report-e2e/parse.mjs         the report parser report-e2e's action.yml calls
publish-npmjs/prepare.mjs    the pack/rewrite/leak-gate publish-npmjs's action.yml calls
publish-npmjs/public-packages.json   the allow-list prepare.mjs checks against
publish-npmjs/publish/       the second, GitHub-hosted half of publish-npmjs
repo-action/call.sh          the HTTP call repo-action, repo-action-cli and
                              update-wolffm all share
vault-fetch/fetch.sh         the vault read, shared by vault-fetch's own
                              action and setup-pnpm's vault path
next-version/next-version.mjs   the version arithmetic, with its own test file
.github/workflows/selftest.yml  the one CI workflow: a job per action
.github/selftest/            fixtures and stand-ins the self-test drives:
                              fake-broker.py, fake-e2e-store.py, fake-npm.sh,
                              and a *-cases.sh per action whose `run:` shell
                              is extracted and tested directly
```

There is no root `package.json`. Every action is a composite action with a
plain `run:` shell or a `node`/`node -e` one-liner — deliberately no
dependency to install, since nothing here can assume a package manager ran
first.

## Running the self-test locally

Several of the `*-cases.sh` scripts under `.github/selftest/` run outside a
runner — e.g. `bash .github/selftest/report-job-cases.sh` extracts
`report-job`'s own shell from `action.yml` and runs it against a stand-in
`curl` that records what it would have sent, so the guards (an unset key
warns, a colon-less `job-name` is refused, a `cancelled` outcome at or past
`timeout-minutes` is reported as `failed`) can be asserted without a real
runner or a real key. `next-version` additionally has its own unit test,
`node --test next-version/next-version.test.mjs`, covering the version
arithmetic directly.

Most of the other coverage — the `uses:`-based jobs in
[`.github/workflows/selftest.yml`](../../.github/workflows/selftest.yml) —
needs a real GitHub Actions runner and is easiest to exercise by pushing a
branch and letting the workflow run; it fires on `pull_request`, on `push` to
`main`, and on `workflow_dispatch`.

## Tests and gates

`.github/workflows/selftest.yml` is the only workflow and the only gate: one
job per action, run on a GitHub-hosted runner (never self-hosted — a public
repo running pull-request code must not touch a persistent, shared runner).
Each job proves its guards by *firing* them and asserting the step actually
failed, rather than trusting that a guard exists — the review standard stated
throughout the repo is "a guard nothing fires reads as coverage." A few
actions state a real gap outright rather than fake coverage for it:
`report-job` and `report-e2e` never POST to the real stores from the
self-test, because a public repo's hosted runner holds no real service key,
and faking that would be worse than a known gap; the real callers exercise
that path. The `publish-npmjs` jobs run the real two-runner handoff with
`npm publish --dry-run`, so nothing is actually published.

There is no separate lint or formatter command in this repo — no root
`package.json`, no `.eslintrc`/`.prettierrc`, and no `shellcheck`/`actionlint`
step in `selftest.yml`. The only gate on a change is the self-test above.

## Releasing

`v1` is a release tag, moved deliberately — never a branch alias, and never
by hand. A change lands on `main` once the self-test is green there, and then
moves through an automated release gate elsewhere in the account: it refuses
a commit that is not on `main` or whose self-test did not pass, runs a
handful of real consumers' own build-and-publish path (`hadoku-aggregator`,
`hadoku-contact-ui`, `hadoku-craft`) against the candidate actions with a
cold cache, and moves `v1` only if every one of them is still green. A caller
that cannot afford a fleet-wide break can pin a commit SHA instead of `@v1`.

## Trivia

The self-test workflow (`.github/workflows/selftest.yml`) is the single most
revised file in the repo after `README.md` itself — 23 separate commits touch
it (`git log --oneline -- .github/workflows/selftest.yml | wc -l`, run
2026-11-16), nearly one for every behavioral change any action made.
