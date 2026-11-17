# hadoku-actions

hadoku-actions is a small library of composite GitHub Actions, referenced
with `uses:` rather than copy-pasted. It gives every workflow across the
account's repos the same few pieces of CI plumbing: say whether a job
succeeded, say whether its tests did, and set up a toolchain the same way
twice. It also lets code or a release move forward without a long-lived
personal token sitting in every repo's secrets.

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

The repo currently carries exactly two release tags. `v1` is the name every
`README.md` usage example has used since the first commit (`126237d`).
`v1.1.0` is a one-off semver tag cut on 2026-09-28, the day
`setup-python-venv` was added (`ce72571`), and never mentioned in the
README again, before or after. `v1` is documented today as a tag moved deliberately, never a branch
alias, through an automated release gate — never by hand. See
[trivia.md](trivia.md) for the rest.
