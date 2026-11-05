# Repository hardening (open-source package)

Apply these when a package repo goes public (or is public already). Every step changes shared
settings: show the list, get the user's agreement, then apply and **verify each one**. Replace
`{o}/{r}` with the owner/repo. Rulesets on private repos need a paid plan; on a free plan, apply them
right after the repo becomes public.

## 1. Before making a repository public: scan the whole history

Going public exposes every commit, not just the current files.

```bash
git fetch --all
git log --all --format='%an <%ae>' | sort -u            # emails that become public
git log --all -p | grep -nE '(ghp_|github_pat_|gho_|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,})'
git log --all --name-only --format= | sort -u | grep -iE '\.env|secret|credential|\.pem$|\.key$|id_rsa|\.npmrc'
```

Any hit stops the process: tell the user, rotate the secret, and rewrite history only with their
explicit agreement. Then: `gh repo edit {o}/{r} --visibility public --accept-visibility-change-consequences`.

## 2. Security features (free on public repos)

```bash
gh api -X PATCH repos/{o}/{r} -F delete_branch_on_merge=true \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
gh api -X PUT repos/{o}/{r}/vulnerability-alerts             # Dependabot alerts
gh api -X PUT repos/{o}/{r}/automated-security-fixes         # Dependabot security updates
gh api -X PUT repos/{o}/{r}/private-vulnerability-reporting
```

Add a short `SECURITY.md` (supported versions, link to
`https://github.com/{o}/{r}/security/advisories/new`, "don't open a public issue"). Format it with
the project's formatter (Biome lints Markdown) and add it through a PR once rulesets are active.

## 3. GitHub Actions settings

```bash
# read-only token by default; Actions may open PRs (fallback for the Version Packages PR if RELEASE_PAT is missing)
gh api -X PUT repos/{o}/{r}/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
# workflows from forks wait for approval
gh api -X PUT repos/{o}/{r}/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
```

## 4. Rulesets

Default branch: PR required, the single aggregator check `ci-ok` required, no deletion or
force-push; admins may bypass **only through a PR** (an "always" bypass lets untested code be pushed
and then released). `integration_id` 15368 is the GitHub Actions app.

```bash
gh api -X POST repos/{o}/{r}/rulesets --input - <<'JSON'
{
  "name": "protect default branch",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" } ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [ { "context": "ci-ok", "integration_id": 15368 } ] } }
  ]
}
JSON
```

Release tags (creation stays allowed, so the publish job can tag):

```bash
gh api -X POST repos/{o}/{r}/rulesets --input - <<'JSON'
{
  "name": "protect release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*", "refs/tags/<package-name>@*"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" } ]
}
JSON
```

Rulesets live under **Settings → Rules → Rulesets**, not under Settings → Branches (classic
branch protection): point the user there when they look for them.

## 5. RELEASE_PAT (optional, recommended)

PRs opened with the default `GITHUB_TOKEN` don't trigger workflows, so without it the Version
Packages PR gets no CI and can't satisfy the `ci-ok` rule. Guide the user through
GitHub → Settings → Developer settings → Fine-grained tokens → **Generate new token**:

| Field | Value |
|---|---|
| Token name | `<repo>-release` |
| Resource owner | the repo owner |
| Expiration | up to 1 year; set a reminder to renew it |
| Repository access | Only select repositories → this repo |
| Repository permissions | Contents: Read and write; Pull requests: Read and write (Metadata read is automatic) |

The user stores it themselves, never pasting it into the chat:
`gh secret set RELEASE_PAT -R {o}/{r}`. Confirm with `gh secret list -R {o}/{r}` (shows the name only).

## 6. Verify

```bash
gh api repos/{o}/{r} --jq '{visibility, delete_branch_on_merge, secret_scanning: .security_and_analysis.secret_scanning.status, push_protection: .security_and_analysis.secret_scanning_push_protection.status}'
gh api repos/{o}/{r}/actions/permissions/workflow
gh api repos/{o}/{r}/actions/permissions/fork-pr-contributor-approval
gh api repos/{o}/{r}/private-vulnerability-reporting
gh api repos/{o}/{r}/rulesets --jq '.[] | "\(.name): \(.enforcement)"'
```

Then open one small PR (e.g. `SECURITY.md`) to see the ruleset in action: it must show `ci-ok` as
required and become mergeable only when CI is green.
