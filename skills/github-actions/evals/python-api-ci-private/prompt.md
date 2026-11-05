---
tags: [github-actions]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

my fastapi api repo is private on github and we're on the free plan. i need CI that runs ruff and pytest on PRs and on main. we use uv. keep it cheap pls. add the workflow to the repo

Input files: pyproject.toml, uv.lock, .python-version, app/main.py, tests/test_main.py
