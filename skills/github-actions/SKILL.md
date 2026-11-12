---
name: github-actions
description: Write, modernize, review and harden GitHub Actions workflows for any kind of project (web apps, APIs, libraries, Python, Go, Rust, Docker images, static sites, scheduled jobs, monorepos, private or public repos). Resolves the CURRENT versions of actions and runtimes live instead of writing them from memory, pins actions to commit SHAs, applies least-privilege permissions, concurrency, timeouts and caching, adds Dependabot, and validates the result. Use this skill whenever the user wants CI, CD, a pipeline, a build/test/lint/deploy/release automation, anything under .github/workflows, a GitHub Action, Dependabot for actions, or asks to fix, speed up, secure or update an existing workflow, even if they never say "GitHub Actions".
---

# GitHub Actions

Most workflows on the internet, and most of what a model remembers, use action versions and
runtime versions that are already outdated (`actions/checkout@v2`, Node 16, Python 3.8...). Old
action majors run on retired Node runtimes and break; old language versions are end-of-life. So
this skill never writes a version from memory: it looks versions up, pins them, and leaves
Dependabot in place to keep them current afterwards.

## Workflow

### 1. Understand the project before writing YAML

Look, don't ask, for what the repo already tells you:

- **Ecosystem and commands**: `package.json` (+ lockfile → npm/pnpm/yarn/bun), `pyproject.toml` /
  `uv.lock` / `requirements*.txt`, `go.mod`, `Cargo.toml`, `Dockerfile`, `composer.json`, `Gemfile`...
  Reuse the project's own scripts (`npm run test`, `make test`, `uv run pytest`) rather than inventing
  commands, so CI runs exactly what developers run.
- **Runtime version files**: `.nvmrc`, `.node-version`, `.python-version`, `go.mod`, `.tool-versions`,
  `engines` / `requires-python`. Prefer the setup action's `*-version-file` input over a hard-coded version.
- **Existing workflows** in `.github/workflows/` and composite actions in `.github/actions/`:
  modernize them in place rather than adding parallel ones.
- **Repo visibility and default branch**, when `gh` is available:
  `gh repo view --json visibility,defaultBranchRef`. Private repos pay for minutes (see
  "Private repositories" below), which changes defaults. Without `gh`, read the default branch from
  git (`git symbolic-ref --short refs/remotes/origin/HEAD`, else the current branch). If it still
  can't be determined, don't keep `push` on every branch just to avoid guessing: that runs every PR
  twice. Use `branches: [main, master]` (one of them exists in almost every repo), keep `tags:` if
  the workflow releases on tags, and tell the user which line to adjust.

Only ask the user about what you genuinely cannot infer (e.g. where to deploy, which secrets exist).

### 2. Resolve current versions

Run the bundled resolver for every action and runtime the workflow will use:

```bash
node <skill-dir>/scripts/resolve-versions.mjs \
  --node \                                   # Node LTS lines (for Node projects)
  --runtime python \                         # any endoflife.date product: python, go, ruby, php, ...
  --action actions/checkout actions/setup-node docker/build-push-action
```

It prints ready-to-paste `uses: owner/repo@<40-char-sha> # vX.Y.Z` lines, the supported runtime
lines, and the current Node active LTS. Add `--inputs` to also list each action's inputs (with
defaults and deprecations) read from its `action.yml` at that exact commit: write `with:` keys from
that list, not from memory, because inputs get renamed and removed between majors. Add `--json` for
machine-readable output. It needs Node ≥ 18 and network access; it uses `GITHUB_TOKEN`/`GH_TOKEN` or
a logged-in `gh` CLI to avoid GitHub's anonymous rate limit.

If the resolver cannot run (no network), say so explicitly in your summary and mark every version
you wrote as unverified, rather than presenting remembered versions as current.

Version policy:
- **Cooldown**: run the resolver with `--min-age 7` so it picks the newest stable release that has
  been public for at least 7 days (it still reports anything newer). Freshly published releases are
  where supply-chain attacks land and where regressions get caught; a week's delay costs nothing.
  Skip the cooldown only for a security fix the user needs now, and say so.
