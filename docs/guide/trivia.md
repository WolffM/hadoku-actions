# Trivia

- **Three copies, one bug each.** Before `report-job` existed, three repos
  each carried a byte-identical, 5.5KB vendored copy of the same curl-and-jq
  script, and the copies had already drifted — an unset-key guard present in
  one and missing in another. Collapsing them into this shared repo still
  left 21 of 26 fleet repos reporting nothing at all, one of them red for 46
  runs across ten hours before anyone noticed outside the daily digest
  (`126237d`).

- **One list, one-way door.** `publish-npmjs/public-packages.json` opened
  with 9 package names on 2026-10-27 and had grown to 23 by 2026-11-15 —
  never shrinking. An unpublish from npmjs is only honored for 72 hours,
  and a version number can never be reused once it ships (`20ad07d` →
  `7b974f3`).

- **A tag that stuck, and one that never caught on.** `README.md`'s own
  usage example has pointed at `@v1` since the repo's very first commit
  (`126237d`, 2026-08-31). The repo's only other current tag, `v1.1.0`
  (semver, cut 2026-09-28 the day `setup-python-venv` landed — `ce72571`), is
  not mentioned in any commit's `README.md` before or after.

- **A pass that read as a cancel.** Before either `report-job` or
  `report-e2e` bounded its own POST to the results store, an unanswered
  request could hold a job open indefinitely. On 2026-10-29 that held one
  green job for 38 minutes and another's nightly run for 11, until each was
  killed by its own `timeout-minutes` and read, wrongly, as cancelled rather
  than passed (`065ad77`, issue #4).

- **"The number is irrelevant, newest wins."** `next-version` reads every
  published version at once rather than walking up from whatever
  `package.json` says. Its own source attributes that whole design to one
  line from the operator, dated the day the file was written (`37e983e`,
  2026-11-01).

- **Eleven ways to leak a secret, unchanged since day one.** Before a
  package can reach npmjs, `publish-npmjs`'s leak gate checks every file
  against 11 secret-shaped patterns. They cover a GitHub or npm token, an
  AWS key, a Slack token, a JWT, a private key, a Discord webhook, a fleet
  host name, a private IPv4 address, and others. It also checks 4
  forbidden file types — `.env`, `.npmrc`, vault config, key material — the
  same list, unedited, since the gate's first commit (`20ad07d`,
  `publish-npmjs/prepare.mjs`).
