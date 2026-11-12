# Recipes

Patterns per stack. Every `<pin>` below is a placeholder: replace it with the
`owner/repo@<sha> # vX.Y.Z` line printed by `scripts/resolve-versions.mjs`. Never fill it from memory.

## Contents
- [Skeleton (every workflow)](#skeleton)
- [Node.js / TypeScript](#nodejs)
- [Python](#python)
- [Go](#go)
- [Rust](#rust)
- [Docker image to GHCR](#docker)
- [Deploy with Environments + OIDC](#deploy)
- [Scheduled jobs](#scheduled)
- [Monorepos and path filters](#monorepo)
- [One required check: the aggregator job](#aggregator)
- [Shared setup: composite action](#composite)
- [Reusable workflows](#reusable)

<a id="skeleton"></a>
## Skeleton (every workflow)

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]          # the repo's default branch
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<pin>
        with:
          persist-credentials: false
```

<a id="nodejs"></a>
## Node.js / TypeScript

Detect the package manager from the lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
`bun.lock`/`bun.lockb` → bun, `package-lock.json` → npm. Use the project's scripts.

```yaml
    strategy:
      fail-fast: false
      matrix:
        node: [<LTS lines from --node, trimmed to engines.node>]
    steps:
      - uses: actions/checkout@<pin>
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@<pin>          # pnpm only, BEFORE setup-node; reads packageManager from package.json
      - uses: actions/setup-node@<pin>
        with:
          node-version: ${{ matrix.node }}     # or node-version-file: .nvmrc when there is no matrix
          cache: pnpm                           # npm | pnpm | yarn
      - run: pnpm install --frozen-lockfile     # npm ci | yarn install --immutable
      - run: pnpm run lint
      - run: pnpm run typecheck
      - run: pnpm test
      - run: pnpm run build
```

Bun: `oven-sh/setup-bun@<pin>` (reads `.bun-version` / `packageManager`), then `bun install --frozen-lockfile`.

<a id="python"></a>
## Python

**uv projects** (`uv.lock`), the modern default:

```yaml
    strategy:
      fail-fast: false
      matrix:
        python: [<supported lines from --runtime python, trimmed to requires-python>]
    steps:
      - uses: actions/checkout@<pin>
        with:
          persist-credentials: false
      - uses: astral-sh/setup-uv@<pin>
        with:
          enable-cache: true
          python-version: ${{ matrix.python }}
      - run: uv sync --locked --all-extras --dev
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run pytest
```

**pip / requirements.txt projects**:

```yaml
      - uses: actions/setup-python@<pin>
        with:
          python-version: ${{ matrix.python }}  # or python-version-file: .python-version
          cache: pip
      - run: python -m pip install -r requirements.txt -r requirements-dev.txt
      - run: python -m pytest
```

Services (databases) for integration tests:

```yaml
    services:
      postgres:
        image: postgres:<current major from --runtime postgresql>
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-timeout 5s --health-retries 10
```

<a id="go"></a>
## Go

```yaml
      - uses: actions/setup-go@<pin>
        with:
          go-version-file: go.mod              # caching is on by default
      - run: go vet ./...
      - run: go test -race ./...
      - uses: golangci/golangci-lint-action@<pin>
```

<a id="rust"></a>
## Rust

```yaml
      - uses: dtolnay/rust-toolchain@<pin>    # pin the SHA; choose the channel with the input below
        with:
          toolchain: stable
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@<pin>
      - run: cargo fmt --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test
```

<a id="docker"></a>
## Docker image to GHCR

Builds on PRs (no push), pushes on the default branch and on version tags, and attaches a build
provenance attestation.

```yaml
on:
  pull_request:
  push:
    branches: [main]
    tags: ["v*"]

permissions:
  contents: read

jobs:
  image:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      packages: write          # push to ghcr.io
      id-token: write          # attestation signing
      attestations: write
    steps:
      - uses: actions/checkout@<pin>
        with:
          persist-credentials: false
      - uses: docker/setup-buildx-action@<pin>
      - uses: docker/login-action@<pin>
        if: github.event_name != 'pull_request'
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@<pin>
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha
      - id: build
        uses: docker/build-push-action@<pin>
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          sbom: ${{ github.event_name != 'pull_request' }}   # SBOM attestation on pushed images
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: actions/attest-build-provenance@<pin>
        if: github.event_name != 'pull_request'
        with:
          subject-name: ghcr.io/${{ github.repository }}
          subject-digest: ${{ steps.build.outputs.digest }}
          push-to-registry: true
```

Multi-platform: add `docker/setup-qemu-action@<pin>` and `platforms: linux/amd64,linux/arm64`
(slower; only when ARM users exist). Pin base images in the Dockerfile to a supported release line
(check with `--runtime <name>`), and let Dependabot's `docker` ecosystem update them.

### A service image published by the release workflow (next to an npm publish)

When a monorepo releases npm packages with Changesets and also ships a service as an image,
publish the image from the **same release workflow**, gated the same way as the npm publish (only
when the publish mode ran), so an image never exists for a version that wasn't released. Read the
version from the service's `package.json` after `changeset version` bumped it. Only this job gets
`packages`, `id-token` and `attestations` write. Check the inputs with
`resolve-versions.mjs --inputs` (`provenance` and `sbom` are build-push-action inputs).

```yaml
  image:
    needs: [select, publish]                       # after the npm publish succeeded
    if: needs.select.outputs.mode == 'publish'     # the same gate as the npm publish
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: read
      packages: write          # push to ghcr.io
      id-token: write          # sign the provenance/SBOM attestations
      attestations: write
    steps:
      - uses: actions/checkout@<pin>
        with:
          persist-credentials: false
      - id: version            # never hard-code: read it from the service's package.json
        run: echo "version=$(node -p 'require("./services/api/package.json").version')" >> "$GITHUB_OUTPUT"
      - id: dist-tag           # pre-release versions (1.0.0-alpha.3) → their pre tag, else latest
        env:
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          case "$VERSION" in
            *-*) tag="${VERSION#*-}"; echo "tag=${tag%%.*}" >> "$GITHUB_OUTPUT" ;;
            *) echo "tag=latest" >> "$GITHUB_OUTPUT" ;;
          esac
      - uses: docker/setup-qemu-action@<pin>
      - uses: docker/setup-buildx-action@<pin>
      - uses: docker/login-action@<pin>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@<pin>
        with:
          images: ghcr.io/${{ github.repository_owner }}/api
          tags: |
            type=raw,value=${{ steps.version.outputs.version }}
            type=raw,value=${{ steps.dist-tag.outputs.tag }}
          labels: |
            org.opencontainers.image.version=${{ steps.version.outputs.version }}
      - uses: docker/build-push-action@<pin>
        with:
          context: .
          file: services/api/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}   # OCI labels: source, revision, created, licenses...
          provenance: mode=max
          sbom: true
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Notes:
- metadata-action fills the standard OCI labels (`org.opencontainers.image.source` links the
  package to the repo on GHCR); the image name must be lowercase.
- `provenance: mode=max` and `sbom: true` attach BuildKit attestations to the image in the
  registry. Add `actions/attest-build-provenance` (as in the recipe above) when consumers verify
  with `gh attestation verify`.
- A new GHCR package may start **private** (it inherits the account's default package
  visibility). The owner makes it public once: package → Package settings → Change visibility.
  Tell them; it can't be done from the workflow's token.
- Lowercase `github.repository_owner` if the org name has capitals (GHCR rejects uppercase).

<a id="deploy"></a>
## Deploy with Environments + OIDC

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false      # never cancel a deploy halfway

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment:
      name: production           # create it in Settings → Environments; add required reviewers there
      url: https://example.com
    permissions:
      contents: read
      id-token: write            # OIDC token for the cloud provider
    steps:
      - uses: actions/checkout@<pin>
        with:
          persist-credentials: false
      # AWS
      - uses: aws-actions/configure-aws-credentials@<pin>
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      # GCP:   google-github-actions/auth@<pin> with workload_identity_provider + service_account
      # Azure: azure/login@<pin> with client-id, tenant-id, subscription-id
      - run: ./scripts/deploy.sh
```

Trust policy on the cloud side should restrict the OIDC subject, e.g.
`repo:OWNER/REPO:environment:production`, so only this repo's production environment can assume the role.
Put non-secret config in `vars`, secrets in environment secrets.

Typical CD shape: CI on PRs → on merge, build once and upload the artifact → deploy to `staging` →
deploy the same artifact to `production` (required reviewers). Deploy jobs `needs:` the build job and
download its artifact instead of rebuilding.

<a id="scheduled"></a>
## Scheduled jobs

```yaml
on:
  schedule:
    - cron: "17 3 * * 1"        # UTC; pick an odd minute: the top of the hour is congested
  workflow_dispatch:             # always allow a manual run
```

GitHub disables scheduled workflows in public repos after 60 days without repository activity, and
runs can be delayed under load: don't use cron for anything that must fire at an exact minute.

<a id="monorepo"></a>
## Monorepos and path filters

Run a job only when its package changed with `on.<event>.paths` (whole workflow) or with a filter
step (per job):

```yaml
  changes:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: read
    outputs:
      api: ${{ steps.f.outputs.api }}
      web: ${{ steps.f.outputs.web }}
    steps:
      - uses: actions/checkout@<pin>
        with:
          persist-credentials: false
      - id: f
        uses: dorny/paths-filter@<pin>
        with:
          filters: |
            api: ['apps/api/**', 'packages/shared/**']
            web: ['apps/web/**', 'packages/shared/**']
  api:
    needs: changes
    if: needs.changes.outputs.api == 'true'
    # ...
```

Skipped jobs count as success for required checks, but a workflow that never starts (filtered out
by `on.paths`) leaves a required check pending forever. Prefer per-job filters plus the aggregator below.

<a id="aggregator"></a>
## One required check: the aggregator job

Instead of marking every matrix job as required (names like `test (24)` change whenever the matrix
changes), add one final job and require only it:

```yaml
  ci-ok:
    if: always()
    needs: [lint, test, build]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: All required jobs passed or were skipped
        run: |
          if [ "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" = "true" ]; then
            exit 1
          fi
```

Then the ruleset needs exactly one required status check, `ci-ok`, which survives matrix changes.

<a id="composite"></a>
## Shared setup: composite action

`.github/actions/setup/action.yml`:

```yaml
name: Setup
description: Checkout-independent toolchain setup shared by all workflows
inputs:
  node-version:
    description: Node.js version
    required: false
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@<pin>
    - uses: actions/setup-node@<pin>
      with:
        node-version: ${{ inputs.node-version }}
        node-version-file: ${{ inputs.node-version == '' && '.nvmrc' || '' }}
        cache: pnpm
    - run: pnpm install --frozen-lockfile
      shell: bash
```

Workflows call it after checkout with `- uses: ./.github/actions/setup`. Composite steps need an
explicit `shell:` on every `run:`.

<a id="reusable"></a>
## Reusable workflows

Use `on: workflow_call` when several repositories (or several workflows) should run the same jobs.
Callers pin it like an action: `uses: OWNER/REPO/.github/workflows/ci.yml@<sha> # vX`. Secrets are not
inherited unless the caller passes them (`secrets: inherit` only for same-org trusted workflows), and
the callee's `permissions` cannot exceed the caller's.
