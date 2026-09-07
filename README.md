# ClaudeGUI

A local macOS desktop app that manages many long-running **Claude Code** sessions in one window.
It replaces a screen full of terminal windows with a session sidebar (your own coloured groups, or a
pinned / recent list, ordered by your last prompt), a one-line statistics bar (how many sessions
are working, waiting for you, idle…), a rendered chat (markdown, tables, diffs, tool cards),
permission prompts in the GUI, clickable file and URL links, a file explorer + viewer rooted at each
session's working directory, a Git panel, and always-visible plan-usage and context-window meters.

Everything runs locally: each session is a real `claude` CLI process driven through the official
Claude Agent SDK, using your existing `~/.claude` settings, skills, hooks, CLAUDE.md files, MCP
servers and login. Nothing goes through a remote bridge. The Claude processes live in a small
background **session host** process, so the window can restart — for example to apply an update —
without stopping sessions, background shells, monitors or subagents.

Current version: **1.0.10** (see `CHANGELOG.md`). The app updates itself from the git tags of this
repository (ClaudeGUI → Check for Updates…).

## Features

- **Session sidebar** with two views (⌘⇧V): **Groups** — your own categories (Papers, Utilities,
  Tasks…), each with a colour (automatic, changeable) shown as a rail along the group — and
  **Recent** — a Pinned section followed by every other session. Sessions are ordered by the time of
  **your last prompt**; Claude answering never moves them (a manual drag & drop order is optional).
  Each row shows the chat name, the model under it (Fable 5.1, Opus 5…), the folder only while that
  chat's folder panel is shown, the state or last message, unread count, **background-shell /
  monitor count** (blue), **subagent count** (purple) and **context-window percentage**.
  Drag & drop (with a ghost that says what will happen) moves sessions between groups, pins them,
  reorders groups. ⌘-click / ⇧-click select several sessions for bulk start / stop / pin / archive /
  move. `⌘1…⌘9` jumps to a session, `⌘⇧[` / `⌘⇧]` cycles, `⌘K` searches, `⌘⇧A` selects all.
- **Statistics bar** above the chat: how many sessions are working, need input, idle with tasks
  running, idle, not running, in error; running shells / subagents; unread turns; a **Start all**
  button. Click a number to jump to the next session in that state. `⌘⇧S` toggles it.
- **Session states**, consistently coloured everywhere: working (blue, pulsing), needs input (amber,
  pulsing), idle with background tasks still running (teal), idle (green), not running (grey
  outline), error (red).
- **Long-running sessions**: one CLI process per session stays alive between turns inside the
  session host, so background shells, monitors and subagents keep running — even across an app
  restart or update. Turns finishing or prompts needing your input in a background session produce a
  macOS notification and a Dock badge. Sessions can be resumed automatically at launch.
- **One-click updates** (Settings → About or the ClaudeGUI menu): the app fetches the tags of this
  repository, builds the newest version in the background while you keep working, then restarts into
  it. Settings, sessions, window layout, open files and running sessions are all kept.
- **Plan usage limits in the top-right corner**: 5-hour session, weekly (all models), weekly
  per-model (e.g. Fable) and extra-usage credits, each with a bar, percentage and the time of the
  last check. Click for reset times and a manual "Check now". The data comes from the same claude.ai
  usage endpoint the CLI's `/usage` uses, refreshed on a timer, after every finished turn, and from
  the rate-limit headers of every API response.
- **Chat header with visible actions**: open the folder in Terminal, reveal in Finder, open in the
  editor, open the GitHub remote, show / hide the folder panel (remembered per chat), pin, start /
  stop the process. Model, permission mode and effort sit on one line (short label when closed, full
  text in the open list). A status row shows the group, folder, branch, remote, folder size, the time
  of your last prompt, the last activity and the **context bar** (tokens / window / percentage, amber
  above 60 %, red above 85 %; click for the `/context` breakdown, a recount and one-click `/compact`).
- **Rendered chat**: GitHub-flavoured markdown with tables and syntax-highlighted code, collapsible
  tool cards (Bash command + output, Edit diffs, Write previews, Read results, Grep/Glob, Agent
  subagents with nested transcripts, TodoWrite checklists), thinking blocks, per-turn duration.
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
- **Composer**: Enter to send (configurable), Shift+Enter for newline, `/` slash-command menu
  (your skills and built-ins, best matches first), image paste/drop, per-session drafts, message
  queueing while a turn is running, a clear (×) button, and a Stop button (`⌘.`) that puts the
  interrupted prompt back into the box.
- **Model / permission mode / effort** switchable per session at any time; the option lists show the
  full names (model id, "acceptEdits — accept file edits automatically", "xhigh — extra high"…).
- **Renamed or deleted folders**: a session whose working directory disappeared shows a clear banner;
  "Change working directory…" points it at the new location and moves the transcript along, so the
  history is kept.
- **Hover explanations** on nearly every control (can be switched off in Settings → Appearance).
- **macOS permissions** (Settings → Permissions): the state of every privacy grant relevant to
  Claude's tools, "Request" buttons for the prompts the app can trigger itself, and shortcuts to the
  right System Settings pane for the ones that must be switched on by hand.
- **Themes**: match macOS, light or dark; accent colour follows the macOS accent or any of the system
  colours; optional translucent sidebar; fonts, density and chat width are configurable.
