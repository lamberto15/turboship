---
tags: [github-actions]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

can you add a github actions workflow for this repo that builds the Dockerfile and pushes the image to ghcr.io whenever we push a version tag like v1.2.0? on pull requests it should only build to make sure it still works, not push

Input files: Dockerfile, package.json, server.js
