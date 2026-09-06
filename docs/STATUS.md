# ClaudeGUI — build status

Last updated: 2026-09-06 (session 2, v1.0.1)

## Goal
A local macOS desktop app (Electron + React + TypeScript) that manages many long-running
Claude Code sessions in one window: sidebar of sessions with live status, rendered chat
(markdown, tables, diffs, tool cards), permission prompts in the GUI, clickable URL/file links,
a file explorer + viewer rooted at each session's working directory, git integration, and
always-visible plan-usage / context meters.

## Key decisions
- Sessions are driven through `@anthropic-ai/claude-agent-sdk` (0.3.263, same version as the
  installed `claude` CLI 2.1.263) in **streaming input mode**, so one CLI process per session stays
  alive between turns (background shells / monitors keep running).
- Transcript source of truth = Claude Code's own JSONL under `~/.claude/projects/` (read via the
  SDK's `getSessionMessages`). The app only persists a small session index + settings in
  `~/Library/Application Support/ClaudeGUI/` (`CLAUDEGUI_USER_DATA` overrides the folder; the dev
  scripts use `sandbox/userdata` so a dev instance never collides with an installed copy).
- Our session id == Claude session id (we pass `sessionId` when creating, `resume` when reopening).
- The CLI subprocess gets the environment the user's terminal `claude` command would get: the app
  runs the login shell and invokes `claude` with a stand-in executable first on PATH that dumps its
  environment. This reproduces the `claude()` wrapper function in `~/.zshrc` (which injects
  `HTTP_PROXY=http://127.0.0.1:18118` etc.). Without this, a Finder-launched app got HTTP 403
  from the API. Settings has an "extra environment variables" box as a manual override. The same
  environment is used for `git`, `gh` and the usage check.
- Settings sources: user + project + local (configurable) and the `claude_code` system prompt
  preset, so skills, CLAUDE.md, hooks and MCP servers behave exactly as in the terminal.
- Plan usage limits come from the claude.ai usage endpoint (the one the CLI's `/usage` reads) using
  the OAuth token Claude Code stores in the Keychain; the request goes through `curl` so the proxy
  applies. Verified response: `limits[]` with `session`, `weekly_all`, `weekly_scoped` (model
  "Fable"), plus `extra_usage` / `spend` for credits. Rate-limit events from API responses are
  merged into the same windows.
- Git is driven through the `git` CLI (porcelain v2 status); untracked files are "discarded" by
  moving them to the Trash, never deleted outright.
- Theme follows macOS by default (`nativeTheme` + `systemPreferences.getAccentColor`).

## Progress checklist

### v1.0.0
- [x] Environment inspected (node 24, claude 2.1.263 native binary, proxy wrapper, session JSONL format)
- [x] SDK API verified from `sdk.d.ts`
- [x] Main process: env, store, session runtime/manager, fs, shell, ipc, debug server
- [x] Preload bridge; renderer: sidebar, chat, tool cards, permissions, composer, file tree, viewer, dialogs
- [x] Live tests passed: streaming text, Bash tool, Write permission prompt, AskUserQuestion,
      Explore subagent (nested transcript), background Bash task + wake-up, stop/resume,
      app restart restoring history, CLI session import, interrupt, `/cost`, concurrent sessions
- [x] Packaged `.app`, README, public GitHub repository (github.com/sylyoung/ClaudeGUI)

### v1.0.1
- [x] 1. Non-text files open with the default macOS app (verified: clicking `notes.docx` launched
      Microsoft Word, no viewer tab opened); "Open with…" app picker; double-click action setting;
      chat links use the same rule.
- [x] 2. Git: `gitService.ts` + Git tab + tree badges. Verified through the IPC layer on a sandbox
      repo: stage, commit, undo last commit, unstage, add to .gitignore, discard untracked (moved to
      Trash), binary diff detection, branches; verified visually: changes/untracked/ignored sections,
      inline diff, commit list, branch/remote header, badges in the tree.
- [x] 3. Themes: system/light/dark + accent (system accent read as #007aff), translucent sidebar
      (verified visually), macOS-style dark grey palette.
- [x] 4. Settings in eight tabs; every option is wired (notifications kinds/sound, Dock badge,
      resume on launch — verified: restart auto-started the active session —, quit confirmation,
      default cwd, SDK options, tool lists, settings sources, auto-title, files/git/usage options,
      tool-result truncation, debug server).
- [x] 5. Plan usage in the top-right corner with last-check time and popover (verified:
      Session 10 %, Weekly 23 %, Fable 13 %, subscription "pro", reset times).
- [x] 6. Context bar per chat (verified: 26k / 1.00M · 3 % with category breakdown), sidebar
      context % and task/subagent counts, header pills.
- [x] Version 1.0.1, CHANGELOG.md, docs, packaged build in `dist/mac-arm64/` (tags `v1.0.0`, `v1.0.1` pushed to GitHub).

## Known limitations / ideas for next iterations
- No embedded terminal (xterm.js + node-pty) yet; "Open folder in Terminal" opens Ghostty instead.
- "Open with…" uses a file picker for the application instead of the Finder-style list of apps
  registered for the file type.
- "Publish to GitHub…" needs the `gh` CLI logged in.
- The claude.ai usage endpoint is not a documented API; if its shape changes, the widget falls
  back to the running session's `/usage` data and to rate-limit events.
- Cost shown is the SDK's estimate accumulated across processes of a session; the CLI's own
  `/cost` output is authoritative.
- Git diffs are line-based (no word-level highlighting) and the Git panel shows one repository
  per session (the repo containing the session's working directory).

## How to run
```
npm run dev        # development (hot reload); scripts/devctl.sh start = dev + debug endpoint
npm run build:mac  # produce dist/mac-arm64/ClaudeGUI.app (quit a running ClaudeGUI first)
```
