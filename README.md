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

`.github/workflows/selftest.yml` exercises the three guards that decide whether
a report is honest: an unset key warns rather than failing the caller, a
cancelled outcome stays silent, and a colon-less `job-name` is refused. The
refusal is proven by running it and asserting the step failed — a guard nothing
fires reads as coverage.

**Stated gap:** every case stops before the `curl`. Exercising the POST means
writing rows to the live execution log, and a self-test that fabricates
monitoring data is worse than one with a known gap. The real callers cover that
path.
