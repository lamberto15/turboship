---
tags: [npm-release]
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

we release by pushing a v tag and the workflow publishes with an NPM_TOKEN secret. npm keeps emailing us about token security, can you move us to the modern recommended way?

Input files: the repository, including .github/workflows/release.yml
