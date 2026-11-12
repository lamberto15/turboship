#!/usr/bin/env node
/**
 * Grader for the package-ci and npm-release evals.
 *   node tests/grade-package.mjs <run-dir> <case-name>
 * Reads <run-dir>/outputs/repo (+ outputs/summary.md), writes <run-dir>/grading.json.
 * Executes `pnpm install --frozen-lockfile && pnpm run verify` in a temporary copy of the output.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [runDir, caseName] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(root, 'skills/github-actions/scripts/check-workflows.mjs');
const repo = join(runDir, 'outputs/repo');
const read = (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : '');
const summary = existsSync(join(runDir, 'outputs/summary.md')) ? readFileSync(join(runDir, 'outputs/summary.md'), 'utf8') : '';
const listYaml = (d) => (existsSync(join(repo, d)) ? readdirSync(join(repo, d), { recursive: true }).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(repo, d, f)) : []);
const workflows = listYaml('.github/workflows');
const actions = listYaml('.github/actions');
const wfText = workflows.map((f) => readFileSync(f, 'utf8')).join('\n');
const allText = [...workflows, ...actions].map((f) => readFileSync(f, 'utf8')).join('\n');
const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return {}; } })();
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const major = (v) => Number(/(\d+)/.exec(String(v ?? ''))?.[1] ?? NaN);

const results = [];
const check = (text, passed, evidence) => results.push({ text, passed: Boolean(passed), evidence: String(evidence) });

// ---- shared workflow checks ---------------------------------------------------------------
let lintOk = workflows.length > 0;
let lintMsg = '';
if (workflows.length) {
  try { execFileSync('actionlint', workflows, { stdio: 'pipe' }); }
  catch (e) { lintOk = false; lintMsg = String(e.stdout || e.message).split('\n').slice(0, 3).join(' | '); }
}
check('actionlint reports no errors in the workflow files', lintOk, lintOk ? `${workflows.length} workflow(s) clean` : lintMsg || 'no workflows');

let findings = [];
const dirs = ['.github/workflows', '.github/actions'].map((d) => join(repo, d)).filter(existsSync);
if (dirs.length) {
  let out;
  try { out = execFileSync(process.execPath, [checker, ...dirs, '--latest', '--json'], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { out = e.stdout; }
  findings = JSON.parse(out).findings;
}
const of = (...rules) => findings.filter((f) => rules.includes(f.rule));
const ev = (fs) => fs.slice(0, 3).map((f) => `${f.file.split('/').slice(-2).join('/')}:${f.line} ${f.message}`).join('; ');
const pins = of('pin-sha', 'pin-comment');
check('Every external action (workflows and composite actions) is pinned to a commit SHA with a version comment', dirs.length && pins.length === 0, pins.length ? ev(pins) : 'all pinned');
check('Every workflow declares top-level permissions', workflows.length && of('permissions').length === 0, of('permissions').length ? ev(of('permissions')) : 'ok');
check('Every job sets timeout-minutes', workflows.length && of('timeout').length === 0, of('timeout').length ? ev(of('timeout')) : 'ok');
const outdated = of('outdated').filter((f) => {
  const name = /^(\S+)/.exec(f.message)?.[1]?.split('/').pop() ?? '';
  return !(name && summary.includes(name) && /because|breaking|kept|keep|until/i.test(summary));
});
check('Actions are on their latest major, or an older major is kept with a stated reason', dirs.length && outdated.length === 0, outdated.length ? ev(outdated) : 'ok');
const dep = read('.github/dependabot.yml') || read('.github/dependabot.yaml');

// ---- running the project ------------------------------------------------------------------
function runVerify() {
  if (!existsSync(join(repo, 'package.json'))) return [false, 'no package.json'];
  const tmp = mkdtempSync(join(tmpdir(), 'grade-pkg-'));
  try {
    cpSync(repo, tmp, { recursive: true, filter: (s) => !s.includes(`${'/'}node_modules`) });
    const opts = { cwd: tmp, encoding: 'utf8', stdio: 'pipe', timeout: 240000 };
    execFileSync('pnpm', ['install', '--frozen-lockfile'], opts);
    execFileSync('pnpm', ['run', 'verify'], opts);
    return [true, 'pnpm install --frozen-lockfile && pnpm run verify passed'];
  } catch (e) {
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    return [false, out || e.message];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const supportedNode = [22, 24, 26];

if (caseName === 'npm-ts-lib-to-pnpm' || caseName === 'pnpm-lib-eslint-prettier') {
  check('Dependabot updates github-actions and npm with a cooldown', /github-actions/.test(dep) && /package-ecosystem:\s*["']?npm/.test(dep) && /cooldown:/.test(dep),
    dep ? `github-actions ${/github-actions/.test(dep)}, npm ${/package-ecosystem:\s*["']?npm/.test(dep)}, cooldown ${/cooldown:/.test(dep)}` : 'no dependabot.yml');
  check('packageManager pins the current pnpm major (pnpm@12.x)', /^pnpm@12\.\d+\.\d+/.test(pkg.packageManager ?? ''), pkg.packageManager ?? 'missing');
  check('pnpm-lock.yaml is present and no npm/yarn lockfile remains', existsSync(join(repo, 'pnpm-lock.yaml')) && !existsSync(join(repo, 'package-lock.json')) && !existsSync(join(repo, 'yarn.lock')),
    `pnpm-lock ${existsSync(join(repo, 'pnpm-lock.yaml'))}, package-lock ${existsSync(join(repo, 'package-lock.json'))}`);
  const biomeCfg = existsSync(join(repo, 'biome.json')) || existsSync(join(repo, 'biome.jsonc'));
  const leftovers = ['eslint', '@eslint/js', 'prettier'].filter((d) => deps[d]);
  check('Biome does lint and format (config, current major devDependency, lint script) and ESLint/Prettier are gone', biomeCfg && major(deps['@biomejs/biome']) === 2 && /biome/.test(pkg.scripts?.lint ?? '') && leftovers.length === 0,
    `config ${biomeCfg}, @biomejs/biome ${deps['@biomejs/biome'] ?? '-'}, lint "${pkg.scripts?.lint ?? '-'}", leftovers ${leftovers.join(',') || 'none'}`);
  check('A verify script exists and CI runs it', Boolean(pkg.scripts?.verify) && /pnpm (run )?verify/.test(wfText), `verify "${pkg.scripts?.verify ?? '-'}"; CI runs it ${/pnpm (run )?verify/.test(wfText)}`);
  check('CI installs with --frozen-lockfile and caches pnpm', /--frozen-lockfile/.test(allText) && /cache:\s*["']?pnpm/.test(allText), `frozen ${/--frozen-lockfile/.test(allText)}, cache ${/cache:\s*["']?pnpm/.test(allText)}`);
  const nodes = new Set();
  for (const m of allText.matchAll(/node(?:-version)?:\s*\[([^\]]*)\]/g)) for (const n of m[1].matchAll(/\d+/g)) nodes.add(Number(n[0]));
  for (const m of allText.matchAll(/node-version:\s*["']?(\d+)/g)) nodes.add(Number(m[1]));
  const minEngine = major((pkg.engines?.node ?? '').replace(/[^\d.]/g, ''));
  const bad = [...nodes].filter((n) => !supportedNode.includes(n) || (Number.isFinite(minEngine) && n < minEngine));
  check('CI tests only supported Node LTS lines within engines and includes the active LTS (26)', nodes.has(26) && bad.length === 0, `nodes ${[...nodes].join(',') || '-'}; engines ${pkg.engines?.node ?? '-'}${bad.length ? `; not allowed ${bad.join(',')}` : ''}`);
  check('CI checks the published package (publint and arethetypeswrong)', /publint/.test(allText) && /attw|arethetypeswrong/.test(allText), `publint ${/publint/.test(allText)}, attw ${/attw|arethetypeswrong/.test(allText)}`);
  check('A ci-ok style aggregator job (if: always(), needs: all jobs) exists for branch protection', /if:\s*\$?\{?\{?\s*always\(\)/.test(wfText) && /needs:/.test(wfText), `always() ${/always\(\)/.test(wfText)}`);
  const exp = JSON.stringify(pkg.exports ?? '');
  check('package.json has exports with a types condition and a files whitelist', /"types"/.test(exp) && Array.isArray(pkg.files) && pkg.files.length > 0, `exports ${exp.slice(0, 80)}; files ${JSON.stringify(pkg.files ?? '-')}`);
  const ws = read('pnpm-workspace.yaml');
  check('No minimumReleaseAge exclusions were added to force brand-new versions', !/minimumReleaseAgeExclude/.test(ws), /minimumReleaseAgeExclude/.test(ws) ? 'exclusions present' : 'none');
  const [ok, msg] = runVerify();
  check('pnpm install --frozen-lockfile && pnpm run verify pass on the result', ok, msg);
}

if (caseName === 'add-releases-with-changesets' || caseName === 'migrate-npm-token-release') {
  check('Dependabot updates github-actions (with a cooldown)', /github-actions/.test(dep) && /cooldown:/.test(dep), dep ? `cooldown ${/cooldown:/.test(dep)}` : 'no dependabot.yml');
  const cs = (() => { try { return JSON.parse(read('.changeset/config.json')); } catch { return null; } })();
  check('Changesets (current major) is installed and configured with access public and baseBranch main', major(deps['@changesets/cli']) === 3 && cs?.access === 'public' && cs?.baseBranch === 'main',
    `@changesets/cli ${deps['@changesets/cli'] ?? '-'}; config ${cs ? `access ${cs.access}, baseBranch ${cs.baseBranch}` : 'missing'}`);
  const noComments = (t) => t.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  const wfTexts = workflows.map((f) => noComments(readFileSync(f, 'utf8')));
  // the release workflow: the one using changesets/action, else the one that runs a publish command
  const rel = wfTexts.find((t) => /changesets\/action/.test(t)) ?? wfTexts.find((t) => /(npm|pnpm|changeset) publish/.test(t)) ?? '';
  // inspect only the `with:` blocks of changesets steps (job names like `version:` are not inputs)
  const csSteps = [];
  const relLines = rel.split('\n');
  relLines.forEach((l, i) => {
    if (!/uses:\s*changesets\/action/.test(l)) return;
    const stepIndent = l.length - l.trimStart().length;
    const block = [];
    for (let j = i + 1; j < relLines.length; j++) {
      const ind = relLines[j].length - relLines[j].trimStart().length;
      if (relLines[j].trim() && (ind <= stepIndent - 2 || /^\s*-\s/.test(relLines[j]) && ind <= stepIndent)) break;
      block.push(relLines[j]);
    }
    csSteps.push(block.join('\n'));
  });
  const withKeys = csSteps.flatMap((b) => (b.split(/^\s+with:\s*$/m)[1] ?? '').split('\n').map((l) => /^\s+([a-z-]+):/.exec(l)?.[1]).filter(Boolean));
  const v1Inputs = withKeys.some((k) => ['version', 'publish', 'commit', 'title'].includes(k));
  // a custom token (e.g. a PAT) passed via env is silently ignored by v2; the default token via env is just redundant
  const envToken = csSteps.some((b) => /env:\s*\n\s+GITHUB_TOKEN:\s*\$\{\{\s*(?!secrets\.GITHUB_TOKEN\s*\}\}|github\.token\s*\}\})/.test(b));
  const usesChangesets = /changesets\/action/.test(rel);
  check('The release workflow uses changesets/action v2 correctly (no v1 inputs, token via github-token)', usesChangesets && !v1Inputs && !envToken,
    usesChangesets ? `with keys: ${[...new Set(withKeys)].join(', ') || '-'}; GITHUB_TOKEN via env ${envToken}` : 'no changesets workflow');
  const top = rel.split(/^jobs:/m)[0] ?? '';
  const jobBlocks = rel.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/).slice(1);
  const idJobs = jobBlocks.filter((j) => /id-token:\s*write/.test(j));
  const idOk = !/id-token:\s*write/.test(top) && idJobs.length === 1 && /publish/.test(idJobs[0] ?? '');
  check('id-token: write is granted only to the job that publishes', idOk, `top-level ${/id-token:\s*write/.test(top)}; jobs with id-token ${idJobs.length}`);
  const tokenRefs = /NPM_TOKEN|NODE_AUTH_TOKEN/.test(wfTexts.join('\n'));
  check('No npm token (NPM_TOKEN / NODE_AUTH_TOKEN) is used in any workflow', !tokenRefs, tokenRefs ? 'token reference found' : 'none');
  check('The release workflow runs the verify script before publishing', /pnpm (run )?verify/.test(rel), /pnpm (run )?verify/.test(rel) ? 'verify in release workflow' : 'no verify');
  check('A release in progress is never cancelled', rel !== '' && !/cancel-in-progress:\s*true/.test(rel), /cancel-in-progress:\s*true/.test(rel) ? 'cancel-in-progress: true' : 'ok');
  const releasing = read('RELEASING.md');
  check('RELEASING.md documents the first manual publish and the trusted publisher setup', /trusted publish/i.test(releasing) && /first (publish|release)|manual/i.test(releasing), releasing ? `trusted ${/trusted publish/i.test(releasing)}, first manual ${/first (publish|release)|manual/i.test(releasing)}` : 'missing');
  check('package.json has a release script running changeset publish and public publishConfig', /changeset publish/.test(pkg.scripts?.release ?? '') && pkg.publishConfig?.access === 'public',
    `release "${pkg.scripts?.release ?? '-'}"; publishConfig ${JSON.stringify(pkg.publishConfig ?? '-')}`);
  // lessons from the first real release (2026-11-12)
  if (caseName === 'add-releases-with-changesets') { // a never-published package: the first publish is manual
    const firstPublish = /pnpm pack/.test(releasing) && /npm publish \S+\.tgz[^\n]*--auth-type[= ]web/.test(releasing) && /agent/i.test(releasing);
    check('RELEASING.md: first publish packs with pnpm and runs npm publish <tarball> --auth-type=web in the owner\'s terminal (not an agent)', firstPublish,
      `pnpm pack ${/pnpm pack/.test(releasing)}, npm publish tarball web ${/npm publish \S+\.tgz[^\n]*--auth-type[= ]web/.test(releasing)}, agent note ${/agent/i.test(releasing)}`);
    check('RELEASING.md says what happens to the latest dist-tag after a manual first publish', /dist-tag/.test(releasing) && /latest/.test(releasing), `dist-tag ${/dist-tag/.test(releasing)}`);
  }
  const both = `${releasing}\n${summary}`;
  const patTradeoff = /RELEASE_PAT/.test(both) && /no checks|without (it|the PAT|RELEASE_PAT)[^.]*(CI|checks)/i.test(both);
  check('The RELEASE_PAT trade-off is explained (without it the version PR has no CI)', patTradeoff, `RELEASE_PAT ${/RELEASE_PAT/.test(both)}, trade-off ${patTradeoff}`);
  if (caseName === 'add-releases-with-changesets') {
    const preflight = /registry\.npmjs\.org\/-\/org|Scope not found|scope[^.\n]{0,40}(free|available|taken|owned)|(free|available|taken|owned)[^.\n]{0,40}scope/i.test(summary);
    check('The summary reports the npm scope/name availability preflight', preflight, preflight ? 'reported' : 'not mentioned');
  }
  check('Pull requests are checked for a changeset', /changeset status/.test(wfText) || /changesets\/action\/pr-status/.test(wfText) || /changeset-bot/.test(wfText), /changeset status|pr-status/.test(wfText) ? 'found' : 'none');
  const [ok, msg] = runVerify();
  check('pnpm install --frozen-lockfile && pnpm run verify pass on the result', ok, msg);
}

const passed = results.filter((r) => r.passed).length;
writeFileSync(join(runDir, 'grading.json'), JSON.stringify({ expectations: results, summary: { passed, failed: results.length - passed, total: results.length, pass_rate: Number((passed / results.length).toFixed(2)) } }, null, 2));
console.log(`${caseName} ${runDir.split('/').slice(-2).join('/')}: ${passed}/${results.length}`);
for (const r of results.filter((x) => !x.passed)) console.log(`  ✖ ${r.text} — ${r.evidence}`);
