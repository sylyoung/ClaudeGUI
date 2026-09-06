# ClaudeGUI

A local macOS desktop app that manages many long-running **Claude Code** sessions in one window.
It replaces a screen full of terminal windows with a session sidebar, a rendered chat
(markdown, tables, diffs, tool cards), permission prompts in the GUI, clickable file and URL links,
a file explorer + viewer rooted at each session's working directory, a Git panel, and always-visible
plan-usage and context-window meters.

Everything runs locally: each session is a real `claude` CLI process driven through the
official Claude Agent SDK, using your existing `~/.claude` settings, skills, hooks, CLAUDE.md
files, MCP servers and login. Nothing goes through a remote bridge.

Current version: **1.0.1** (see `CHANGELOG.md`).

## Features

- **Session sidebar** grouped by project folder (optional), with live status dots (working / needs
  input / idle / stopped / error), unread badges, last-message previews, pinning, archiving and
  search. Each row also shows the session's **context-window percentage** and its **background-task
  and subagent counts**. `⌘1…⌘9` jumps to a session, `⌘⇧[` / `⌘⇧]` cycles, `⌘K` searches.
- **Long-running sessions**: one CLI process per session stays alive between turns, so background
  shells, monitors and subagents keep running. Turns finishing or prompts needing your input in a
  background session produce a macOS notification and a Dock badge. Sessions can be resumed
  automatically at launch (Settings → General).
- **Plan usage limits in the top-right corner**: 5-hour session, weekly (all models), weekly
  per-model (e.g. Fable) and extra-usage credits, each with a bar, percentage and the time of the
  last check. Click for reset times and a manual "Check now". The data comes from the same claude.ai
  usage endpoint the CLI's `/usage` uses, refreshed on a timer, after every finished turn, and from
  the rate-limit headers of every API response.
- **Explicit context usage per chat**: a bar in the chat toolbar shows tokens / window / percentage
  (amber above 60 %, red above 85 %); click for the `/context` breakdown by category, a full recount
  and a one-click `/compact`.
- **Rendered chat**: GitHub-flavoured markdown with tables and syntax-highlighted code, collapsible
  tool cards (Bash command + output, Edit diffs, Write previews, Read results, Grep/Glob, Agent
  subagents with nested transcripts, TodoWrite checklists), thinking blocks, per-turn cost/duration.
- **Permissions in the GUI**: Allow / Always allow / Deny (with a message) cards, AskUserQuestion
  forms, plan approval. `⌘⏎` allows the first pending request.
- **Clickable links**: URLs open in the browser; file paths (absolute, `~`, relative, `file:line`)
  open in the built-in viewer at that line. Files that are not text or images (Word, PDF,
  spreadsheets, document bundles…) open with their **default macOS app**. `⌘`-click opens a file in
  your editor (auto-detected: Sublime `subl`, Cursor, VS Code, Zed). Right-click for default app /
  "Open with…" / editor / Finder / copy path.
- **File explorer** for the session's working directory (auto-refreshing, with git status badges and
  colours), a tabbed **file viewer** with line numbers, syntax highlighting, image preview, markdown
  preview and "open with" buttons, plus a **Tasks** tab listing background tasks (with stop buttons),
  active tools and the context breakdown.
- **Git panel** (`⌘⇧G`): branch switcher, remote with ahead/behind counters, Fetch / Pull / Push,
  commit box (amend, sign-off, template, `⌘⏎`), staged / changed / untracked / ignored / conflict
  sections with per-file stage, unstage, untrack, discard, add-to-.gitignore and delete, an inline
  diff of the selected file, recent commits (revert, undo last commit, details, open on GitHub),
  stash, "Initialize repository" and "Publish to GitHub…" (through the `gh` CLI).
- **Themes**: match macOS, light or dark; accent colour follows the macOS accent or any of the system
  colours; optional translucent sidebar; fonts, density and chat width are configurable.
- **Composer**: Enter to send (configurable), Shift+Enter for newline, `/` slash-command menu
  (your skills and built-ins), image paste/drop, per-session drafts, message queueing while a
  turn is running, Stop button to interrupt.
