---
name: npm-release
description: Set up releases of a JavaScript/TypeScript package to npm from GitHub Actions using Changesets (a "Version Packages" PR that bumps versions and writes the changelog; merging it publishes) and npm trusted publishing (OIDC, no npm token stored anywhere, provenance attached), plus a PR check that changes come with a changeset, repo hardening, and a RELEASING.md with the one-time manual steps. Versions are resolved live, never from memory. Use this skill whenever the user wants to publish or release a package to npm, automate releases or changelogs, set up changesets, replace an NPM_TOKEN secret with trusted publishing, add provenance, or asks how to cut a release - even if they just say "make it publishable". Requires CI from the package-ci skill (it sets that up first if missing). Never publishes anything itself.
---

# npm release

Releases should be boring: a contributor adds a changeset to their PR, a bot keeps a "Version
Packages" PR up to date, and merging that PR publishes to npm from CI, with no token to leak and a
provenance attestation that proves the package was built from this repo. Nothing is published from
a laptop after the very first version.

This skill builds on **package-ci** (pnpm, Biome, `verify` script, `.github/actions/setup`) and the
**github-actions** rules and scripts (`../github-actions/scripts/`). If package-ci's setup is
missing, apply that skill first.

**This skill never runs `publish` itself.** Publishing is irreversible and belongs to the maintainer
(first release) and to CI (every release after). It prepares everything and hands over a checklist.

## Workflow

### 1. Inspect

- `package.json`: name (scoped `@org/name` packages need `access: public`), version, scripts,
  `publishConfig`, whether the name exists on npm (`npm view <name> version` → 404 means unpublished).
