#!/usr/bin/env node
/**
 * Generates the input repos for the package-ci and npm-release evals, with real lockfiles.
 *   node tests/make-package-fixtures.mjs
 * Needs network (npm/pnpm resolve the lockfiles). Re-run to refresh.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const write = (dir, files) => {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
};
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const src = `export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export const camelCase = (s: string): string =>
  words(s).map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');

export const snakeCase = (s: string): string => words(s).join('_');

export const kebabCase = (s: string): string => words(s).join('-');
`;
const test = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { camelCase, kebabCase, snakeCase } from '../src/index.ts';

test('converts between cases', () => {
  assert.equal(camelCase('hello_big world'), 'helloBigWorld');
  assert.equal(snakeCase('helloBigWorld'), 'hello_big_world');
  assert.equal(kebabCase('Hello Big-World'), 'hello-big-world');
});
`;
const tsconfig = {
  compilerOptions: {
    target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true,
    noUncheckedIndexedAccess: true, declaration: true, outDir: 'dist', rootDir: 'src', skipLibCheck: true,
  },
  include: ['src'],
};
const readme = (name) => `# ${name}\n\nConvert strings between camelCase, snake_case and kebab-case.\n`;
const mit = 'MIT License\n\nCopyright (c) 2026 Example\n';

// ---- package-ci: npm-ts-lib-to-pnpm ------------------------------------------------------
{
  const dir = join(root, 'package-ci/evals/npm-ts-lib-to-pnpm/files');
  rmSync(dir, { recursive: true, force: true });
  write(dir, {
    'package.json': {
      name: 'tiny-case', version: '1.0.0', description: 'Convert strings between camelCase, snake_case and kebab-case',
      type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts',
      scripts: { build: 'tsc -p tsconfig.json', test: 'node --test test/*.test.ts' },
      engines: { node: '>=22' }, license: 'MIT', devDependencies: { typescript: '^5.9.0' },
    },
    'tsconfig.json': tsconfig, 'src/index.ts': src, 'test/index.test.ts': test,
    'README.md': readme('tiny-case'), LICENSE: mit, '.gitignore': 'node_modules\ndist\n',
  });
  run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], dir);
}

// ---- package-ci: pnpm-lib-eslint-prettier ------------------------------------------------
{
  const dir = join(root, 'package-ci/evals/pnpm-lib-eslint-prettier/files');
  rmSync(dir, { recursive: true, force: true });
  write(dir, {
    'package.json': {
      name: 'case-kit', version: '0.4.2', description: 'Convert strings between cases', type: 'module',
      main: 'dist/index.js', types: 'dist/index.d.ts', packageManager: 'pnpm@9.15.0',
      scripts: {
        build: 'tsc -p tsconfig.json', test: 'node --test test/*.test.ts',
        lint: 'eslint .', 'format:check': 'prettier --check .',
      },
      engines: { node: '>=20' }, license: 'MIT',
      devDependencies: { typescript: '^5.9.0', eslint: '^9.0.0', '@eslint/js': '^9.0.0', prettier: '^3.0.0' },
    },
    'eslint.config.js': "import js from '@eslint/js';\n\nexport default [js.configs.recommended, { ignores: ['dist/'] }];\n",
    '.prettierrc': { singleQuote: true },
    'tsconfig.json': tsconfig, 'src/index.ts': src, 'test/index.test.ts': test,
    'README.md': readme('case-kit'), LICENSE: mit, '.gitignore': 'node_modules\ndist\n',
    '.github/workflows/ci.yml': `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install
      - run: pnpm test
`,
  });
  run('pnpm', ['install', '--lockfile-only', '--config.manage-package-manager-versions=false'], dir);
}

// ---- npm-release base (a package already set up by package-ci) --------------------------
const releaseBase = (dir, version) => {
  rmSync(dir, { recursive: true, force: true });
  write(dir, {
    'package.json': {
      name: '@acme/slugify-lite', version, description: 'Tiny slug and case helpers', type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      main: './dist/index.js', types: './dist/index.d.ts', files: ['dist', 'README.md', 'LICENSE'],
      packageManager: 'pnpm@12.16.1',
      repository: { type: 'git', url: 'git+https://github.com/acme/slugify-lite.git' },
      scripts: {
        build: 'tsc -p tsconfig.json', typecheck: 'tsc -p tsconfig.json --noEmit', lint: 'biome check .',
        format: 'biome check --write .', test: 'node --test test/*.test.ts',
        verify: 'pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build',
      },
      engines: { node: '>=24' }, license: 'MIT',
      devDependencies: { '@biomejs/biome': '2.6.4', typescript: '^5.9.0' },
    },
    'tsconfig.json': tsconfig, 'src/index.ts': src, 'test/index.test.ts': test,
    'README.md': readme('@acme/slugify-lite'), LICENSE: mit, '.gitignore': 'node_modules\ndist\n',
    'biome.json': { $schema: 'https://biomejs.dev/schemas/2.6.4/schema.json', files: { includes: ['**', '!dist'] } },
    '.github/actions/setup/action.yml': `name: Setup
description: pnpm + Node + dependencies, shared by all workflows
inputs:
  node-version:
    description: Node.js version
    default: "26"
  registry-url:
    description: npm registry for publishing (empty for CI)
    default: ""
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115 # v6.1.1
    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
      with:
        node-version: \${{ inputs.node-version }}
        registry-url: \${{ inputs.registry-url }}
        cache: pnpm
    - run: pnpm install --frozen-lockfile
      shell: bash
`,
    '.github/workflows/ci.yml': `name: CI

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
  verify:
    name: verify (node \${{ matrix.node }})
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        node: [24, 26]
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: ./.github/actions/setup
        with:
          node-version: \${{ matrix.node }}
      - run: pnpm run verify

  ci-ok:
    if: always()
    needs: [verify]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: |
          if [ "\${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" = "true" ]; then exit 1; fi
`,
  });
  run('pnpm', ['install'], dir);
  run('pnpm', ['exec', 'biome', 'check', '--write', '.'], dir); // start from a clean, formatted state
  run('pnpm', ['run', 'verify'], dir);                            // fixture must pass before the eval
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  rmSync(join(dir, 'dist'), { recursive: true, force: true });
};
releaseBase(join(root, 'npm-release/evals/add-releases-with-changesets/files'), '0.3.0');
releaseBase(join(root, 'npm-release/evals/migrate-npm-token-release/files'), '2.3.0');
console.log('fixtures ready (add the legacy release.yml for migrate-npm-token-release separately)');
