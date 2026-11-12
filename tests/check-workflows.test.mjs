// node --test tests/
// Offline tests for skills/github-actions/scripts/check-workflows.mjs (no --latest, no network).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(root, 'skills/github-actions/scripts/check-workflows.mjs');
const run = (file) => {
  const r = spawnSync(process.execPath, [checker, join(root, 'tests/fixtures', file), '--json'], { encoding: 'utf8' });
  return { status: r.status, findings: JSON.parse(r.stdout).findings.map((f) => ({ ...f, file: f.file.split('/').pop() })) };
};
const rules = (findings) => findings.map((f) => `${f.rule}:${f.line}`).sort();

test('bad/ci.yml: pins, permissions, injection, pull_request_target, timeout', () => {
  const { status, findings } = run('bad/ci.yml');
  assert.equal(status, 1);
  for (const r of ['pin-sha', 'pin-comment', 'permissions', 'script-injection', 'pr-target-checkout', 'timeout', 'concurrency']) {
    assert.ok(findings.some((f) => f.rule === r), `expected a ${r} finding`);
  }
  // the env: TITLE line is the safe way and must not be flagged
  assert.equal(findings.filter((f) => f.rule === 'script-injection').length, 2);
});

test('bad/docker.yml: Docker used without a readiness wait, hard-coded tarball name', () => {
  const { status, findings } = run('bad/docker.yml');
  assert.equal(status, 0, 'warnings only');
  assert.deepEqual(rules(findings), ['docker-ready:14', 'tarball-name:17']);
});
