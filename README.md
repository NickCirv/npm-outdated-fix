<div align="center">

# npm-outdated-fix

**Pick exactly which npm packages to update — with changelogs inline, before you commit.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?labelColor=0B0A09)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-blue?labelColor=0B0A09)](https://nodejs.org)

</div>

## Install

```bash
npx github:NickCirv/npm-outdated-fix
```

## Usage

```bash
# Interactive TUI — pick exactly what to update
npx github:NickCirv/npm-outdated-fix

# Auto-update all patch versions (no prompt)
npx github:NickCirv/npm-outdated-fix --patch

# Preview what would change, no writes
npx github:NickCirv/npm-outdated-fix --dry-run
```

| Flag | Description |
|------|-------------|
| `--patch` | Auto-update all packages to latest patch |
| `--minor` | Auto-update patch + minor versions |
| `--major` | Show major updates (interactive selection) |
| `--production` | Non-devDependencies only |
| `--dry-run` | Preview without making changes |
| `--format json` | Machine-readable JSON output |
| `--force` | Skip uncommitted git-changes check |

## What it does

Runs `npm outdated`, fetches weekly download counts and the first three lines of each package's changelog from GitHub, then presents a keyboard-driven TUI so you can toggle exactly which packages to update. Packages install one at a time via `npm install pkg@version` — if one fails, the rest are unaffected. Before any writes, a `git stash` checkpoint is created so you can roll back instantly.

---

<sub>Zero dependencies · Node ≥18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
