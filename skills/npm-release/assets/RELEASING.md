# Releasing

`{{package}}` is released with [Changesets](https://github.com/changesets/changesets) and the
[`release.yml`](./.github/workflows/release.yml) workflow. After the first version, nothing is
published from a developer machine.

## Day to day

For every user-visible change (feature, fix, behavior change), add a changeset to your PR:

```sh
pnpm changeset
```

Pick the bump (`patch` for fixes, `minor` for features, `major` for breaking changes; while the
version is `0.x`, breaking changes are `minor`), write a one-line summary for the changelog, and
commit the generated `.changeset/*.md`. Docs-, test- and CI-only PRs don't need one (label them
`no-changeset`).

## How a release happens

1. PRs with changesets are merged into `{{branch}}`.
2. `release.yml` opens or updates a **"chore(release): version packages"** PR that bumps
   `package.json` and writes `CHANGELOG.md`. Nothing is published yet.
3. Merging that PR runs the publish job: `pnpm run verify` (the same checks as CI), then
   `changeset publish` publishes to npm through **trusted publishing** (OIDC: no npm token exists),
   with a provenance attestation, and creates the git tag and GitHub release.

Before merging the version PR, check that `CHANGELOG.md` reads well and that CI is green.

## One-time setup (maintainer)

### First publish, by hand, in your own terminal

npm only allows a trusted publisher on a package that already exists, so the first version is
published manually. **Run this yourself in a real terminal; an AI agent can't** (not even through
an agent's shell prefix): with 2FA by security key or passkey, `pnpm publish` fails without a TTY
(`ERR_PNPM_OTP_NON_INTERACTIVE`) and `npm publish --auth-type=web` prints the login URL and exits
with `EOTP` instead of waiting.

Decide first which version `latest` should point to. The first version of a new package always
gets `latest`, even with `--tag`. {{dist_tag_choice}}

```sh
git switch {{branch}} && git pull
pnpm install --frozen-lockfile
pnpm run verify
rm -rf /tmp/first-publish && mkdir /tmp/first-publish
# repeat per package, dependencies first ({{publish_order}}):
(cd {{package_dir}} && pnpm pack --pack-destination /tmp/first-publish)   # resolves workspace:*
tar -tzf /tmp/first-publish/<tarball>.tgz      # check the file list: only what should ship
npm login
npm publish /tmp/first-publish/<tarball>.tgz --access public --auth-type=web
```

The Release run triggered by merging the setup PR fails at publish while the package doesn't
exist yet. That is expected and publishes nothing: re-run it after the steps below.

After publishing, **wait, don't retry**: npm prints "may take a few minutes", the package can take
several minutes to appear on the registry, and an interim `0.0.0-stage` version may show up first.

- [ ] npm account with **2FA** enabled.
- [ ] First publish done (commands above), dependencies before the packages that pin them.
- [ ] `latest` points where it should: after the first CI release, either
  `npm dist-tag add {{package}}@<version> latest` or
  `npm deprecate {{package}}@<first-version> "<use @alpha>"` (skip if the first publish was the
  real version).
- [ ] npmjs.com → `{{package}}` → **Settings → Trusted publishing** → GitHub Actions:
  owner `{{owner}}`, repository `{{repo}}`, workflow `release.yml` (exact, case-sensitive),
  environment: {{environment}}. Do this right before the first CI release: npm doesn't
  validate the values, and a new trusted publisher expires if no publish succeeds soon after
  (see the npm docs for the current window).
- [ ] Same page: publishing access → **require 2FA and disallow tokens**.
- [ ] Organisation first (owner, needs org admin):
  https://github.com/organizations/{{owner}}/settings/actions → tick **"Allow GitHub Actions to
  create and approve pull requests"**. While it is off, the repo setting can't be changed (the API
  answers `409 The organization does not allow GitHub Actions to create or approve pull requests`).
  Skip for a personal account.
- [ ] GitHub → repo Settings → Actions → General: workflow permissions **Read**, and tick
  **"Allow GitHub Actions to create and approve pull requests"**.
- [ ] Optional: repository secret `RELEASE_PAT` (fine-grained, this repo only, Contents and
  Pull requests: read and write). Without it the version PR shows "no checks reported" and is
  merged through the admin bypass; that is safe because CI already ran on `{{branch}}` for every
  change in it and the publish job runs `pnpm run verify` before publishing. With it the version
  PR gets normal CI, but there is a token to store and renew.
- [ ] Branch ruleset on `{{branch}}` requiring a PR and the `ci-ok` check; tag ruleset protecting
  release tags.
- [ ] The repository must be **public** for provenance. Before going public: secret scan of the
  whole history, commit author emails (rewrite to your noreply address if needed), stale remote
  branches deleted. After: private vulnerability reporting, secret scanning with push protection,
  rulesets. Commands: `references/repo-hardening.md` of the npm-release skill.
- [ ] After the first release through CI, delete any old `NPM_TOKEN` secret.

## A bad release

`npm deprecate {{package}}@<version> "<reason>"`, then release a fix through the normal flow.
Unpublishing is only possible within 72 hours and breaks anyone who installed that version.
