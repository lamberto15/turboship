# turboship

Claude skills for modern CI/CD with GitHub Actions. They **look up versions at the time they run**:
current action releases pinned to commit SHAs, supported runtime versions, latest stable tools. Most
tutorials, and most of what a model remembers, point to outdated actions and end-of-life runtimes.

| Skill | Use it for | Status |
|---|---|---|
| [`github-actions`](skills/github-actions/SKILL.md) | Writing, modernizing and hardening workflows for any project: apps, APIs, libraries, Docker images, scheduled jobs, private or public repos | ✅ v0.1 |
| `package-ci` | CI for JS/TS libraries (pnpm, biome, changesets) | planned |
| `npm-release` | Releasing to npm with changesets and trusted publishing (OIDC, provenance) | planned |

## What `github-actions` does

- Resolves the current version of every action and runtime from the official sources
  (`scripts/resolve-versions.mjs`), and pins actions as `owner/repo@<sha> # vX.Y.Z`.
- Reads release notes before moving an action across a major version (`scripts/release-notes.mjs`),
  so upgrades don't silently break release jobs.
- Applies the rules that matter: least-privilege `permissions`, `concurrency`, `timeout-minutes`,
  setup-action caching, no script injection, Environments + OIDC for deploys, cost-aware defaults
  for private repos.
- Adds Dependabot so pins stay current, and validates with actionlint plus `scripts/check-workflows.mjs`.

### Measured

Three realistic tasks (CI for a private Python API, a Docker image to GHCR, modernizing a 2021
workflow), each run with and without the skill, graded by script (`tests/grade-github-actions.mjs`):

| | Round 1 | Round 2 |
|---|---|---|
| With the skill | 100% | 97% |
| Without | 58% | 65% |

Round 1's 100% hid a real bug: the skill upgraded `actions/setup-node` to v7, which no longer exports
a placeholder `NODE_AUTH_TOKEN`, so a release job would have broken. Round 2 added the release-notes
step and a regression check; the skill then caught it, and the baseline introduced it. The one
round-2 miss (duplicate push + PR runs when the default branch is unknown) was fixed and re-verified
at 12/12.

Without the skill, every run used unpinned actions, most of them one to three majors out of date,
and none added Dependabot.

## Install

As a Claude Code plugin, which installs every skill in the collection:

```
/plugin marketplace add lamberto15/turboship
/plugin install turboship@turboship
```

Or copy a single skill folder (for example `skills/github-actions/`) into `~/.claude/skills/`.

The scripts need Node.js 18 or newer. They use `GITHUB_TOKEN` / `GH_TOKEN` or a logged-in `gh` CLI
to avoid GitHub's anonymous rate limit. actionlint is optional but recommended.

## Repository layout

```
skills/<name>/SKILL.md        the skill
skills/<name>/scripts/        helpers the skill runs (no dependencies)
skills/<name>/references/     detail loaded only when needed
skills/<name>/evals/          test cases (claude plugin eval format)
tests/                        graders and script fixtures
```

## License

MIT
