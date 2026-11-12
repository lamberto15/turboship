# Changelog

## 0.2.0 (2026-11-12)

Lessons from the first real release of a pnpm monorepo (two packages with fixed versions,
Changesets pre mode `alpha`, npm trusted publishing with provenance) on 2026-11-12. The pipeline
worked; these are the problems it hit along the way.

### npm-release

- **Scope preflight before any file is written** (new step 0). The planned scope was owned by an
  npm user account with zero packages, because npm users and orgs share one namespace, so creating
  the org failed late. The check uses `https://registry.npmjs.org/-/org/<scope>/package`
  (404 `Scope not found` = free; 200, even `{}`, = taken by a user or an org). It was verified
  live: npmjs.com answers scripts with 403, so `https://www.npmjs.com/~<scope>` is documented as a
  page for the human to open, not as an automated check. The skill proposes fallbacks
  (`<org>-js`, unscoped names) and forbids hard-coded tarball names.
- **First publish happens in the owner's terminal.** Without a TTY, 2FA by security key or passkey
  makes `pnpm publish` fail (`ERR_PNPM_OTP_NON_INTERACTIVE`) and `npm publish --auth-type=web`
  exit with `EOTP`, including through an agent's shell. RELEASING.md now gives what worked:
  `pnpm pack` per package (resolves `workspace:*`), then `npm publish <tarball> --access public
  --auth-type=web`, dependencies first. It also says "wait, don't retry" for the registry delay
  and the interim `0.0.0-stage` version, and states that an agent can't do this step.
- **Dist-tag choice up front.** A hand-published placeholder takes `latest` while Changesets pre
  mode releases to `alpha`, so `npm install <pkg>` got the placeholder. The runbook offers
  `--tag placeholder` (and says it still gets `latest` on a new package), then
  `npm dist-tag add … latest` or `npm deprecate …@0.0.0` after the first CI release.
- **Org-level Actions setting first.** "Allow GitHub Actions to create and approve pull requests"
  returns `409` at repo level while the org setting is off, and the org setting needs `admin:org`.
  The runbook and hardening reference now list the org URL first, and the skill hands the step to
  the owner when an agent is blocked.
- **Going public safely** (references/repo-hardening.md): a commit author email audit, a
  `git filter-repo --mailmap` + `--replace-message` rewrite (DCO lines) to the noreply address,
  done once after all branches are merged, with one `--force-with-lease` push and
  `git config user.email` afterwards. It warns that `refs/pull/N/head` keeps old commits, with a
  ready-to-send GitHub Support request; adds deleting stale remote branches (Dependabot's too);
  and lists the post-public security settings and rulesets.
- **RELEASE_PAT trade-off spelled out.** Without it the version PR shows "no checks reported". That
  is acceptable because `main` CI and the publish job's `pnpm run verify` still cover it; with it,
  there is a token to store and renew.
- The publish job also gets the Docker wait when `verify` needs Docker.

### package-ci

- **Tests that need Docker:** a `docker info` wait step before tests in every job that runs them
  (publish job included), plus a test setup that retries for about 60 s when `CI` is set. On the
  Ubuntu 26.04 runner image the daemon was intermittently not ready, which failed a publish job.
- **Timing tests** (benchmarks, spikes asserting sample spacing or pauses) run only locally
  (`it.skipIf(process.env.CI)`) or nightly, never in the per-push gate. Numbers measured on macOS
  failed on Linux runners.
- **Tarball names** are derived, never hard-coded: pack into an empty directory per package, or
  read `filename` from `pnpm pack --json`. Checked live: pnpm prints an object with an absolute
  path, npm an array with a bare name, and lifecycle output can share stdout, which is why the
  empty directory is the recommended option.

### github-actions

- Rules table: Docker readiness wait, timing tests out of the gate, derived tarball names.
- **Recipe: a service image published to GHCR from the release workflow**, gated like the npm
  publish. It uses buildx for `linux/amd64` + `linux/arm64`, version and dist-tag tags, OCI
  labels, `provenance: mode=max`, `sbom: true`, and `packages`/`id-token`/`attestations: write` on
  that job only. It notes that a new GHCR package may start private, so the owner makes it public
  once. The recipe was validated with actionlint and check-workflows, and the inputs were resolved
  live (build-push-action v7.4.0). The existing GHCR recipe now attaches an SBOM too.
- `check-workflows.mjs`: two new warnings. `docker-ready` flags `docker compose` / `docker run` /
  testcontainers in a job before a `docker info` wait. `tarball-name` flags hard-coded
  `<name>-*.tgz` globs.

### Tests

- `tests/check-workflows.test.mjs` (`node --test tests/`) with a new `tests/fixtures/bad/docker.yml`.
- `grade-package.mjs`, `add-releases-with-changesets`: new checks for the first-publish commands,
  the dist-tag note, the RELEASE_PAT trade-off and the scope preflight. `migrate-npm-token-release`
  gets only the RELEASE_PAT check, because its package is already on npm.
- `grade-github-actions.mjs`, `docker-ghcr-release`: the pushed image carries provenance and an SBOM
  (a literal `true` or a push-only expression).

### Benchmark (re-run of the changed cases, 3 runs each)

| Case | New skill | Old skill (re-graded) | No skill (re-graded) |
|---|---|---|---|
| npm-release: add releases | 20/20 ×3 | 16/20 ×3 | 11–12/20 |
| npm-release: migrate from NPM_TOKEN | 17/17 ×3 | 15–16/17 | 10/17 |
| github-actions: Docker to GHCR | 12/12 ×3 | 10–11/12 | 6–7/12 |

The old-skill and no-skill runs are the earlier ones, re-graded with the new checks rather than
re-run. The cost: npm-release runs took 368 s instead of 155 s and used 108k tokens instead of 81k.
The scope preflight and its fallback lookups account for part of that; a local hook that blocks
commands containing the publish command also cost the runs turns. The eval fixture's scope
(`@acme`) is really taken on npm, and all six npm-release runs flagged it at the top of their
report without renaming anything.

The runs led to three more changes:
- The preflight says what to do when the name is already committed and nobody can be asked:
  continue, don't rename, and lead the report with the conflict.
- A 429 from the registry means retry, never "free".
- The Release run triggered by merging the setup PR fails at publish for a never-published package.
  That is expected, and the skill and RELEASING.md now say so.
