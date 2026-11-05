---
name: package-ci
description: Set up or upgrade CI for a JavaScript/TypeScript library (an npm package) on GitHub Actions with a modern, consistent toolchain - pnpm, Biome for lint and format, a single `verify` script, a Node LTS test matrix, and checks that the published package is correct (exports, types, files) via publint, arethetypeswrong and a pack dry-run. Versions are resolved live, never from memory. Use this skill whenever the user wants CI for a library or npm package, says "make it a proper / serious open-source package", wants to migrate a package from npm or yarn to pnpm, add Biome, check that types and exports resolve for consumers, or prepare a package before setting up releases - even if they only say "add CI to my library". For apps and services use the github-actions skill; for publishing to npm use npm-release after this one.
---

# Package CI

A library is used by people you never meet, on Node versions and module systems you didn't test.
Good package CI therefore checks two things: that the code works (typecheck, lint, test, build
across supported Node LTS lines) and that **what gets published works** (exports and types resolve,
only the intended files ship). It also makes CI and releases run exactly the same checks, so a
release can never skip one.

This skill uses a fixed toolchain so every package looks the same: **pnpm** (package manager),
**Biome** (lint + format), and a `verify` script as the single entry point. It builds on the
**github-actions** skill: read that skill's rules once (pinning, permissions, concurrency,
timeouts), and use its scripts from `../github-actions/scripts/` (relative to this skill's
directory). If that skill isn't installed alongside, say so and install it, or follow the same
rules by hand.

## Workflow

### 1. Inspect the package

From the repo, not from questions:
- `package.json`: package manager (`packageManager`, lockfile), scripts, `engines.node`, `type`,
  `exports` / `main` / `types`, `files`, test runner, build tool.
- Lint/format tools already in use (ESLint, Prettier, existing Biome config).
- Existing workflows (`.github/workflows/`), monorepo layout (`pnpm-workspace.yaml`, workspaces).
- Default branch and visibility (`gh repo view --json defaultBranchRef,visibility`, else git).

### 2. Resolve current versions

```bash
node ../github-actions/scripts/resolve-versions.mjs --min-age 7 --node \
  --npm pnpm @biomejs/biome publint @arethetypeswrong/cli \
  --action actions/checkout actions/setup-node pnpm/action-setup --inputs
```

Use the version the resolver chooses: the newest stable that is at least 7 days old. This matters
for pnpm in particular: recent pnpm refuses dependency versions newer than its
`minimumReleaseAge`, and if you request one anyway it adds `minimumReleaseAgeExclude` entries to
`pnpm-workspace.yaml`. Don't keep such exclusions and don't lower the setting to force a brand-new
version: pick the version the cooldown allows instead. If the project already uses one of these
tools on an older major, read what changed before upgrading (`release-notes.mjs`, or the tool's
changelog) and adapt.

### 3. Toolchain

**pnpm.** Set `"packageManager": "pnpm@<latest>"` in `package.json`; CI's `pnpm/action-setup`
reads it, so local and CI use the same version (don't rely on corepack; current Node no longer
ships it). Migrating from npm/yarn: `pnpm import` converts an existing lockfile (keeps resolved
versions), then delete `package-lock.json` / `yarn.lock` and run `pnpm install`. If pnpm reports
ignored build scripts, approve only the dependencies that need them (`pnpm approve-builds`) rather
than enabling all scripts: blocking install scripts by default is a supply-chain protection.

