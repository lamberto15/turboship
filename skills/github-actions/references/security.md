# Workflow security

Read this when a workflow deploys, publishes, uses secrets, comments on PRs, or uses
`pull_request_target` / `workflow_run`.

## Token permissions

- Declare `permissions` at the top (`{}` or `contents: read`) and grant per job: `packages: write`
  to push images, `id-token: write` for OIDC, `pull-requests: write` to comment, `contents: write`
  only for jobs that push commits/tags or create releases.
- Recommend the repository/org setting "Workflow permissions: Read repository contents" so a
  workflow without a `permissions` block can't write. Workflows that need more declare it.
- Releases that open PRs (changesets, release-please) also need "Allow GitHub Actions to create and
  approve pull requests". PRs opened with `GITHUB_TOKEN` don't trigger other workflows; use a
  GitHub App token or a fine-grained PAT scoped to the one repo if those PRs need CI.

## Untrusted input

Expressions are expanded into the script text before the shell runs. These values are attacker
controlled on public repos: `github.event.issue.title/body`, `github.event.pull_request.title/body`,
`github.event.pull_request.head.ref`, `github.head_ref`, comment bodies, commit messages, review
bodies, labels created by users. Pass them through `env:` and quote the shell variable:

```yaml
      - env:
          TITLE: ${{ github.event.pull_request.title }}
        run: echo "PR title: $TITLE"
```

## pull_request_target and workflow_run

- `pull_request_target` runs with the base repo's secrets and a write token. Never check out and
  run the PR's code in it (`ref: ${{ github.event.pull_request.head.sha }}` + `npm install`/build/test).
  Use plain `pull_request` for building/testing PRs; use `pull_request_target` only for labeling or
  commenting with no PR code executed.
- `workflow_run` triggered by a PR workflow is also privileged: treat downloaded artifacts as
  untrusted data (don't execute them, validate before use).
- Fork PRs under `pull_request` get a read-only token and no secrets. That is the point: don't
  "fix" it by moving to `pull_request_target`.

## Secrets

- Use Environments for deploy secrets, with required reviewers and deployment-branch rules for
  production. Repository secrets are available to every workflow on every branch.
- Prefer OIDC to long-lived cloud keys and npm/PyPI trusted publishing to tokens.
- Never `echo` secrets; masking is best-effort. Don't pass secrets to third-party actions that don't
  need them.
- Secrets aren't available in `if:` conditions directly; map to `env` first if needed.

## Supply chain

- Pin all actions by commit SHA (also first-party `actions/*`), keep Dependabot on for
  `github-actions`, review what new actions do before adding them, and prefer actions from verified
  publishers or well-known maintainers.
- Caches are scoped by branch, but a PR can write caches that its own later runs read. In release and
  deploy workflows, prefer rebuilding from a clean install over restoring PR-created caches, and
  never cache build outputs that end up published.
- Self-hosted runners on public repos can be abused by fork PRs: keep public repos on GitHub-hosted
  runners.
- For a deeper audit, suggest running `zizmor` (static analyzer for GitHub Actions security) in
  addition to actionlint.