- **Model / permission mode / effort** switchable per session at any time.
- **Import existing CLI sessions** from `~/.claude/projects` (transcript is shown immediately;
  the session resumes on your next message with `--resume` semantics). Sessions created here can
  also be resumed from the terminal: use *Copy resume command* in the session menu.
- **Settings** (`⌘,`) organised in tabs: General, Appearance, Claude, Files, Git, Usage & status,
  Advanced, About.

## Requirements

- macOS (Apple Silicon build configured), Node.js ≥ 22, `git` (Xcode command line tools or Homebrew).
- A working Claude Code login (`claude` CLI already authenticated). The app bundles the Agent SDK's
  own `claude` binary (same version as the SDK, 2.1.263); you can point it to another binary in Settings.
- Optional: the GitHub CLI (`gh`, logged in) for "Publish to GitHub…".

## Run in development

```bash
npm install
npm run dev
```

`scripts/devctl.sh start` launches the same dev build with the debug endpoint enabled and an
isolated data directory (`sandbox/userdata`), so it never interferes with an installed copy.

If `npm install` cannot download the Electron binary through your proxy, run once:

```bash
cd node_modules/electron && ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:18118 node install.js
```

## Build the app bundle

```bash
npm run build:mac      # -> dist/mac-arm64/ClaudeGUI.app
open dist/mac-arm64/ClaudeGUI.app
```

Quit any running ClaudeGUI before rebuilding into the same folder. Drag the `.app` to
`/Applications` if you like. The build is unsigned (ad-hoc), which is fine for local use.

Only the latest version is kept in `dist/`; every release is a git tag (`v1.0.0`, `v1.0.1`, …),
so an older version can be rebuilt with `git checkout v1.0.0 && npm run build:mac`.

## Environment and proxies

When you launch the app from Finder/Dock it does not inherit your terminal environment. ClaudeGUI
therefore starts your login shell once, invokes `claude` there with a stand-in executable that
prints its environment, and gives that environment (PATH, `HTTPS_PROXY`, `EDITOR`, …) to every
Claude process, to `git`/`gh`, and to the usage check. Shell functions or aliases wrapping `claude`
are honoured automatically. Settings → Claude → "Extra environment variables" adds or overrides
variables if needed; Settings shows what was captured.

## Where things live

| Item | Location |
|---|---|
| Session index + app settings | `~/Library/Application Support/ClaudeGUI/` |
| Conversation transcripts (source of truth) | `~/.claude/projects/<project>/<session-id>.jsonl` (written by Claude Code) |
| App log | `~/Library/Logs/ClaudeGUI/claudegui.log` |
| Plan-usage login token (read only) | macOS Keychain item `Claude Code-credentials` or `~/.claude/.credentials.json` |

Deleting a session in the app only removes it from the index unless you confirm deleting the
transcript as well. `CLAUDEGUI_USER_DATA=<dir>` in the environment moves the settings/session index
elsewhere (used by the dev scripts).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `⌘N` | New session |
| `⌘⇧I` | Import a CLI session |
| `⌘1` … `⌘9` | Switch to the n-th session |
| `⌘⇧[` / `⌘⇧]` | Previous / next session |
| `⌘K` | Search sessions |
| `⌘L` | Focus the composer |
| `⌘B` / `⌘⇧E` / `⌘⇧G` | Toggle sidebar / files panel / Git panel |
| `⌘.` | Interrupt the current turn |
| `⌘⏎` | Allow the pending permission request (in the chat) · commit (in the Git commit box) |
| `⌘,` | Settings |

## Development notes

- `scripts/devctl.sh` drives a dev instance through a debug HTTP endpoint
  (`CLAUDEGUI_DEBUG=1`, or Settings → Advanced): screenshots, state dumps, sending messages,
  evaluating JS in the renderer.
- Architecture and status: `docs/ARCHITECTURE.md`, `docs/STATUS.md`; release notes: `CHANGELOG.md`.