**Biome.** `pnpm add -D -E @biomejs/biome` (exact version, so formatting doesn't change under you),
`pnpm exec biome init`, scripts `"lint": "biome check ."` and `"format": "biome check --write ."`.
If the project uses ESLint or Prettier, tell the user you're replacing them and use
`biome migrate eslint --write` / `biome migrate prettier --write` to carry the existing rules over;
remove the old configs and dependencies afterwards. Run `biome check --write .` once and review the
diff: formatting-only changes are fine; if real lint findings appear, fix them or, when a rule
clearly doesn't fit the codebase, turn it off in `biome.json` with a short reason.

**Scripts.** Keep the project's own commands, and add one entry point:

```json
"verify": "pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build"
```

(Include only the steps the project has: no typecheck for plain JS, no build if nothing is built.)
CI runs `pnpm run verify`; the release workflow from the npm-release skill runs the same script.

**Package metadata** (fix what's missing, explain each change):
- `exports` with a `types` condition first for each entry point (and `main`/`types` for older tools).
- `files` whitelist (`dist`, README, LICENSE, CHANGELOG) so tests and sources don't ship by accident.
- `engines.node` matching what CI tests.
- `"sideEffects": false` only if the package truly has none.

### 4. CI workflow

Follow the github-actions skill's rules, with this structure:

- **`.github/actions/setup/action.yml`** (composite): `pnpm/action-setup` →
  `actions/setup-node` with `cache: pnpm` and the requested Node version → `pnpm install --frozen-lockfile`.
  Give it inputs `node-version` (default: the active LTS) and `registry-url` (default empty; the
  release workflow passes `https://registry.npmjs.org`). Every workflow (CI now, release later)
  uses it, so versions live in one place.
- **`verify` job**: matrix over the supported Node LTS lines from the resolver, trimmed to
  `engines.node` (always include the active LTS), `fail-fast: false`, runs `pnpm run verify`.
  Linux by default; add Windows only when the library touches paths, the filesystem or child
  processes.
- **`package` job** (one Node version): `pnpm run build`, then
  `pnpm exec publint --strict` (package.json correctness) and
  `pnpm exec attw --pack .` (types resolve for consumers; use `--profile esm-only` for ESM-only
  packages, `--profile node16` when CommonJS consumers on the old `node10` resolution aren't
  supported), then `pnpm pack --dry-run` and confirm the file list contains only what should ship.
  Add `publint` and `@arethetypeswrong/cli` as exact devDependencies so CI and local runs agree.
- **`ci-ok` aggregator job** (`if: always()`, `needs:` all jobs, fails if any failed or was
  cancelled): make this the **only** required status check, so changing the Node matrix never
  breaks branch protection (see the github-actions recipes).
- Triggers: `pull_request` + `push` to the default branch + `workflow_dispatch`; top-level
  `permissions: contents: read`; PR concurrency; timeouts.

### 5. Dependabot

`github-actions` and `npm` ecosystems (Dependabot's `npm` ecosystem handles pnpm lockfiles), weekly,
`cooldown: default-days: 7`, grouped: one PR for actions, one for development dependencies,
production dependencies separately.

`@types/node` must match the **oldest** Node the package supports (`engines.node`), not the newest:
newer types describe APIs that users on the minimum Node don't have, and can even break the build
(e.g. stricter `Blob`/`Uint8Array` typings). Add to the npm entry:

```yaml
    ignore:
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
```

When Dependabot proposes a grouped update that turns CI red, find which package causes it
(update them one at a time locally), take the safe ones in a PR, and close the Dependabot PR with a
comment saying why.

### 6. Validate locally before declaring done

1. Run `pnpm run format` **after the last file you write** (Biome 2.6+ also formats YAML and
   Markdown, so new workflows and READMEs are linted too), then `pnpm install` and
   `pnpm run verify`: it must pass, and it must be the last command you run before reporting. If it fails because of the project (not
   the setup), report the failure with the output instead of weakening checks.
2. Run the package checks locally (`publint`, `attw --pack .`, `pnpm pack --dry-run`).
3. `actionlint` and `node ../github-actions/scripts/check-workflows.mjs --latest`.

### 7. Report back

Summarize: toolchain changes (with versions and dates), files added/changed, each package metadata
fix and why, the CI jobs, the required check to configure (`ci-ok`), and anything left for the
user. Next step for publishing: the **npm-release** skill.
