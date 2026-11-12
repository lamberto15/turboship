---
name: npm-release
description: Set up releases of a JavaScript/TypeScript package to npm from GitHub Actions using Changesets (a "Version Packages" PR that bumps versions and writes the changelog; merging it publishes) and npm trusted publishing (OIDC, no npm token stored anywhere, provenance attached), plus a PR check that changes come with a changeset, repo hardening, and a RELEASING.md with the one-time manual steps. Versions are resolved live, never from memory. Use this skill whenever the user wants to publish or release a package to npm, automate releases or changelogs, set up changesets, replace an NPM_TOKEN secret with trusted publishing, add provenance, or asks how to cut a release - even if they just say "make it publishable". Requires CI from the package-ci skill (it sets that up first if missing). Never publishes anything itself.
---

# npm release

Releases should be boring: a contributor adds a changeset to their PR, a bot keeps a "Version
Packages" PR up to date, and merging that PR publishes to npm from CI, with no token to leak and a
provenance attestation that proves the package was built from this repo. Nothing is published from
a laptop after the very first version.

This skill builds on **package-ci** (pnpm, Biome, `verify` script, `.github/actions/setup`,
Dependabot) and the **github-actions** rules and scripts (`../github-actions/scripts/`). If any part
of package-ci's setup is missing, add it first, including `.github/dependabot.yml` with a cooldown:
pinned action SHAs in the release workflow go stale without it.

**This skill never runs `publish` itself.** Publishing is irreversible and belongs to the maintainer
(first release) and to CI (every release after). It prepares everything and hands over a checklist.

## Workflow

### 0. Preflight: can the planned names be published? (before generating any file)

A scope that turns out to be taken costs a rename of every reference afterwards (package names,
imports, docs, CI scripts). npm users and orgs share **one namespace**: a scope can be owned by a
user account with zero packages, and https://www.npmjs.com/org/<name> then silently redirects to
`/~<name>`, so "create the organisation" is where it fails. Check every planned name first:

```bash
# scope (@<scope>/...): 404 {"error":"Scope not found"} = free; 200 = owned by a user OR an org
curl -s -w '\n%{http_code}\n' https://registry.npmjs.org/-/org/<scope>/package
#   200 with {} = an account that owns the name but has no packages: still taken
#   429 = rate-limited: wait a minute and retry; never read it as free
npm whoami                       # the scope is yours if it equals your user name...
npm org ls <scope>               # ...or if you belong to that org (needs npm login)
# unscoped package names
npm view <name> name             # E404 = unpublished; npm can still reject a name too similar to an existing one
```

https://www.npmjs.com/~<scope> shows who owns it, but npmjs.com answers scripts with 403, so it is
for the user to open in a browser, not a check you can run. If the scope is taken by someone else,
**say so before writing files**, and propose fallbacks, each checked the same way: the GitHub org
name or `<org>-js` as the scope, or unscoped names. Let the user pick before you generate
anything that embeds the name. If the name is already committed in `package.json` and you can't
ask right now, don't rename on your own: continue, and put the conflict and the fallbacks at the
top of your report, since the first publish will fail until it is resolved.

Never hard-code tarball names that contain the scope or package name (`acme-ui-*.tgz`) in
generated scripts: a rename breaks them silently. Derive them from `package.json` (see package-ci,
"Tarball names").

### 1. Inspect

- `package.json`: name (scoped `@org/name` packages need `access: public`), version, scripts,
  `publishConfig`, whether the name exists on npm (`npm view <name> version` → 404 means unpublished).
- Changesets pre mode (`.changeset/pre.json`, e.g. `alpha`): releases then go to that dist-tag,
  not `latest`, which matters for the first publish (step 7).
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