- **Actions**: latest stable release (after the cooldown), pinned to its commit SHA with the version as a comment.
- **Crossing a major version** (an existing workflow on `v4` moving to `v7`, or a pattern you know
  from an older major): first read what changed with
  `node <skill-dir>/scripts/release-notes.mjs <owner/repo> <current-version>`. Majors exist because
  something broke: removed inputs, changed defaults, dropped environment variables, new required
  permissions. For each breaking change, check whether it actually applies to this workflow, and
  read the exact conditions rather than reacting to the headline. Example: setup-node v7 stopped
  exporting a placeholder `NODE_AUTH_TOKEN`; its notes say this can break Yarn 1.x and older npm
  when `registry-url` is set, while current npm is unaffected, so it matters for a Yarn-1 release
  job and not for one on a current Node LTS. If a breaking change
  can't be handled safely now, stay on the previous major, say why in the summary, and let
  Dependabot propose the upgrade later. Latest is the goal; a release that silently breaks is not.
- **Runtimes in a test matrix**: the supported lines the project claims to support (trim to the
  project's minimum, e.g. `engines.node` or `requires-python`). Drop end-of-life lines.
- **Runtime for deploy/release jobs**: the newest LTS (for Node: `activeLts`), or the version file.
- **Never** prereleases, betas, or `@main`/`@master` refs.

### 3. Write the workflow following these rules

Each rule exists for a concrete reason; keep the reason in mind when a situation doesn't fit neatly.

| Rule | Why |
|---|---|
| Pin every action to a full commit SHA + `# vX.Y.Z` comment (local `./` actions excepted) | Tags are mutable; a compromised tag (as in the tj-actions incident) runs attacker code with your token. The comment lets humans and Dependabot read and update the pin. |
| Top-level `permissions: {}` or `contents: read`, then grant extra scopes per job | The default token may be read/write. Least privilege limits the blast radius of any compromised step. |
| `concurrency` on push/PR workflows: `group: ${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` | Stops paying for superseded PR runs while never cancelling runs on the default branch. Deploy/release workflows use `cancel-in-progress: false`. |
| `timeout-minutes` on every job | The default is 6 hours; a hung job silently burns minutes. Set roughly 2-3× the normal duration. |
| Triggers: `pull_request` + `push` to the default branch (+ `workflow_dispatch`) | `push` on every branch plus `pull_request` runs everything twice. |
| `paths-ignore` (e.g. `**.md`, `docs/**`) on CI when docs changes are common | Docs-only changes shouldn't cost a full build. Not on workflows that provide required checks unless a skip job reports success (see references/recipes.md). |
| Use the setup action's built-in cache (`cache: pnpm`, `cache: pip`, `enable-cache` for uv, default in setup-go) | Correct cache keys for free; hand-rolled `actions/cache` keys are a common source of stale or useless caches. |
| `actions/checkout` with `persist-credentials: false` unless a later step pushes | Otherwise the token stays in `.git/config` for every subsequent step. |
| `ubuntu-latest` by default; macOS/Windows only when the code is platform-specific | Linux is fastest and cheapest (private repos bill Windows/macOS minutes at higher rates). |
| Test matrices: `fail-fast: false` | One failing version shouldn't hide the result of the others. |
| Never expand untrusted input (`github.event.*` titles/bodies/branch names, `github.head_ref`) inside `run:`; pass it via `env:` | Expression expansion happens before the shell runs, so it is script injection. |
| Deploys use GitHub **Environments** and cloud **OIDC** (`id-token: write`) instead of long-lived keys | Short-lived credentials, per-environment secrets, optional required reviewers before production. |
| Two or more workflows with the same setup steps → a composite action in `.github/actions/setup/` | One place to change versions; workflows can't drift apart. |
| Jobs whose tests or steps use Docker (testcontainers, `docker compose`, `docker run`): a `timeout 90 sh -c 'until docker info >/dev/null 2>&1; do sleep 2; done'` step first, and test setups that retry ~60 s when `CI` is set (`services:` containers are exempt: the runner waits for their health checks) | On fresh runners the daemon is intermittently not ready yet (seen on Ubuntu 26.04 images); without the wait, a release job that runs the tests fails at random. |
| Timing/benchmark assertions only locally (`it.skipIf(process.env.CI)`) or in a nightly workflow, never in the per-push gate | Numbers measured on a laptop don't hold on shared Linux runners. |
| Derive tarball and artifact names from `package.json` / tool output, never hard-code `<name>-*.tgz` | A package rename (e.g. a scope change) breaks the glob silently. |

Ready-made patterns per ecosystem (Node, Python, Go, Rust, Docker/GHCR, deploy with OIDC, scheduled
jobs, monorepo path filters, skip-safe required checks) are in **references/recipes.md**: read the
section for the project's stack before writing. Security details (pull_request_target, fork PRs,
secrets, OIDC trust) are in **references/security.md**: read it when the workflow deploys, publishes,
handles secrets, runs on `pull_request_target`/`workflow_run`, or comments on PRs.

