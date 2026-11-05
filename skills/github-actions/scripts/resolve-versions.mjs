#!/usr/bin/env node
/**
 * resolve-versions: look up CURRENT versions from authoritative sources, so workflows are never
 * written from memory or from an old tutorial.
 *
 * Usage:
 *   node resolve-versions.mjs [--node] [--runtime <name>...] [--npm <pkg>...] [--action <owner/repo>...] [--inputs] [--json]
 *     --inputs  also list each action's inputs (name, default, deprecated) from its action.yml at the
 *               resolved commit, so `with:` keys come from the real action, not from memory
 *
 * Examples:
 *   node resolve-versions.mjs --node --action actions/checkout actions/setup-node
 *   node resolve-versions.mjs --runtime python --action actions/setup-python astral-sh/setup-uv
 *   node resolve-versions.mjs --npm pnpm typescript @biomejs/biome --json
 *
 * Sources:
 *   Node.js   https://github.com/nodejs/Release (schedule) + https://nodejs.org/dist/index.json (latest patch)
 *   runtimes  https://endoflife.date (python, go, ruby, php, java/temurin, dotnet, deno, bun, ...)
 *   npm       https://registry.npmjs.org (dist-tags.latest, i.e. latest stable)
 *   actions   GitHub API: latest non-prerelease release, resolved to its commit SHA for pinning
 *
 * GitHub API calls use GITHUB_TOKEN / GH_TOKEN, or `gh auth token` if the GitHub CLI is logged in,
 * to avoid the 60 requests/hour anonymous limit. Requires Node.js >= 18 (global fetch).
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const json = args.includes('--json');
const withInputs = args.includes('--inputs');
const groups = { node: false, runtime: [], npm: [], action: [] };
let current = null;
for (const a of args) {
  if (a === '--json' || a === '--inputs') continue;
  if (a === '--node') { groups.node = true; current = null; continue; }
  if (a.startsWith('--')) {
    current = a.slice(2);
    if (!(current in groups) || current === 'node') { console.error(`Unknown option ${a}`); process.exit(2); }
    continue;
  }
  if (!current) { console.error(`Value "${a}" needs --runtime, --npm or --action before it`); process.exit(2); }
  groups[current].push(a);
}
if (!groups.node && !groups.runtime.length && !groups.npm.length && !groups.action.length) {
  console.error('Nothing to resolve. Try: --node --action actions/checkout');
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const UA = { 'user-agent': 'turboship-resolve-versions' };

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

let ghToken;
function githubHeaders() {
  if (ghToken === undefined) {
    ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!ghToken) {
      try { ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { ghToken = ''; }
    }
  }
  return { accept: 'application/vnd.github+json', ...(ghToken ? { authorization: `Bearer ${ghToken}` } : {}) };
}

const semverKey = (v) => v.replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? x.padStart(8, '0') : x)).join('.');

// ---- Node.js -------------------------------------------------------------------------------
async function resolveNode() {
  const [schedule, dist] = await Promise.all([
    getJson('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'),
    getJson('https://nodejs.org/dist/index.json'),
  ]);
  const lines = [];
  for (const [key, s] of Object.entries(schedule)) {
    const major = Number(key.replace('v', ''));
    if (!Number.isInteger(major) || major < 1) continue;
    if (s.start > today || s.end < today) continue; // released and not end-of-life
    const phase = s.lts && s.lts <= today ? (s.maintenance && s.maintenance <= today ? 'maintenance-lts' : 'active-lts') : 'current';
    const latest = dist.find((d) => d.version.startsWith(`v${major}.`))?.version.slice(1) ?? null;
    lines.push({ major, phase, latest, eol: s.end });
  }
  lines.sort((a, b) => a.major - b.major);
  const lts = lines.filter((l) => l.phase !== 'current');
  return {
    supportedLines: lines,
    activeLts: lts.filter((l) => l.phase === 'active-lts').at(-1)?.major ?? lts.at(-1)?.major ?? null,
    ltsMatrix: lts.map((l) => l.major),
    note: 'Use activeLts for release/deploy jobs; test ltsMatrix (trimmed to the project\'s engines minimum) in CI. "current" lines are not LTS.',
  };
}

// ---- other runtimes via endoflife.date -----------------------------------------------------
async function resolveRuntime(name) {
  const cycles = await getJson(`https://endoflife.date/api/${encodeURIComponent(name)}.json`);
  const supported = cycles
    .filter((c) => c.eol === false || (typeof c.eol === 'string' && c.eol > today))
    .filter((c) => !c.releaseDate || c.releaseDate <= today)
    .map((c) => ({ cycle: String(c.cycle), latest: c.latest ?? null, eol: c.eol, lts: c.lts ?? undefined }));
  return { supported, newest: supported[0]?.cycle ?? null, oldestSupported: supported.at(-1)?.cycle ?? null };
}

// ---- npm packages --------------------------------------------------------------------------
async function resolveNpm(pkg) {
  const meta = await getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`, { accept: 'application/vnd.npm.install-v1+json' });
  const latest = meta['dist-tags']?.latest;
  return { latest, engines: undefined, ...(latest ? {} : { error: 'no latest dist-tag' }) };
}

// ---- GitHub Actions ------------------------------------------------------------------------
async function resolveAction(spec) {
  const repo = spec.split('/').slice(0, 2).join('/'); // owner/repo (sub-path actions share the repo)
  const h = githubHeaders();
  // Newest stable release whose tag is a plain version (some repos also publish unrelated
  // releases, e.g. github/codeql-action's "codeql-bundle-*"); fall back to version tags.
  const isVersion = (n) => /^v?\d+(\.\d+)*$/.test(n);
  const newest = (names) => names.filter(isVersion).sort((a, b) => (semverKey(a) < semverKey(b) ? 1 : -1))[0];
  const releases = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=50`, h).catch(() => []);
  let tag = newest(releases.filter((r) => !r.prerelease && !r.draft).map((r) => r.tag_name));
  if (!tag) {
    const tags = await getJson(`https://api.github.com/repos/${repo}/tags?per_page=100`, h);
    tag = newest(tags.map((t) => t.name));
  }
  if (!tag) throw new Error(`no release or version tag found for ${repo}`);
  const commit = await getJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`, h);
  const result = { version: tag, sha: commit.sha, uses: `${spec}@${commit.sha} # ${tag}`, releaseNotes: `https://github.com/${repo}/releases/tag/${tag}` };
  if (withInputs) result.inputs = await actionInputs(spec, commit.sha);
  return result;
}

/** Inputs declared in action.yml at a commit (minimal line parser for the `inputs:` mapping). */
async function actionInputs(spec, sha) {
  const [owner, name, ...sub] = spec.split('/');
  const dir = sub.length ? `${sub.join('/')}/` : '';
  let text = null;
  for (const file of ['action.yml', 'action.yaml']) {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/${sha}/${dir}${file}`, { headers: UA });
    if (res.ok) { text = await res.text(); break; }
  }
  if (text === null) return { error: 'action.yml not found' };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^inputs:\s*$/.test(l));
  if (start < 0) return [];
  const inputs = [];
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (key) { cur = { name: key[1] }; inputs.push(cur); continue; }
    if (!cur) continue;
    const dflt = /^ {4}default:\s*(.*)$/.exec(l);
    if (dflt) cur.default = dflt[1].replace(/^['"]|['"]$/g, '');
    if (/^ {4}required:\s*true/.test(l)) cur.required = true;
    if (/^ {4}deprecationMessage:/.test(l)) cur.deprecated = true;
  }
  return inputs;
}

// ---- run -----------------------------------------------------------------------------------
const out = { resolvedAt: new Date().toISOString() };
const tasks = [];
const record = (section, key, p) =>
  tasks.push(p.then((v) => { (out[section] ??= {})[key] = v; }, (e) => { (out[section] ??= {})[key] = { error: e.message }; }));

if (groups.node) tasks.push(resolveNode().then((v) => { out.node = v; }, (e) => { out.node = { error: e.message }; }));
for (const r of groups.runtime) record('runtimes', r, resolveRuntime(r));
for (const p of groups.npm) record('npm', p, resolveNpm(p));
for (const a of groups.action) record('actions', a, resolveAction(a));
await Promise.all(tasks);

if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`Resolved ${out.resolvedAt}`);
  if (out.node) {
    if (out.node.error) console.log(`node: ERROR ${out.node.error}`);
    else {
      console.log(`node: active LTS ${out.node.activeLts}; LTS matrix [${out.node.ltsMatrix.join(', ')}]`);
      for (const l of out.node.supportedLines) console.log(`  ${l.major}  ${l.phase.padEnd(15)} latest ${l.latest}  eol ${l.eol}`);
    }
  }
  for (const [name, r] of Object.entries(out.runtimes ?? {})) {
    console.log(r.error ? `${name}: ERROR ${r.error}` : `${name}: supported ${r.supported.map((c) => c.cycle).join(', ')} (newest ${r.newest})`);
  }
  for (const [name, r] of Object.entries(out.npm ?? {})) console.log(r.error ? `npm ${name}: ERROR ${r.error}` : `npm ${name}: ${r.latest}`);
  for (const [name, r] of Object.entries(out.actions ?? {})) {
    if (r.error) { console.log(`action ${name}: ERROR ${r.error}`); continue; }
    console.log(`uses: ${r.uses}`);
    if (Array.isArray(r.inputs)) {
      const fmt = (i) => `${i.name}${i.required ? '*' : ''}${i.default !== undefined && i.default !== '' ? `=${i.default}` : ''}${i.deprecated ? ' (deprecated)' : ''}`;
      console.log(`  inputs: ${r.inputs.map(fmt).join(', ') || '(none)'}`);
    } else if (r.inputs?.error) console.log(`  inputs: ${r.inputs.error}`);
  }
}
const failed = JSON.stringify(out).includes('"error"');
process.exit(failed ? 1 : 0);
