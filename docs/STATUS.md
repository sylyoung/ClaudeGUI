# ClaudeGUI — build status

Last updated: 2026-09-06 (session 1)

## Goal
A local macOS desktop app (Electron + React + TypeScript) that manages many long-running
Claude Code sessions in one window: sidebar of sessions with live status, rendered chat
(markdown, tables, diffs, tool cards), permission prompts in the GUI, clickable URL/file links,
and a file explorer + viewer rooted at each session's working directory.

## Key decisions
- Sessions are driven through `@anthropic-ai/claude-agent-sdk` (0.3.263, same version as the
  installed `claude` CLI 2.1.263) in **streaming input mode**, so one CLI process per session stays
  alive between turns (background shells / monitors keep running).
- Transcript source of truth = Claude Code's own JSONL under `~/.claude/projects/` (read via the
  SDK's `getSessionMessages`). The app only persists a small session index + settings in
  `~/Library/Application Support/ClaudeGUI/`.
- Our session id == Claude session id (we pass `sessionId` when creating, `resume` when reopening).
- The CLI subprocess gets the environment the user's terminal `claude` command would get: the app
  runs the login shell and invokes `claude` with a stand-in executable first on PATH that dumps its
  environment. This reproduces the `claude()` wrapper function in `~/.zshrc` (which injects
  `HTTP_PROXY=http://127.0.0.1:18118` etc.). Without this, a Finder-launched app got HTTP 403
  from the API. Settings has an "extra environment variables" box as a manual override.
- Settings sources: user + project + local (same as the CLI) and the `claude_code` system prompt
  preset, so skills, CLAUDE.md, hooks and MCP servers behave exactly as in the terminal.

## Progress checklist
- [x] Environment inspected (node 24, claude 2.1.263 native binary, proxy wrapper, session JSONL format)
- [x] SDK API verified from `sdk.d.ts`
- [x] package.json + dependencies installed (Electron binary needed a proxy-aware download)
- [x] Main process: env, store, session runtime/manager, fs, shell, ipc, debug server
- [x] Preload bridge
- [x] Renderer: sidebar, chat, tool cards, permissions, composer, file tree, viewer, dialogs
- [x] Dev run + screenshot verification (scripts/devctl.sh)
- [x] Live tests passed: streaming text, Bash tool, Write permission prompt (allow), AskUserQuestion,
      Explore subagent (nested transcript), background Bash task + wake-up, stop/resume with same
      session id, app restart restoring history (+ subagent transcripts, real timestamps),
      CLI session import (153 sessions listed in 0.2 s; 10 MB transcript loaded in 0.14 s),
      interrupt, `/cost` slash command, concurrent sessions, unread badge for background session
- [x] Package `.app` with electron-builder
- [x] README

## Known limitations / ideas for next iterations
- No embedded terminal (xterm.js + node-pty) yet; "Open folder in Terminal" opens Ghostty instead.
- Tool results are truncated at 60k characters for display.
- Sessions are resumed lazily (a stopped session restarts on the next message). There is no
  "auto-resume all on launch" option yet.
- Cost shown is the SDK's estimate accumulated across processes of a session; the CLI's own
  `/cost` output is authoritative.
- `git` status / diff view for the working directory is not implemented.

## How to run
```
npm run dev        # development (hot reload)
npm run build:mac  # produce dist/mac-arm64/ClaudeGUI.app
```