- Existing release setup: `.changeset/`, release workflows, `NPM_TOKEN` usage, semantic-release,
  release-please (replace only with the user's agreement).
- Repo: default branch, visibility (provenance requires a public repository), existing rulesets
  (`gh api repos/{owner}/{repo}/rulesets`), Actions workflow permissions.

### 2. Resolve versions

```bash
node ../github-actions/scripts/resolve-versions.mjs --min-age 7 --node \
  --npm @changesets/cli pnpm npm \
  --action changesets/action/select-mode changesets/action/version changesets/action/publish --inputs
```

Trusted publishing needs recent tooling (a minimum npm CLI and Node version, and for pnpm a version
that falls back to the OIDC token): check the current minimums on
https://docs.npmjs.com/trusted-publishers and in the pnpm release notes, and run the release job on
the active Node LTS, which comfortably exceeds them. Don't write the minimums from memory.

### 3. Changesets

```bash
pnpm add -D -E @changesets/cli
```

`changeset init` asks questions interactively in Changesets v3 and fails without a terminal, so
create `.changeset/config.json` (and the short `.changeset/README.md`) directly instead.
`.changeset/config.json`: `"access": "public"`, `"baseBranch": "<default branch>"`, `"commit": false`
(the release workflow commits), keep the default changelog generator unless the user wants GitHub
links (`@changesets/changelog-github` needs a token at version time).

`package.json`:
- `"changeset": "changeset"`, `"release": "changeset publish"`
- `"prepublishOnly": "pnpm run verify"`: a safety net for the one manual first publish.
- `"publishConfig": { "access": "public" }` for scoped packages.
- `repository.url` must point at this GitHub repo: npm checks it against the provenance statement.

### 4. Release workflow (`.github/workflows/release.yml`)

Runs on push to the default branch (+ `workflow_dispatch`). Use the split sub-actions of
`changesets/action` (select-mode → version **or** publish) rather than the all-in-one action:
that way only the publish job ever holds `id-token: write`, which is what the action's own docs
recommend for trusted publishing. Check the exact inputs with
`resolve-versions.mjs --inputs --action changesets/action/select-mode changesets/action/version changesets/action/publish`:
Changesets CLI v3 pairs with action v2, whose inputs (`script`, `commit-message`, `pr-title`,
`github-token`) differ from v1's, and a `GITHUB_TOKEN` env var does **not** configure it.

```yaml
permissions:
  contents: read
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false            # never cancel a release halfway
jobs:
  select:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      mode: ${{ steps.mode.outputs.mode }}
    steps:
      - uses: actions/checkout@<pin>
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: ./.github/actions/setup
      - id: mode
        uses: changesets/action/select-mode@<pin>   # version | publish | none

  version:                              # opens/updates the "Version Packages" PR
    needs: select
    if: needs.select.outputs.mode == 'version'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@<pin>
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: ./.github/actions/setup
      - uses: changesets/action/version@<pin>
        with:
          script: pnpm exec changeset version
          commit-message: "chore(release): version packages"
          pr-title: "chore(release): version packages"
          github-token: ${{ secrets.RELEASE_PAT || secrets.GITHUB_TOKEN }}

  publish:                              # runs after the Version Packages PR is merged
    needs: select
    if: needs.select.outputs.mode == 'publish'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: write                   # git tags + GitHub releases
      id-token: write                   # npm trusted publishing (OIDC) + provenance
    steps:
      - uses: actions/checkout@<pin>
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: ./.github/actions/setup
        with:
          registry-url: https://registry.npmjs.org
      - run: pnpm run verify           # the same checks as CI: a release can't skip any
      - uses: changesets/action/publish@<pin>
        with:
          script: pnpm run release
```

Notes that matter:
- Do **not** set `NODE_AUTH_TOKEN` or `NPM_TOKEN`: with trusted publishing the npm client exchanges
  the job's OIDC token itself, and provenance is attached automatically for public repos. Remove
  any old `NPM_TOKEN` usage and tell the user to delete the secret after the first OIDC release.
- The sub-actions push through the GitHub API by default, so checkouts keep
  `persist-credentials: false`.
- The publish job builds from a clean install; never restore build outputs or PR-created caches
  into it (see the github-actions security reference).
- `RELEASE_PAT` is optional: PRs opened with `GITHUB_TOKEN` don't trigger other workflows, so
  without it the Version Packages PR gets no CI. A fine-grained PAT for this one repo
  (Contents + Pull requests: read and write) fixes that.
- Optional protection: give the publish job a GitHub Environment (e.g. `npm`) with required
  reviewers; the npm trusted publisher must then name that environment too.
- `select-mode` uploads a small artifact (the publish plan). In a private repo whose account has
  hit its artifact storage quota, the whole release fails at that step; see the github-actions
  skill ("Private repositories") for the fix.
- `pnpm publish` refuses to run from a branch other than `main`/`master` unless told otherwise
  (`publish-branch`). If the default branch has another name, mention it in RELEASING.md for the
  manual first publish (answer the prompt, or set `publish-branch` in `.npmrc`).
- A manual publish with 2FA may show an interim `0.0.0-stage` version on npm until the publish is
  approved in the browser; the real version appears a few minutes after approval.

### 5. Changeset check on PRs (`.github/workflows/changeset.yml`)

On `pull_request`: checkout with `fetch-depth: 0`, setup, then
`pnpm exec changeset status --since=origin/${{ github.base_ref }}`. Skip it for the Version Packages
PR (`github.head_ref != 'changeset-release/<base>'`), for Dependabot, and when the PR has a
`no-changeset` label (docs, CI, tests). Add this job to `ci-ok`'s `needs` only if the user wants
changesets enforced.

### 6. Repository hardening (show the commands; run them only after the user agrees)

These change shared settings, so present them and ask before applying with `gh api`:
- Workflow permissions read-only by default, and allow Actions to create PRs (for the Version
  Packages PR): `gh api -X PUT repos/{o}/{r}/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`
- Ruleset on the default branch: require a PR and the status check `ci-ok`; bypass only via PR,
  not "always" (an "always" bypass lets an admin push untested code that then gets released).
  Private repos need a paid plan for rulesets: say so instead of failing.
- Ruleset protecting tags `v*` and `<name>@*` from deletion and force-push.
- "Automatically delete head branches".

### 7. RELEASING.md and the hand-over

Fill `assets/RELEASING.md` (placeholders in `{{...}}`) into the repo root, then run the project's
formatter on it (Biome 2.6+ also lints Markdown, so an unformatted `.md` fails `verify`). It documents the day-to-day
flow and the one-time steps the maintainer must do, which you cannot:

1. npm account with 2FA.
2. **First publish, manually**, because npm only lets a trusted publisher be configured for a
   package that already exists (check whether that is still true in the npm docs at the time):
   `pnpm run verify && pnpm pack --dry-run`, review the file list, then `npm login` and
   `pnpm publish --access public` from a clean checkout of the default branch.
3. On npmjs.com → package → Settings → Trusted publishing: add GitHub Actions with owner, repo,
   workflow file name `release.yml` (exact, case-sensitive) and environment (only if used).
   Then set publishing access to require 2FA and disallow tokens. npm doesn't validate these
   values when saved, and (per its docs at the time of writing) a new trusted publisher expires
   unless a publish succeeds within a couple of days: configure it right before the first CI
   release, not weeks ahead. Check the current rule in the npm docs.
4. Optional `RELEASE_PAT` secret; repo settings from step 6; make the repo public before the
   first OIDC release if provenance is wanted.

### 8. Validate

`actionlint`, `node ../github-actions/scripts/check-workflows.mjs --latest`,
`pnpm exec changeset status`, `pnpm run verify`, `pnpm pack --dry-run`. Then report: files changed,
versions used, what happens on the next merge, and the RELEASING.md checklist items still open.