**Exclude changeset files and the changelog from Biome** (add `"!.changeset/*.md"` and
`"!CHANGELOG.md"` to `files.includes` in `biome.json`). Biome 2.6+ formats Markdown and reads a
changeset's `---` front matter as a heading, rewriting `"pkg": patch` to `## "pkg": patch`: the
changeset silently stops counting, and `changeset status` no longer lists the package.
`CHANGELOG.md` is generated by `changeset version`, so it shouldn't fail lint on the version PR.
After writing a changeset, confirm it with `pnpm exec changeset status` (it must list the package).
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
- `RELEASE_PAT` is optional, and the trade-off should be stated plainly to the user. PRs opened
  with `GITHUB_TOKEN` don't trigger other workflows, so **without it the Version Packages PR shows
  "no checks reported"** and can't satisfy a required `ci-ok` check (an admin merges it through
  the bypass). That is acceptable: the PR only changes versions and changelogs, CI already ran on
  `main` for every change it contains, and the publish job runs `pnpm run verify` again before
  publishing. **With it** the PR gets normal CI, at the cost of a long-lived token to store and
  renew. A fine-grained PAT for this one repo (Contents + Pull requests: read and write) is enough.
- If `verify` needs Docker (testcontainers, compose), the publish job needs the same "wait for
  Docker" step as CI (package-ci, step 4): a fresh runner without a ready daemon fails the release.
- Optional protection: give the publish job a GitHub Environment (e.g. `npm`) with required
  reviewers; the npm trusted publisher must then name that environment too.
- `pnpm publish` refuses to run from a branch other than `main`/`master` unless told otherwise
  (`publish-branch`). If the default branch has another name, mention it in RELEASING.md for the
  manual first publish (answer the prompt, or set `publish-branch` in `.npmrc`).
