# turboship

[![skills.sh](https://skills.sh/b/lamberto15/turboship)](https://skills.sh/lamberto15/turboship)

Claude skills for modern CI/CD with GitHub Actions. They **look up versions at the time they run**:
current action releases pinned to commit SHAs, supported runtime versions, latest stable tools, with a
7-day cooldown so brand-new releases (where supply-chain attacks land) aren't adopted instantly. Most
tutorials, and most of what a model remembers, point to outdated actions and end-of-life runtimes.

| Skill | Use it for | Status |
|---|---|---|
| [`github-actions`](skills/github-actions/SKILL.md) | Writing, modernizing and hardening workflows for any project: apps, APIs, libraries, Docker images, scheduled jobs, private or public repos | ✅ v0.1 |
| [`package-ci`](skills/package-ci/SKILL.md) | CI for JS/TS libraries: pnpm, Biome, one `verify` script, Node LTS matrix, checks that the published package works (publint, arethetypeswrong, pack file list) | ✅ v0.1 |
| [`npm-release`](skills/npm-release/SKILL.md) | Releasing to npm with Changesets and trusted publishing (OIDC, no token, provenance); never publishes by itself | ✅ v0.1 |

The skills build on each other: `github-actions` → `package-ci` → `npm-release`.

## Results

| Skill | Benchmark | With the skill | Without | Real repository |
|---|---|---|---|---|
| github-actions | 5 tasks × 3 runs | 99.4% | 76.6% | turbomerge CI green on GitHub |
| package-ci | 2 tasks × 3 runs | 99.0% ± 2.5 | 54.8% ± 15.2 | turbomerge: pnpm + Biome + package checks, green on GitHub |
| npm-release | 2 tasks × 3 runs | 98.0% ± 3.1 | 68.0% ± 5.9 | turbomerge: `0.1.1` released fully by CI (changesets, trusted publishing, provenance) |

The package graders don't just read files: they run `pnpm install --frozen-lockfile && pnpm run verify`
on every output. Testing also caught things that went into the skills: Changesets v3's `changeset init`
is interactive, Biome 2.6 lints Markdown, changesets/action v2 renamed its inputs and ignores a
`GITHUB_TOKEN` env var, and pnpm refuses dependencies newer than its `minimumReleaseAge`.

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

Five realistic tasks, each run **3 times with and 3 times without** the skill (30 runs), graded by
script (`tests/grade-github-actions.mjs`, 11–12 checks per task):

| Task | With the skill | Without |
|---|---|---|
| CI for a private Python API (uv, free plan) | 100% | 79% |
| Docker image to GHCR on tags | 97% | 61% |
| Modernize a 2021 Node workflow | 100% | 67% |
| Go service CI (race, golangci-lint) | 100% | 94% |
| Deploy to staging → production with AWS OIDC | 100% | 82% |
| **Overall** | **99.4%** | **76.6%** |

With the skill, runs used about 8k more tokens and finished about 15 s faster on average.

Without it, the gap is mostly memory: actions not pinned to commits and one to three majors out of
date, no Dependabot, missing job timeouts, and the old workflow still running every PR twice. On the
Go task the model already does well on its own, so the skill adds little there.

Earlier rounds also taught the skill to read release notes before crossing a major version. An
early round flagged the `actions/setup-node` v7 `NODE_AUTH_TOKEN` change as breaking a release job;
the official notes limit that to Yarn 1.x and older npm, so that claim was overstated and the grader
now follows the notes.

**Real repository:** CI written with the skill for `lamberto15/turbomerge` ran green on GitHub
(Node 24 and 26) with no warnings.

## Install

With the [skills](https://skills.sh) CLI, for Claude Code, Codex, Cursor, OpenCode and other agents:

```sh
npx skills add lamberto15/turboship
```

Install the whole collection: `package-ci` and `npm-release` use the scripts of the `github-actions`
skill, so it must be installed next to them.

Or as a Claude Code plugin:

```
/plugin marketplace add lamberto15/turboship
/plugin install turboship@turboship
```

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
