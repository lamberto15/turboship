---
tags: [package-ci]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

our CI is just pnpm test on one node version. can you add proper checks (lint, typecheck, build, a few node versions) and make sure the package we publish actually works for people, types and exports and all that

Input files: package.json, pnpm-lock.yaml, eslint.config.js, .prettierrc, tsconfig.json, src/index.ts, test/index.test.ts, .github/workflows/ci.yml