- **Import existing CLI sessions** from `~/.claude/projects` (transcript is shown immediately;
  the session resumes on your next message with `--resume` semantics). Sessions created here can
  also be resumed from the terminal: use *Copy resume command* in the session menu.
- **Settings** (`⌘,`) organised in tabs: General, Appearance, Claude, Files, Git, Usage & status,
  Permissions, Advanced, About (updates and session host).

## Requirements

- macOS (Apple Silicon build configured), Node.js ≥ 22, npm, `git` (Xcode command line tools or
  Homebrew). The in-app updater runs `git`, `npm ci` and the build with your login-shell PATH.
- A working Claude Code login (`claude` CLI already authenticated). The app bundles the Agent SDK's
  own `claude` binary (same version as the SDK, 2.1.263); you can point it to another binary in Settings.
- Optional: the GitHub CLI (`gh`, logged in) for "Publish to GitHub…".
- Optional: an **Apple Development** code-signing certificate in your keychain (created by Xcode).
  When present, builds are signed with it, which keeps macOS privacy grants (Full Disk Access,
  Accessibility…) across updates. Without it the app is built unsigned and runs fine locally, but
  macOS may forget grants when the binary changes.

## Run in development

```bash
npm install
npm run dev
```

`scripts/devctl.sh start` launches the same dev build with the debug endpoint enabled and an
isolated data directory (`sandbox/userdata`), so it never interferes with an installed copy.
`scripts/devctl.sh stop-gui` stops only the window (the dev session host keeps its sessions),
`scripts/devctl.sh stop` stops both.

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
`/Applications` if you like. electron-builder signs the bundle with an "Apple Development"
identity when it finds one in the keychain and otherwise skips signing.

Only the latest version is kept in `dist/`; every release is a git tag (`v1.0.0`, `v1.0.1`, …),
so an older version can be rebuilt with `git checkout v1.0.0 && npm run build:mac`.

## Updating

ClaudeGUI → **Check for Updates…** (or Settings → About) compares the running version with the
newest tag of the repository configured in Settings → About (this repository by default). Updating
checks that tag out into `~/Library/Caches/ClaudeGUI/update/src`, runs `npm ci` when the lock file
changed, builds the bundle into a staging folder while the app stays usable, then a small helper
script swaps the bundle at the app's location, reopens it and checks that the new version came up
(the previous version is restored otherwise). Running sessions continue because they live in the
session host process. A pill in the top-right corner shows the progress; the update log
is available from Settings → About.

## Session host

`ClaudeGUI Session Host` is a detached process (the app's own binary run as plain Node) that owns
every Claude process. The window connects to it over a Unix socket in the data folder. Closing or
restarting the window leaves it running; **Quit** (`⌘Q`) stops it together with all sessions. A host
started by an older version is replaced automatically once none of its sessions is running.
Settings → About shows its state; its log is `~/Library/Logs/ClaudeGUI/session-host.log`.

## Environment and proxies

When you launch the app from Finder/Dock it does not inherit your terminal environment. ClaudeGUI
therefore starts your login shell once, invokes `claude` there with a stand-in executable that
prints its environment, and gives that environment (PATH, `HTTPS_PROXY`, `EDITOR`, …) to every
Claude process, to `git`/`gh`, to the updater and to the usage check. Shell functions or aliases
wrapping `claude` are honoured automatically. Settings → Claude → "Extra environment variables"
adds or overrides variables if needed; Settings shows what was captured.

## Where things live

| Item | Location |
|---|---|
| Session index (with groups and order), app settings, window state, permission probe results | `~/Library/Application Support/ClaudeGUI/` |
| Session host socket and descriptor | `~/Library/Application Support/ClaudeGUI/session-host.{sock,json}` |
| Conversation transcripts (source of truth) | `~/.claude/projects/<project>/<session-id>.jsonl` (written by Claude Code) |
| App log · session host log | `~/Library/Logs/ClaudeGUI/claudegui.log` · `session-host.log` |
| Update checkout, dependencies, staging build and log | `~/Library/Caches/ClaudeGUI/update/` |
| Plan-usage login token (read only) | macOS Keychain item `Claude Code-credentials` or `~/.claude/.credentials.json` |

Deleting a session in the app only removes it from the index unless you confirm deleting the
transcript as well. `CLAUDEGUI_USER_DATA=<dir>` moves the settings/session index elsewhere and
`CLAUDEGUI_UPDATE_DIR=<dir>` the update folder (used by the dev and test scripts).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `⌘N` | New session |
| `⌘⇧I` | Import a CLI session |
| `⌘1` … `⌘9` | Switch to the n-th session (sidebar order) |
| `⌘⇧[` / `⌘⇧]` | Previous / next session |
| `⌘K` | Search sessions |
| `⌘L` | Focus the composer |
| `⌘B` / `⌘⇧E` / `⌘⇧G` / `⌘⇧S` | Toggle sidebar / files panel / Git panel / status board |
| `⌘.` | Interrupt the current turn (the prompt returns to the input box) |
| `⌘⏎` | Allow the pending permission request (in the chat) · commit (in the Git commit box) |
| `⌘,` | Settings |

## Development notes

- `scripts/devctl.sh` drives a dev instance through a debug HTTP endpoint
  (`CLAUDEGUI_DEBUG=1`, or Settings → Advanced): screenshots, state dumps, host and updater state,
  sending messages, evaluating JS in the renderer.
- Architecture and status: `docs/ARCHITECTURE.md`, `docs/STATUS.md`; release notes: `CHANGELOG.md`.
