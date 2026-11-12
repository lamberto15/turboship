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
explicit agreement.

### Commit author emails

```bash
git log --all --format='%ae' | sort | uniq -c | sort -rn
gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"'   # the owner's noreply address
```

If a personal address appears, offer (don't impose) a rewrite to the noreply address with
`git filter-repo`. Do it **before going public and after every open branch is merged** (a rewrite
orphans open branches and PRs), in a fresh clone, then push once:

```bash
cat > /tmp/mailmap <<'EOF'
Name <ID+login@users.noreply.github.com> <personal@example.com>
EOF
cat > /tmp/messages <<'EOF'
personal@example.com==>ID+login@users.noreply.github.com
EOF
git filter-repo --mailmap /tmp/mailmap --replace-message /tmp/messages   # messages: DCO Signed-off-by lines
git remote add origin git@github.com:{o}/{r}.git                         # filter-repo removes it
git push --force-with-lease origin --all && git push --force-with-lease origin --tags
git config user.email ID+login@users.noreply.github.com                  # so new commits stay clean
```

The default branch ruleset blocks force-pushes: apply rulesets after the rewrite, or disable the
rule for this one push. Collaborators must re-clone.

Closed and merged PRs keep their pre-rewrite commits under `refs/pull/N/head`, which only GitHub
Support can purge. Tell the user, and give them this request to send
(https://support.github.com/contact):

> Subject: Remove cached views and PR refs after a history rewrite in {o}/{r}
>
> I rewrote the history of https://github.com/{o}/{r} to remove a personal email address from
> commit metadata. Old commits are still reachable through pull request refs (refs/pull/*/head) of
> PRs #<list>. Please run a garbage collection on the repository and remove those references and
> any cached views of the old commits. The force-push happened on <date>.

### Stale branches

Remote branches, Dependabot ones included, carry the old history and become public too:

```bash
git ls-remote --heads origin
git push origin --delete <branch>      # every branch except the default, once merged or abandoned
```

Then: `gh repo edit {o}/{r} --visibility public --accept-visibility-change-consequences`, and
right after it, sections 2 and 4 (private vulnerability reporting, secret scanning with push
protection, rulesets blocking deletion and force-push on the default branch and release tags).

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

In an organisation, enable the org-level setting **first**:
https://github.com/organizations/{org}/settings/actions → "Allow GitHub Actions to create and
approve pull requests". While it is off, the repo-level call below fails with
`409 The organization does not allow GitHub Actions to create or approve pull requests`, and
changing the org setting needs a token with `admin:org`
(`gh api -X PUT orgs/{org}/actions/permissions/workflow -F can_approve_pull_request_reviews=true`).
If you lack that scope, or a permission prompt blocks you, hand this step to the owner with the
URL instead of retrying.

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
