#!/usr/bin/env node
/**
 * release-notes: show what changed in an action between the version a workflow uses and the latest,
 * so a major-version upgrade is adopted knowingly instead of blindly.
 *
 * Usage:
 *   node release-notes.mjs <owner/repo> <from-version> [--full]
 *     <from-version>  the version currently used (v2, v4.1.0, 3, ...)
 *     --full          print complete release bodies instead of only the notable lines
 *
 * Example:
 *   node release-notes.mjs actions/setup-node v4
 *
 * Prints every stable release newer than <from-version>, newest first, with the lines that usually
 * matter for an upgrade: breaking changes, removed/renamed inputs or outputs, changed defaults,
 * dropped runtimes, new required permissions, migration notes.
 */
import { execFileSync } from 'node:child_process';

const [repoArg, from, ...rest] = process.argv.slice(2);
if (!repoArg || !from) {
  console.error('Usage: node release-notes.mjs <owner/repo> <from-version> [--full]');
  process.exit(2);
}
const full = rest.includes('--full');
const repo = repoArg.split('/').slice(0, 2).join('/');

let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
if (!token) {
  try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* anonymous */ }
}
const headers = { 'user-agent': 'turboship-release-notes', accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };

const parse = (v) => (/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v) ?? []).slice(1).map((x) => Number(x ?? 0));
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };
const base = parse(from);
if (base.length === 0) { console.error(`Cannot parse version "${from}"`); process.exit(2); }
// "v4" means "anything in the 4.x line": compare against the end of that line
const fromKey = /^v?\d+$/.test(from) ? [base[0], Infinity, Infinity] : /^v?\d+\.\d+$/.test(from) ? [base[0], base[1], Infinity] : base;

const releases = [];
for (let page = 1; page <= 5; page++) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
  if (!res.ok) { console.error(`${res.status} ${res.statusText} for ${repo}`); process.exit(1); }
  const batch = await res.json();
  releases.push(...batch);
  if (batch.length < 100) break;
}

const newer = releases
  .filter((r) => !r.draft && !r.prerelease && parse(r.tag_name).length && cmp(parse(r.tag_name), fromKey) > 0)
  .sort((a, b) => cmp(parse(b.tag_name), parse(a.tag_name)));

if (newer.length === 0) {
  console.log(`${repo}: no stable release newer than ${from}`);
  process.exit(0);
}

const NOTABLE = /break|breaking|remov|renam|deprecat|drop|no longer|default|require|migrat|replac|node ?\d{2}|runtime|permission|token|minimum|incompatib|⚠|❗/i;
console.log(`${repo}: ${newer.length} release(s) newer than ${from}. Majors crossed: ${[...new Set(newer.map((r) => parse(r.tag_name)[0]))].filter((m) => m > base[0]).map((m) => `v${m}`).join(', ') || 'none'}\n`);
for (const r of newer) {
  const isMajor = /^v?\d+\.0\.0$/.test(r.tag_name);
  const body = (r.body ?? '').replace(/\r/g, '');
  const lines = full ? body.split('\n') : body.split('\n').filter((l) => NOTABLE.test(l));
  if (!full && lines.length === 0 && !isMajor) continue;
  console.log(`=== ${r.tag_name}${isMajor ? '  (MAJOR)' : ''}  ${r.html_url}`);
  for (const l of lines.slice(0, full ? undefined : 25)) console.log(`  ${l.trim()}`);
  if (!full && isMajor && lines.length === 0) console.log('  (no notable lines matched: open the release page and read it)');
  console.log('');
}