- A manual publish with 2FA may show an interim `0.0.0-stage` version on npm until the publish is
  approved in the browser; the real version can take several minutes to appear (npm says "may
  take a few minutes"). Wait and re-check; don't publish again.

### 5. Changeset check on PRs (`.github/workflows/changeset.yml`)

On `pull_request`: checkout with `fetch-depth: 0`, setup, then
`pnpm exec changeset status --since=origin/${{ github.base_ref }}` (pass the base ref through `env:`,
not inline). Skip it for the Version Packages PR (`github.head_ref != format('changeset-release/{0}', github.base_ref)`),
for Dependabot by **PR author** (`github.event.pull_request.user.login != 'dependabot[bot]'`; not
`github.actor`, which is whoever triggered that particular run, e.g. a rerun or a label change), and
when the PR has a `no-changeset` label (docs, CI, tests); include `labeled`/`unlabeled` in the
`pull_request` types so adding the label re-evaluates the check. Add this job to `ci-ok`'s `needs` only if the user wants
changesets enforced.

### 6. Repository hardening (show the commands; run them only after the user agrees)

These change shared settings, so present them and ask before applying. The exact, tested commands
(history scan before going public, security features, Actions settings, rulesets JSON,
RELEASE_PAT form, verification) are in **references/repo-hardening.md**. In short:
- Before a repo goes public, scan its whole history for secrets and sensitive files, check commit
  author emails (offer a mailmap rewrite to the GitHub noreply address, done once, after all open
  branches are merged), and delete stale remote branches (Dependabot's too): they carry old history.
- Secret scanning + push protection, Dependabot alerts and security updates, private
  vulnerability reporting, a short `SECURITY.md`, auto-delete merged branches.
- Workflow token read-only by default; Actions may open PRs; fork workflows need approval. In an
  organisation, **"Allow GitHub Actions to create and approve pull requests" must be enabled at org
  level first** (https://github.com/organizations/<org>/settings/actions): while it is off, the repo
  setting returns `409` and changing the org setting needs `admin:org`. You may also be blocked
  from permission-granting clicks or scopes; then list the setting for the owner to change.
- Ruleset on the default branch: PR required, `ci-ok` required, no deletion/force-push, bypass
  only via PR (never "always"). Ruleset protecting release tags. Private repos need a paid plan
  for rulesets: say so instead of failing.
- `RELEASE_PAT` so the Version Packages PR runs CI (and can satisfy the `ci-ok` rule).
Merging into a protected default branch is the user's decision: open PRs, but let them merge.

### 7. RELEASING.md and the hand-over

Fill `assets/RELEASING.md` (placeholders in `{{...}}`; `{{dist_tag_choice}}` is the option the
user chose in item 2 below, `{{publish_order}}`/`{{package_dir}}` list the packages in dependency
order, and a single package uses `.`) into the repo root, then run the project's
formatter on it (Biome 2.6+ also lints Markdown, so an unformatted `.md` fails `verify`). It documents the day-to-day
flow and the one-time steps the maintainer must do, which you cannot:

1. npm account with 2FA.
2. **First publish, manually, in the owner's own terminal**, because npm only lets a trusted
   publisher be configured for a package that already exists (check whether that is still true in
   the npm docs at the time). **You cannot do this step**, and neither can any agent shell (Claude
   Code's `!` prefix included): with 2FA by security key or passkey, `pnpm publish` without a TTY
   fails with `ERR_PNPM_OTP_NON_INTERACTIVE`, and `npm publish --auth-type=web` without a TTY
   prints the auth URL and exits with `EOTP` instead of waiting. What works: `pnpm pack` each
   package (this resolves `workspace:*` to real versions; `npm publish` of the folder would not),
   then `npm publish <tarball> --access public --auth-type=web`. In a monorepo, publish
   dependencies first (the UI package before the package that pins it). After publishing, wait:
   the registry can take several minutes to show a new package, sometimes as `0.0.0-stage` first.
   Don't retry.
   **Dist-tags:** the first version of a new package always gets `latest`. If releases will go to
   a pre-release tag (Changesets pre mode → `alpha`), a hand-published placeholder stays on
   `latest` and `npm install <pkg>` installs it. Ask up front which the user wants, and write it
   into RELEASING.md: publish the real first version (or a placeholder with `--tag placeholder`,
   which still gets `latest` on a brand-new package, so say so), and after the first CI release
   either `npm dist-tag add <pkg>@<version> latest` or `npm deprecate <pkg>@0.0.0 "use @alpha"`.
3. On npmjs.com → package → Settings → Trusted publishing: add GitHub Actions with owner, repo,
   workflow file name `release.yml` (exact, case-sensitive) and environment (only if used).
   Then set publishing access to require 2FA and disallow tokens. npm doesn't validate these
   values when saved, and (per its docs at the time of writing) a new trusted publisher expires
   unless a publish succeeds within a couple of days: configure it right before the first CI
   release, not weeks ahead. Check the current rule in the npm docs.
4. Optional `RELEASE_PAT` secret (form fields in references/repo-hardening.md); org then repo
   settings from step 6; make the repo public before the first OIDC release if provenance is
   wanted, following the "going public" checklist in references/repo-hardening.md.

Merge the setup PR **before** the first manual publish: publishing from the old default branch
would ship the old name and setup (pnpm's clean-tree check is a useful guard here; never bypass it
with `--no-git-checks`). Say in the report that the Release run triggered by that merge will fail
at publish for a never-published package (no changesets → publish mode → no package, no trusted
publisher yet): expected, publishes nothing, re-run it once the first publish and the trusted
publisher are done.

### 8. Validate

`pnpm run format` after the last file you write (Biome formats YAML and Markdown too), then
`actionlint`, `node ../github-actions/scripts/check-workflows.mjs --latest`,
`pnpm exec changeset status`, `pnpm run verify` (last), `pnpm pack --dry-run`. Then report: the
name/scope preflight result, files changed, versions used, what happens on the next merge, the
RELEASE_PAT trade-off, and the RELEASING.md checklist items still open (marking which ones only
the owner can do: the first publish, org-level settings).
