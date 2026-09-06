# ClaudeGUI

A local macOS desktop app that manages many long-running **Claude Code** sessions in one window.
It replaces a screen full of terminal windows with a session sidebar, a rendered chat
(markdown, tables, diffs, tool cards), permission prompts in the GUI, clickable file and URL links,
and a file explorer + viewer rooted at each session's working directory.

Everything runs locally: each session is a real `claude` CLI process driven through the
official Claude Agent SDK, using your existing `~/.claude` settings, skills, hooks, CLAUDE.md
files, MCP servers and login. Nothing goes through a remote bridge.

## Features

- **Session sidebar** grouped by project folder, with live status dots (working / needs input /
  idle / stopped / error), unread badges, last-message previews, pinning, archiving and search.
  `⌘1…⌘9` jumps to a session, `⌘⇧[` / `⌘⇧]` cycles, `⌘K` searches.
- **Long-running sessions**: one CLI process per session stays alive between turns, so background
  shells, monitors and subagents keep running. Turns finishing or prompts needing your input in a
  background session produce a macOS notification and a dock badge.
- **Rendered chat**: GitHub-flavoured markdown with tables and syntax-highlighted code, collapsible
  tool cards (Bash command + output, Edit diffs, Write previews, Read results, Grep/Glob, Agent
  subagents with nested transcripts, TodoWrite checklists), thinking blocks, per-turn cost/duration.
- **Permissions in the GUI**: Allow / Always allow / Deny (with a message) cards, AskUserQuestion
  forms, plan approval. `⌘⏎` allows the first pending request.
- **Clickable links**: URLs open in the browser; file paths (absolute, `~`, relative, `file:line`)
  open in the built-in viewer at that line. `⌘`-click opens the file in your editor
  (auto-detected: Sublime `subl`, Cursor, VS Code, Zed). Right-click for Finder / default app / copy path.
- **File explorer** for the session's working directory (auto-refreshing), a tabbed **file viewer**
  with line numbers, syntax highlighting, image preview and markdown preview, plus a **Tasks** tab
  listing background tasks (with stop buttons), active tools, context size and rate-limit state.
- **Composer**: Enter to send (configurable), Shift+Enter for newline, `/` slash-command menu
  (your skills and built-ins), image paste/drop, per-session drafts, message queueing while a
  turn is running, Stop button to interrupt.
- **Model / permission mode / effort** switchable per session at any time.
- **Import existing CLI sessions** from `~/.claude/projects` (transcript is shown immediately;
  the session resumes on your next message with `--resume` semantics). Sessions created here can
  also be resumed from the terminal: use *Copy resume command* in the session menu.

## Requirements

- macOS (Apple Silicon build configured), Node.js ≥ 22.
- A working Claude Code login (`claude` CLI already authenticated). The app bundles the Agent SDK's
  own `claude` binary (same version as the SDK, 2.1.263); you can point it to another binary in Settings.

## Run in development

```bash
npm install
npm run dev
```

If `npm install` cannot download the Electron binary through your proxy, run once:

```bash
cd node_modules/electron && ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:18118 node install.js
```

## Build the app bundle

```bash
npm run build:mac      # -> dist/mac-arm64/ClaudeGUI.app
open dist/mac-arm64/ClaudeGUI.app
```

Drag the `.app` to `/Applications` if you like. The build is unsigned (ad-hoc), which is fine for
local use.

## Environment and proxies

When you launch the app from Finder/Dock it does not inherit your terminal environment. ClaudeGUI
therefore starts your login shell once, invokes `claude` there with a stand-in executable that
prints its environment, and gives that environment (PATH, `HTTPS_PROXY`, `EDITOR`, …) to every
Claude process. Shell functions or aliases wrapping `claude` are honoured automatically.
Settings → "Extra environment variables" adds or overrides variables if needed; Settings shows what
was captured.

## Where things live

| Item | Location |
|---|---|
| Session index + app settings | `~/Library/Application Support/ClaudeGUI/` |
| Conversation transcripts (source of truth) | `~/.claude/projects/<project>/<session-id>.jsonl` (written by Claude Code) |
| App log | `~/Library/Logs/ClaudeGUI/claudegui.log` |

Deleting a session in the app only removes it from the index unless you confirm deleting the
transcript as well.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `⌘N` | New session |
| `⌘⇧I` | Import a CLI session |
| `⌘1` … `⌘9` | Switch to the n-th session |
| `⌘⇧[` / `⌘⇧]` | Previous / next session |
| `⌘K` | Search sessions |
| `⌘L` | Focus the composer |
| `⌘B` / `⌘⇧E` | Toggle sidebar / files panel |
| `⌘.` | Interrupt the current turn |
| `⌘⏎` | Allow the pending permission request |
| `⌘,` | Settings |

## Development notes

- `scripts/devctl.sh` drives a dev instance through a debug HTTP endpoint
  (`CLAUDEGUI_DEBUG=1`): screenshots, state dumps, sending messages, evaluating JS in the renderer.
- Architecture and status: `docs/ARCHITECTURE.md`, `docs/STATUS.md`.
