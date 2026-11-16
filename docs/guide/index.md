---
title: hadoku-actions
summary: >-
  A shared library of GitHub composite Actions for the account's CI: report a
  job's outcome, parse and report end-to-end test results, set up Node/pnpm or
  Python the same way everywhere, fast-forward a bot branch or send a release
  notification, bump `@wolffm/*` dependencies, mirror a package to npmjs, and
  compute the next version before a publish. It is public on GitHub because
  the account's internal deploy contracts are not, and a public repo cannot
  `uses:` a private one — any workflow, in any repo, references these with
  `uses: WolffM/hadoku-actions/<action>@v1`.
features:
  - name: report-job
    summary: 'Posts a workflow job outcome to the execution log, so a red run pages without waiting on a daily digest.'
  - name: report-e2e
    summary: 'Parses a Playwright, vitest or pytest report into per-test rows, enforces a skip-reason rule, and posts them to the nightly e2e store.'
  - name: setup-pnpm
    summary: 'Installs Node and the pinned pnpm, asserts the registry credential, and (with vault-fetch) can read any vault secret at job time.'
    anchor: setup-pnpm-and-vault-fetch
  - name: setup-python-venv
    summary: 'Sets up Python, then builds an isolated throwaway venv so an install never lands in a shared interpreter.'
  - name: repo-action
    summary: 'Asks the account management API to fast-forward a bot branch onto the default branch, or to send a release notification.'
    anchor: repo-action-and-repo-action-cli
  - name: update-wolffm
    summary: 'Bumps every @wolffm/* dependency to latest, commits to a bot branch, and promotes it through repo-action.'
  - name: publish-npmjs
    summary: 'Mirrors an already-built @wolffm/* package to npmjs as @hadoku/*, behind a leak gate, across a two-job trusted-publishing handoff.'
  - name: next-version
    summary: 'Computes one patch above the newest published version and writes it into package.json for the CI job only.'
trivia:
  - 'It began as three byte-identical 5.5KB composite actions, hand-copied into three repos; by the time it moved into its own shared repo, 21 of 26 fleet repos reported nothing at all, one of them red for 46 runs across ten hours with only the daily digest to show it (`126237d`).'
  - '`publish-npmjs/public-packages.json` went from 9 names to 23 in nineteen days (`20ad07d` to `7b974f3`): one entry per decision, because listing a package there makes it world-readable on npmjs forever.'
  - 'The README''s usage example has said `@v1` since the very first commit (`126237d`). The repo also carries a one-off semver tag, `v1.1.0` (2026-09-28, on `ce72571`) — never mentioned in any README revision, before or after.'
  - 'An unbounded curl on the results POST once held a green `rust` job for 38 minutes until its own timeout killed it, misreporting a pass as a cancel (`065ad77`, issue #4).'
---

# hadoku-actions

hadoku-actions is a small library of composite GitHub Actions, referenced
with `uses:` rather than copy-pasted, that give every workflow across the
account's repos the same few pieces of CI plumbing: say whether a job
succeeded, say whether its tests did, set up a toolchain the same way twice,
and move code or a release forward without a long-lived personal token sitting
in every repo's secrets.

It holds no application code and no long-lived secret of its own — a caller
passes in its own key as an input, same as any other action. It is public
because it has to be: the contracts it implements belong to a private part of
the account, and a public repo cannot `uses:` an action out of a private one.

- [Features](features.md): what each action does, its inputs, and its limits.
- [Contributing](contributing.md): the layout, the self-test, and how a change
  reaches `v1`.
- [History](history.md): how the twelve actions arrived, mostly in bursts
  tied to one incident each.
- [Trivia](trivia.md)

## Trivia

The repo currently carries exactly two release tags: `v1` — the name every
`README.md` usage example has used since the first commit (`126237d`) — and
`v1.1.0`, a one-off semver tag cut on 2026-09-28, the day `setup-python-venv`
was added (`ce72571`), and never mentioned in the README again, before or
after. `v1` is documented today as a tag moved deliberately, never a branch
alias, through an automated release gate — never by hand. See
[trivia.md](trivia.md) for the rest.
