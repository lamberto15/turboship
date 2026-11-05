#!/usr/bin/env node
/**
 * check-workflows: fast static checks for the rules actionlint does not enforce.
 *
 * Usage:
 *   node check-workflows.mjs [path ...] [--latest] [--json]
 *     path      workflow files or directories (default: .github/workflows and .github/actions)
 *     --latest  also look up each action's newest release and flag outdated majors (network)
 *
 * Checks (error = must fix, warn = review):
 *   error  `uses:` not pinned to a full 40-char commit SHA (local ./ and docker:// are exempt)
 *   warn   SHA pin without a `# vX.Y.Z` comment (Dependabot and humans need it)
 *   error  workflow has no top-level `permissions:` (default token may be read/write)
 *   warn   job has no `timeout-minutes` (default is 6 hours of billed minutes)
 *   warn   CI workflow triggered by push/pull_request without `concurrency:`
 *   error  untrusted `${{ github.event.* }}` / `github.head_ref` expanded inside `run:` (script injection)
 *   error  `pull_request_target` together with a checkout of the PR head
 *   warn   (--latest) action major version is behind its latest release
 *
 * Exit code 1 when any error is found. Line-based on purpose: no dependencies, runs anywhere Node runs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
let paths = argv.filter((a) => !a.startsWith('--'));
if (paths.length === 0) paths = ['.github/workflows', '.github/actions'].filter((p) => existsSync(p));

const files = [];
const walk = (p) => {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else if (/\.ya?ml$/.test(p)) files.push(p);
};
paths.forEach(walk);

const findings = [];
const add = (file, line, level, rule, message) => findings.push({ file, line, level, rule, message });
const usesSeen = new Map(); // owner/repo -> [{ version, file, line }, ...]

const UNTRUSTED = /\$\{\{\s*(github\.event\.(issue|pull_request|comment|review|review_comment|discussion|head_commit|commits|pages|workflow_run)[^}]*|github\.head_ref)\s*\}\}/;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const isAction = /(^|\/)action\.ya?ml$/.test(file);

  let runIndent = -1; // indentation of the `run:` key while inside a multi-line run block
  lines.forEach((raw, i) => {
    const indent = raw.length - raw.trimStart().length;
    if (runIndent >= 0) {
      if (raw.trim() === '' || indent > runIndent) {
        if (UNTRUSTED.test(raw)) add(file, i + 1, 'error', 'script-injection', 'untrusted event data expanded in a shell script; pass it through env: instead');
        return;
      }
      runIndent = -1;
    }
    const run = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(raw);
    if (run) {
      if (/^[|>][+-]?\s*$/.test(run[3])) runIndent = run[1].length + (run[2]?.length ?? 0);
      else if (UNTRUSTED.test(run[3])) add(file, i + 1, 'error', 'script-injection', 'untrusted event data expanded in a shell script; pass it through env: instead');
      return;
    }
    const m = /^\s*-?\s*uses:\s*["']?([^"'\s#]+)["']?\s*(#\s*(\S+))?/.exec(raw);
    if (m) {
      const ref = m[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) return;
      const [action, pin] = ref.split('@');
      if (!pin || !/^[0-9a-f]{40}$/.test(pin)) {
        add(file, i + 1, 'error', 'pin-sha', `${ref} is not pinned to a full commit SHA`);
      } else if (!m[3]) {
        add(file, i + 1, 'warn', 'pin-comment', `${action} is pinned but has no "# vX.Y.Z" version comment`);
      }
      const repo = action.split('/').slice(0, 2).join('/');
      const version = m[3] ?? (pin && !/^[0-9a-f]{40}$/.test(pin) ? pin : undefined);
      if (!usesSeen.has(repo)) usesSeen.set(repo, []);
      usesSeen.get(repo).push({ version, file, line: i + 1 });
    }
  });

  if (isAction) continue;

  if (!/^permissions:/m.test(text)) add(file, 1, 'error', 'permissions', 'no top-level permissions: block (set `permissions: {}` or `contents: read`, grant more per job)');

  const triggers = /^on:\s*\n((?:\s+.*\n?)*)/m.exec(text)?.[1] ?? /^on:\s*(.*)$/m.exec(text)?.[1] ?? '';
  if (/\b(push|pull_request)\b/.test(triggers) && !/^concurrency:/m.test(text) && !/^\s{4}concurrency:/m.test(text)) {
    add(file, 1, 'warn', 'concurrency', 'push/pull_request workflow without concurrency: superseded runs keep burning minutes');
  }
  if (/pull_request_target/.test(triggers) && /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/.test(text)) {
    add(file, 1, 'error', 'pr-target-checkout', 'pull_request_target checks out untrusted PR code with a privileged token');
  }

  // jobs without timeout-minutes (jobs are the 2-space-indented keys under `jobs:`)
  const jobsStart = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsStart >= 0) {
    let job = null;
    let hasTimeout = false;
    let usesReusable = false;
    const flush = () => {
      if (job && !hasTimeout && !usesReusable) add(file, job.line, 'warn', 'timeout', `job "${job.name}" has no timeout-minutes`);
    };
    for (let i = jobsStart + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l)) break;
      const jm = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
      if (jm) {
        flush();
        job = { name: jm[1], line: i + 1 };
        hasTimeout = false;
        usesReusable = false;
      } else if (/^ {4}timeout-minutes:/.test(l)) hasTimeout = true;
      else if (/^ {4}uses:/.test(l)) usesReusable = true; // reusable workflow call
    }
    flush();
  }
}

if (flags.has('--latest') && usesSeen.size > 0) {
  const resolver = join(dirname(fileURLToPath(import.meta.url)), 'resolve-versions.mjs');
  let latest = {};
  try {
    latest = JSON.parse(execFileSync(process.execPath, [resolver, '--json', '--action', ...usesSeen.keys()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).actions ?? {};
  } catch (e) {
    try { latest = JSON.parse(e.stdout).actions ?? {}; } catch { /* offline */ }
  }
  const major = (v) => Number(/^v?(\d+)/.exec(v ?? '')?.[1] ?? NaN);
  for (const [repo, uses] of usesSeen) {
    const l = latest[repo];
    if (!l || l.error) continue;
    for (const seen of uses) {
      if (!seen.version) add(seen.file, seen.line, 'warn', 'outdated', `${repo}: version unknown, latest is ${l.version}`);
      else if (major(seen.version) < major(l.version)) add(seen.file, seen.line, 'warn', 'outdated', `${repo} ${seen.version} is behind latest ${l.version}`);
    }
  }
}

const errors = findings.filter((f) => f.level === 'error').length;
if (flags.has('--json')) {
  console.log(JSON.stringify({ files, errors, warnings: findings.length - errors, findings }, null, 2));
} else {
  for (const f of findings) console.log(`${f.level.toUpperCase().padEnd(5)} ${f.file}:${f.line} [${f.rule}] ${f.message}`);
  console.log(`${files.length} file(s), ${errors} error(s), ${findings.length - errors} warning(s)`);
}
process.exit(errors > 0 ? 1 : 0);
