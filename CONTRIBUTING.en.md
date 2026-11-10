# Contributing

Issues, plugins and pull requests are welcome. Read this first to save a round trip.

[中文](CONTRIBUTING.md)

## What this project is (and isn't)

DSH-X is a **third-party launcher for DeepSeek Harness**: it handles version installation, launch entries, multiple instances, plugins, modpacks and sync.

It does **not** rewrite dsh's web UI. Anything about how the DSH page looks belongs upstream ([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)); DSH-X only starts the official page.

## Before you start

```bash
npm install          # packaging only (electron / electron-builder)
npm start            # start the manager page — the dev entry point
npm test             # full suite, ~80s
```

- **Never pipe the test output** (`npm test | head` buffers it to 0 bytes and the run is wasted). Redirect to a file if you need evidence.
- Running from source needs no build step; change a file and restart. There is no lint/format config, and we don't want one.
- To start the Electron shell from source: `npm install`, then `npm run electron`.

## Code rules

Full detail lives in [AGENTS.md](AGENTS.md) (Chinese). The three that matter:

1. **Comments explain *why***, in Chinese. Nearly every non-obvious decision in this repo carries a short note — usually a bug we already hit. Don't narrate the code line by line.
2. **Be extremely restrictive about dependencies.** Services and pages import only `node:` built-ins or relative paths. Before adding a library, check whether it can be hand-written (`zip.js`, `zipfile.js`, `sync.js` all are).
3. **Add tests when you change `server.js` / `settings.js` behaviour.** `npm test` ships three fake servers (S3 / WebDAV / proxy) so network work verifies offline.

## Commits

- Commit messages are written in **Chinese** (this is a Chinese-first project; PR descriptions can be in English).
- Use a `type: summary` prefix. Four types only, matching the release-note sections:

  | Prefix | Meaning | Release section |
  |---|---|---|
  | `feat` | new feature | New Features |
  | `fix` | bug fix | Bug Fixes |
  | `perf` | UX, performance, wording, styling | Improvements |
  | `chore` | docs, deps, build, refactor | Chores |

  Example: `fix: 修复更新运行中的实例后首页卡在「正在安装」`

- Keep unrelated changes out of a commit.

## Pull requests

- One PR, one concern; open an issue first for anything large.
- Describe the **user-visible change**, not the implementation story.
- Run `npm test` before opening the PR.
- Don't bump versions in a PR — the maintainer bumps them at release time.

## Reporting bugs

Use the [issue templates](.github/ISSUE_TEMPLATE). They ask for version, OS and log location.

Logs live at:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\DSH\manager.log` |
| macOS | `~/Library/Application Support/DSH/manager.log` |
| Linux | `$XDG_CONFIG_HOME/DSH/manager.log` (default `~/.config/DSH/`) |

**Skim before pasting** — logs can contain your username, paths and profile names.

## Security

See [SECURITY.md](SECURITY.md). Don't open a public issue.
