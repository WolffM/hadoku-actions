# History

Forty-six commits, all one author, over seventy-six days (2026-08-31 to
2026-11-15; fact sheet, 2026-11-16). The repo grew almost entirely in bursts,
each tied to one real incident rather than a planned rollout.

## Born from three copies, 2026-08-31 to 2026-09-01

`report-job` and `setup-pnpm` are the repo's first two actions, both landing
in its first two commits. `report-job` replaced three byte-identical,
5.5KB vendored copies of the same curl-and-jq script that had already drifted
from each other; by the time this shared repo existed, 21 of 26 repos in
fleet-wide CI coverage reported nothing at all — one of them red for 46 runs
across ten hours with only a daily digest to say so (`126237d`). The next
day, a bug in how the execution log's upsert was keyed — by run, not by job
within a run — meant two jobs in one matrix overwrote each other's row, a
failed one erased by a later success; fixed the day after the first commit
(`b62bc4c`, 2026-09-01).

## setup-python-venv, 2026-09-28 to 2026-10-01

A self-hosted machine's Python installation is shared by every job that lands
on it, and two runs of one unchanged workflow had been seen resolving
dependencies from two different places on two different machines. `setup-python-venv`
adds a throwaway venv under `RUNNER_TEMP` after `setup-python` runs, so every
dependency resolves from the project's own metadata rather than from whatever
a previous job happened to leave behind (`ce72571`; selftest added the same
day, `4719947`). A one-off semver tag, `v1.1.0`, was cut this same day and
never mentioned in any `README.md` revision again; every usage example,
before and after, has named `@v1` instead, back to the first commit
(`126237d`).

Its `cache` option stayed off by default from the start — enabling it on a
self-hosted runner had, on one measured run, archived a shared 5.8 GB pip
cache and burned 20 of 22 CI minutes failing to restore it, against 31 seconds
for the install it was meant to speed up (`7636571`, 2026-10-01).

## setup-pnpm gets a vault, 2026-10-07

The registry token `setup-pnpm` asserts had lived only as a GitHub Secret
copied into roughly twenty repos, rotated by hand, one repo at a time. On
2026-10-07 the old value died at 19:13:25 and the manual sweep finished at
19:14:24; six jobs that started in that one-minute window 401'd. `setup-pnpm`
gained a `vault-key` input so the token is read from a central vault broker at
job time instead — one write, every later job sees it (`21a6d0b`).

## report-e2e, 2026-10-21 — tied for the busiest day

Five commits in one day add `report-e2e` from nothing — 2026-10-21 ties
2026-10-23 as the repo's busiest day, both at 5 commits (`git log
--format=%ad --date=format:%Y-%m-%d | sort | uniq -c | sort -rn`). Parsing
Playwright and
vitest JSON reports into per-test rows and enforcing a skip-reason rule
(`88b55ec`), failing the job on a POST that never reached the store rather
than just warning (`00cd2b1`), tightening `e2eSkipAllow` from a bare array of
titles to a `{title: reason}` map after the array shape would have silently
read a real 80-entry allow-list as empty (`9771b81`), and adding a `pytest`
`--junitxml` parser with its own empirically-verified flaky-rerun mapping
(`920177c`, `2e4ceb7`).

## repo-action, repo-action-cli and update-wolffm, 2026-10-23 to 2026-10-24

Every child repo had been holding one powerful, account-wide token to promote
its own bot branches or send release notifications; `repo-action` replaces
both uses with a per-repo service key the management API resolves back to
exactly that repo (`0709596`). `repo-action-cli` exposes the same script for a
caller that must retry its own promote from inside a loop, rather than a
single `uses:` step (`6855624`). `update-wolffm` consolidates what had been
twenty separately drifted `update-wolffm.yml` bodies into one action built
from their common core (`ffd0428`), gains the restore of in-repo
`workspace:*` ranges the bump had rewritten away (`4b79b61`), and a rebase
before every push rather than only after a conflict (`197f606`). The same two
days give `report-job` a real distinction between a `cancelled` outcome and a
`timeout-minutes` kill, which GitHub reports identically (issue #2, `dfc40a9`),
`report-e2e` a `post: 'false'` mode for a per-push gate with no key to send
(`f3200e6`), and `repo-action` a two-minute retry budget after a
three-tries-four-seconds retry twice lost a publish notification to a
management-API restart measured at 6-11 seconds (`9b3a70c`, 2026-10-24).

## publish-npmjs, 2026-10-27 onward

GitHub Packages demands a token to install even a public package, so a public
repo could not be built by anyone outside the fleet. `publish-npmjs` mirrors
an allow-listed set of `@wolffm/*` packages to npmjs as `@hadoku/*` instead —
the first commit lands the pack/rewrite/leak-gate half, the trusted-publishing
half on a GitHub-hosted job, and the registry-level 401 workaround via a
rewritten alias, all in one day (`20ad07d`, `613d3e5`). The allow-list in
`publish-npmjs/public-packages.json` opened with 9 names and reached 23 by
2026-11-15 — one addition at a time, because listing a package there makes it
world-readable on npmjs forever (`20ad07d` → `7b974f3`). An unbounded POST in
`report-job` and `report-e2e` — the same bug, different store — held a green
job for 38 and 11 minutes respectively before its own timeout killed it,
misreporting a pass as a cancel; both gained a bound the same day (`065ad77`,
issue #4, 2026-10-30).

## next-version, and promote/sync-main-to-ppe leaving the same day, 2026-11-01

`next-version`, `promote` and `sync-main-to-ppe` all landed in one commit
that added 2,090 lines across 19 files (`37e983e`, 2026-11-01 13:08). Under
an hour later, `promote` and
`sync-main-to-ppe` moved out to hadoku-fleet-manager; `next-version` is the
one piece of that commit built to stay here, because every repo that
publishes a package needs it regardless of how that repo promotes a release
(`bc516f5`, 2026-11-01 14:02).

## Hardening the mirror, 2026-11-02 to 2026-11-15

`setup-pnpm` gained a pinned pnpm store for the whole job, after `pnpm run`
re-linking against the default store under a placeholder token had 401'd on
the newest `@wolffm/*` package fleet-wide, every publish day (issue #5). The
remaining commits through 2026-11-15 grow `public-packages.json` package by
package and make `update-wolffm`'s own freshness check tolerant of the npmjs
mirror lagging GitHub Packages by minutes, waiting for npmjs to actually
serve a version it already lists before trusting a comparison against it
(issue #6, `a54706c`, 2026-11-07).

## wait-for-live and prune-prereleases, 2026-11-15

The most recent commit adds the two pieces a per-commit PPE promotion still
needed beyond `repo-action`'s notify: `wait-for-live` polls a deployed
build's own JSON answer until it reports the version just published, and
`prune-prereleases` deletes the oldest prerelease builds past a keep count
so a PPE environment's release list doesn't grow forever (`4b9a20a`).

## Trivia

The two actions that left this repo on 2026-11-01 — `promote` and
`sync-main-to-ppe` — are the only directories ever removed here; every other
action added across these 46 commits is still present today.
