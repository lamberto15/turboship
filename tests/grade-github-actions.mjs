#!/usr/bin/env node
/**
 * Programmatic grader for the github-actions skill evals.
 *   node tests/grade-github-actions.mjs <run-dir> <case-name>
 * Reads <run-dir>/outputs/repo, writes <run-dir>/grading.json (skill-creator schema).
 * Assertions that need judgment (reading summary.md) are marked `manual` and left for a human/LLM grader.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [runDir, caseName] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(root, 'skills/github-actions/scripts/check-workflows.mjs');
const repo = join(runDir, 'outputs/repo');
const wfDir = join(repo, '.github/workflows');
const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(wfDir, f)) : [];
const wfText = workflows.map((f) => readFileSync(f, 'utf8')).join('\n');
const read = (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : '');
const summary = existsSync(join(runDir, 'outputs/summary.md')) ? readFileSync(join(runDir, 'outputs/summary.md'), 'utf8') : '';

const results = [];
const check = (text, passed, evidence) => results.push({ text, passed: Boolean(passed), evidence });

// ---- shared checks -----------------------------------------------------------------------
let lint = '';
let lintOk = workflows.length > 0;
if (workflows.length) {
  try { execFileSync('actionlint', workflows, { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { lintOk = false; lint = (e.stdout || e.message).split('\n').slice(0, 4).join(' | '); }
}
check('actionlint reports no errors in the workflow files', lintOk, workflows.length ? (lintOk ? `${workflows.length} workflow(s) clean` : lint) : 'no workflow files found');

let findings = [];
if (workflows.length) {
  let out;
  try { out = execFileSync(process.execPath, [checker, wfDir, '--latest', '--json'], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { out = e.stdout; }
  findings = JSON.parse(out).findings;
}
const of = (...rules) => findings.filter((f) => rules.includes(f.rule));
const ev = (fs) => fs.slice(0, 3).map((f) => `${f.file.split('/').pop()}:${f.line} ${f.message}`).join('; ');
const pins = of('pin-sha', 'pin-comment');
check('Every external action is pinned to a full commit SHA with a version comment', workflows.length && pins.length === 0, pins.length ? ev(pins) : 'all uses: pinned with # version comments');
const perms = of('permissions');
check('Every workflow declares top-level permissions', workflows.length && perms.length === 0, perms.length ? ev(perms) : 'permissions block present');
const timeouts = of('timeout');
check('Every job sets timeout-minutes', workflows.length && timeouts.length === 0, timeouts.length ? ev(timeouts) : 'all jobs have timeout-minutes');
const outdated = of('outdated');
// an older major is acceptable when the summary names the action and gives the reason
const unexplained = outdated.filter((f) => {
  const name = /^(\S+)/.exec(f.message)?.[1]?.split('/').pop() ?? '';
  const ver = / (v?\d+)[\d.]* is behind/.exec(f.message)?.[1]?.replace(/^v/, '') ?? '';
  return !(name && summary.includes(name) && ver && new RegExp(`\\bv?${ver}\\b`).test(summary) && /because|breaking|removed|until|stay|kept|keep/i.test(summary));
});
check('Actions are on their latest major, or an older major is kept with a stated reason', workflows.length && unexplained.length === 0,
  outdated.length === 0 ? 'all actions on latest major' : unexplained.length ? ev(unexplained) : `older major kept with a reason: ${ev(outdated)}`);
const dep = read('.github/dependabot.yml') || read('.github/dependabot.yaml');
check('Dependabot config updates the github-actions ecosystem', /package-ecosystem:\s*["']?github-actions/.test(dep), dep ? 'dependabot.yml present' : 'no dependabot.yml');

// ---- case-specific -----------------------------------------------------------------------
const supportedPython = ['3.12', '3.13', '3.14', '3.15'];
const supportedNode = ['22', '24', '26'];

if (caseName === 'python-api-ci-private') {
  const versions = [...new Set([...wfText.matchAll(/(?<![\d.])3\.(\d{1,2})(?![\d.])/g)].map((m) => `3.${m[1]}`))];
  const bad = versions.filter((v) => !supportedPython.includes(v));
  check('Python versions used are supported (not EOL) and satisfy requires-python >=3.12', bad.length === 0,
    versions.length ? `versions: ${versions.join(', ')}${bad.length ? `; not allowed: ${bad.join(', ')}` : ''}` : 'no explicit version (uses .python-version / version file)');
  check('Uses uv with dependency caching enabled', /astral-sh\/setup-uv@/.test(wfText) && /enable-cache:\s*true/.test(wfText), /setup-uv/.test(wfText) ? 'setup-uv found; enable-cache ' + (/enable-cache:\s*true/.test(wfText) ? 'true' : 'missing') : 'setup-uv not used');
  const nonLinux = /runs-on:.*(windows|macos)|os:\s*\[[^\]]*(windows|macos)/i.test(wfText);
  check('Runs only on Linux runners', workflows.length && !nonLinux, nonLinux ? 'windows/macos runner found' : 'linux only');
  check('PR runs are cancelled when superseded (concurrency with cancel-in-progress)', /concurrency:/.test(wfText) && /cancel-in-progress:/.test(wfText), /concurrency:/.test(wfText) ? 'concurrency configured' : 'no concurrency');
  check('Runs ruff and pytest', /ruff/.test(wfText) && /pytest/.test(wfText), `ruff:${/ruff/.test(wfText)} pytest:${/pytest/.test(wfText)}`);
}

if (caseName === 'docker-ghcr-release') {
  // any expression-driven push (event_name check, tag check, or an env flag derived from them) counts;
  // a literal `push: true` only counts when the build step itself is skipped on PRs
  const pushGuarded = /^\s+push:\s*\$\{\{/m.test(wfText)
    || (/if:.*pull_request/.test(wfText) && /push:\s*true/.test(wfText));
  check('The image is pushed only for non-PR events (PRs build without pushing)', pushGuarded, pushGuarded ? 'push conditioned on event' : 'no PR guard on push found');
  check('Triggers on v* version tags and on pull requests', /tags:\s*(\[\s*["']?v|\n\s*-\s*["']?v)/.test(wfText) && /pull_request/.test(wfText), 'tag + pull_request triggers checked');
  const top = workflows.map((f) => readFileSync(f, 'utf8').split(/^jobs:/m)[0]).join('\n');
  check('packages: write is not granted at the workflow top level (only in the job)', /packages:\s*write/.test(wfText) && !/packages:\s*write/.test(top), /packages:\s*write/.test(top) ? 'packages: write at top level' : 'job-level only');
  check('The Docker build uses a layer cache', /cache-from:/.test(wfText), /cache-from:/.test(wfText) ? 'cache-from set' : 'no cache-from');
  const docker = read('Dockerfile');
  const eol = /FROM\s+node:(1[0-9]|20)\b/.test(docker);
  check('The EOL node:18 base image is updated in the Dockerfile or explicitly flagged in the summary', !eol || /node[: ]?18|end[- ]of[- ]life|EOL/i.test(summary),
    eol ? `Dockerfile still ${docker.match(/FROM\s+\S+/)?.[0]}; flagged in summary: ${/node[: ]?18|end[- ]of[- ]life|EOL/i.test(summary)}` : `Dockerfile now ${docker.match(/FROM\s+\S+/)?.[0]}`);
}

if (caseName === 'modernize-legacy-node-workflow') {
  check('set-output is no longer used (GITHUB_OUTPUT instead)', workflows.length && !/::set-output/.test(wfText) && /GITHUB_OUTPUT/.test(wfText), /::set-output/.test(wfText) ? 'set-output still present' : 'uses GITHUB_OUTPUT');
  const nums = new Set();
  for (const m of wfText.matchAll(/node(?:-version)?:\s*\[([^\]]*)\]/g)) for (const n of m[1].matchAll(/\d+/g)) nums.add(n[0]);
  for (const m of wfText.matchAll(/node-version:\s*["']?(\d+)/g)) nums.add(m[1]);
  const bad = [...nums].filter((n) => !supportedNode.includes(n));
  check('Node versions are only supported LTS lines satisfying engines >=22', workflows.length && bad.length === 0, `versions: ${[...nums].join(', ') || '(from file)'}${bad.length ? `; not allowed: ${bad.join(', ')}` : ''}`);
  const jobs = ['lint', 'test'].every((j) => new RegExp(`^  ${j}:`, 'm').test(wfText)) && /refs\/tags\/v|tags:/.test(wfText) && /npm publish/.test(wfText);
  check('The lint, test and release-on-tag jobs are all still present', jobs, jobs ? 'lint, test, tag release present' : 'a job or the tag release is missing');
  const explains = /\b12\b/.test(summary) && /\b14\b/.test(summary) && /\b16\b/.test(summary) && /\b(22|24|26)\b/.test(summary);
  check('The summary explains the behavior changes, including the dropped end-of-life Node versions', explains, explains ? 'summary names the old (12/14/16) and new Node versions' : 'summary does not name the dropped and new Node versions');
  // regression: setup-node >= v7 no longer exports a placeholder NODE_AUTH_TOKEN, so an install that
  // runs after registry-url in the release job needs the token (or setup-node < v7 kept on purpose)
  const relJob = wfText.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/).find((j) => /^\s*(-\s+)?run:\s*npm publish|^\s{8,}npm publish/m.test(j)) ?? '';
  const nodeMajor = Number(/setup-node@\S+\s*#\s*v?(\d+)/.exec(relJob)?.[1] ?? /setup-node@v?(\d+)/.exec(relJob)?.[1] ?? 0);
  const usesRegistry = /registry-url:/.test(relJob);
  const tokenUses = (relJob.match(/NODE_AUTH_TOKEN/g) ?? []).length;
  const installAfter = /npm (ci|install)/.test(relJob);
  // setup-node v7 notes: without the dummy token "legacy Yarn Classic (1.x) and older Node/npm versions
  // may fail". Modern npm (Node >= 20 here) is fine; yarn 1 or an old Node in that job is not.
  const relNode = Number(/node-version:\s*["']?(\d+)/.exec(relJob)?.[1] ?? 0);
  const modernNpm = !/yarn/.test(relJob) && relNode >= 20;
  const regressionOk = !usesRegistry || !installAfter || nodeMajor < 7 || tokenUses >= 2 || /^\s{4}env:[\s\S]*NODE_AUTH_TOKEN/m.test(relJob) || modernNpm;
  check('The release job install step still works with setup-node registry-url (v7 with modern npm, token provided, or v6 kept on purpose)', relJob !== '' && regressionOk,
    `setup-node v${nodeMajor || '?'}; release job Node ${relNode || '?'}; registry-url ${usesRegistry}; NODE_AUTH_TOKEN mentions ${tokenUses}`);
  const onBlock = /^on:\s*([\s\S]*?)^(permissions|concurrency|jobs|env|defaults):/m.exec(wfText)?.[1] ?? '';
  const pushAll = /^on:\s*\[\s*push/m.test(wfText) || (/push:\s*$/m.test(onBlock) && !/branches:/.test(onBlock) && !/tags:/.test(onBlock));
  check('The workflow no longer runs twice per commit (push limited to the default branch/tags)', workflows.length && !pushAll, pushAll ? 'push on all branches + pull_request' : 'push restricted');
}

if (caseName === 'go-service-ci') {
  const versions = [...wfText.matchAll(/go-version:\s*\[?([^\]\n]+)/g)].flatMap((m) => m[1].split(',').map((v) => v.trim().replace(/['"]/g, ''))).filter(Boolean);
  const okVersion = /go-version-file:\s*["']?go\.mod/.test(wfText) || (versions.length > 0 && versions.every((v) => /^(1\.2[6-9]|1\.[3-9]\d|stable)(\.x|\.\d+)?$/.test(v)));
  check('Uses the Go version from go.mod or only supported Go releases', okVersion, `go-version-file: ${/go-version-file/.test(wfText)}; versions: ${versions.join(', ') || '-'}`);
  check('Runs go test with the race detector', /go test[^\n]*-race/.test(wfText), /go test[^\n]*-race/.test(wfText) ? 'go test -race found' : 'no -race');
  check('Runs golangci-lint through its action', /golangci\/golangci-lint-action@/.test(wfText), /golangci-lint-action/.test(wfText) ? 'golangci-lint-action used' : 'not used');
  check('Builds the module', /go build/.test(wfText), /go build/.test(wfText) ? 'go build found' : 'no go build');
  check('PR runs are cancelled when superseded (concurrency with cancel-in-progress)', /concurrency:/.test(wfText) && /cancel-in-progress:/.test(wfText), /concurrency:/.test(wfText) ? 'concurrency configured' : 'no concurrency');
}

if (caseName === 'deploy-oidc-environments') {
  const keys = /aws-access-key-id|aws-secret-access-key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/.test(wfText);
  const oidc = /aws-actions\/configure-aws-credentials@/.test(wfText) && /role-to-assume:/.test(wfText);
  check('Authenticates to AWS with OIDC (role-to-assume) and no stored access keys', oidc && !keys, `configure-aws-credentials+role-to-assume: ${oidc}; access keys referenced: ${keys}`);
  const top = workflows.map((f) => readFileSync(f, 'utf8').split(/^jobs:/m)[0]).join('\n');
  check('id-token: write is granted to deploy jobs only, not at the workflow top level', /id-token:\s*write/.test(wfText) && !/id-token:\s*write/.test(top), /id-token:\s*write/.test(top) ? 'id-token: write at top level' : /id-token:\s*write/.test(wfText) ? 'job-level only' : 'no id-token: write');
  const jobBlocks = wfText.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
  const prodJob = jobBlocks.find((j) => /environment:\s*(\n\s+name:\s*)?["']?production/.test(j)) ?? '';
  const stagingEnv = /environment:\s*(\n\s+name:\s*)?["']?staging/.test(wfText);
  check('Deploys to staging and production GitHub Environments, production only after staging', stagingEnv && prodJob !== '' && /needs:/.test(prodJob), `staging env: ${stagingEnv}; production env: ${prodJob !== ''}; production needs: ${/needs:/.test(prodJob)}`);
  check('A deploy in progress is never cancelled', !/cancel-in-progress:\s*true/.test(wfText), /cancel-in-progress:\s*true/.test(wfText) ? 'cancel-in-progress: true found' : 'no cancellation of deploys');
  const setup = /trust (policy|relationship)|identity provider|OIDC provider/i.test(summary) && /required reviewer|reviewers|approv/i.test(summary);
  check('The summary tells the user to create the AWS OIDC role/trust policy and set required reviewers on production', setup, `trust/provider mentioned: ${/trust (policy|relationship)|identity provider|OIDC provider/i.test(summary)}; reviewers mentioned: ${/required reviewer|reviewers|approv/i.test(summary)}`);
}

const passed = results.filter((r) => r.passed).length;
writeFileSync(join(runDir, 'grading.json'), JSON.stringify({
  expectations: results,
  summary: { passed, failed: results.length - passed, total: results.length, pass_rate: Number((passed / results.length).toFixed(2)) },
}, null, 2));
console.log(`${caseName} ${runDir.split('/').at(-1)}: ${passed}/${results.length}`);
for (const r of results) console.log(`  ${r.passed ? '✔' : '✖'} ${r.text} — ${r.evidence}`);
