---
tags: [github-actions]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

we deploy our static site (npm run build -> dist/) to an s3 bucket behind cloudfront. right now people deploy from their laptops with aws access keys which is scary. can you make a github workflow that deploys to staging on every merge to main and to production only after someone approves? we'd rather not store aws keys in github at all if thats possible

Input files: package.json, src/index.html