### 4. Keep it current: Dependabot

Add or extend `.github/dependabot.yml` with the `github-actions` ecosystem (and the project's package
ecosystem if it has none). Dependabot understands SHA pins and updates the version comment. Group
updates so they arrive as one weekly PR instead of a flood:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7      # same cooldown as the resolver; security updates are not delayed
    groups:
      actions:
        patterns: ["*"]
```

### 5. Validate before declaring done

1. **actionlint** (syntax, expressions, shellcheck of `run:` blocks, outdated action runners):
   `actionlint` if installed; otherwise `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`,
   or install it (`brew install actionlint`, `go install github.com/rhysd/actionlint/cmd/actionlint@latest`).
2. **Bundled policy check** (SHA pins, permissions, timeouts, concurrency, injection, outdated majors):
   `node <skill-dir>/scripts/check-workflows.mjs --latest`
3. If the repo is pushed and `gh` is available, offer to trigger the workflow
   (`gh workflow run` / push a branch) and watch it (`gh run watch`) rather than assuming it passes.

Fix every error. Warnings may be accepted when there is a reason; state the reason.

### 6. Report back

End with a short summary the user can act on:
- the workflows/files created or changed, and what each does;
- a table of the versions used (action → version, runtime matrix) and the date they were resolved;
- **manual steps** the repo owner must do (create secrets or environments, enable a setting, add
  required status checks: their names are the job names, including matrix values like
  `test (24)`; when you change a matrix or rename a job, the required checks must be updated too);
- anything unverified or skipped.

## Private repositories

Private repos consume the account's monthly Actions minutes, and Windows/macOS runners consume them
at a multiple of the Linux rate. Default to: Linux runners only, caching, PR concurrency cancellation,
docs path filters, and a lean matrix (newest + oldest supported version instead of every version,
unless the user wants full coverage). Branch rulesets / required status checks on private repos need a
paid GitHub plan (Pro, Team, Enterprise); on a free plan, say so instead of writing settings that won't apply.

## Modernizing an existing workflow

Preserve what the workflow does (jobs, triggers, secrets, artifacts, environment names); change how.
Run `release-notes.mjs` for every action whose major changes, and trace each step that touches
credentials, registries, caches or outputs through the new version's behavior: those are where
upgrades break silently, often only on the release path that CI on a PR never exercises.
Typical upgrades: unpinned/old action majors → current SHA pins; EOL runtime versions → supported
lines from the resolver; `set-output`/`save-state` → `$GITHUB_OUTPUT`/`$GITHUB_STATE`; missing
permissions/concurrency/timeouts added; hand-rolled caches → setup-action caching. Call out behavior
changes (e.g. a dropped EOL runtime from the matrix) in the summary instead of silently making them.
