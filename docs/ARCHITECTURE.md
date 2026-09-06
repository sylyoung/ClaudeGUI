# ClaudeGUI architecture

```
src/
  shared/types.ts          IPC contract: session records, live state, chat message model,
                           settings, git, plan-usage and context-usage views
  main/
    index.ts               Electron app lifecycle, window, menu, theme (nativeTheme + accent),
                           notifications, quit confirmation, resume-on-launch
    env.ts                 Login-shell environment capture (zsh -ilc, claude wrapper aware)
    store.ts               JSON persistence (session index, settings + defaults)
    ipc.ts                 ipcMain handlers (sessions, fs, shell, git, usage, dialog, settings)
    fsService.ts           Directory listing (exclude patterns), file probe/reading, watching
    shellService.ts        Open URLs / files / editor / Finder / "open -a App"
    gitService.ts          git + gh command wrapper: status (porcelain v2), stage/unstage/untrack,
                           discard (Trash for untracked), commit/push/pull/fetch, log, diff
                           contents, branches, stash, undo/revert, publish
    usageService.ts        Plan rate-limit windows: claude.ai usage endpoint via curl with the
                           stored OAuth token, session fallback, rate_limit_event merging, timer
    debugServer.ts         Dev-only HTTP endpoint (screenshots, state, eval)
    sessions/
      transcript.ts        Pure reducer: SDK messages -> ChatMessage model (live + history)
      SessionRuntime.ts    One Claude Code process (SDK query, input queue, permissions,
                           context-usage refresh, settings-driven options)
      SessionManager.ts    Registry of runtimes, event fan-out, notifications, resume-on-launch
  preload/index.ts         contextBridge -> window.api
  renderer/src/
    store.ts               zustand store mirroring main-process state (+ git state, usage, theme)
    lib/theme.ts           Theme/accent resolution -> CSS variables, highlight.js theme swap
    lib/tasks.ts           Task counts and context-percentage helpers
    App.tsx                3-pane layout (sessions | chat | files/tasks/git)
    components/
      Sidebar.tsx          Session list with context % and task indicators
      chat/                ChatView (+ ContextBar), MessageList, ToolCallCard, PermissionPrompt, Composer
      files/               FilePanel (tabs), FileTree (git badges, open-with logic), FileViewer, TasksPanel
      git/                 GitPanel, useGitAutoRefresh
      status/              UsageStatus (top-right pills + popover)
      dialogs/             NewSession, ImportSession, Settings (tabbed)
```

## Data flow
1. Renderer calls `window.api.sessions.send(id, text)`.
2. Main `SessionRuntime` pushes an `SDKUserMessage` into the async input queue feeding
   `query({ prompt: asyncIterable, options })`.
3. SDK messages (`stream_event`, `assistant`, `user`, `result`, `system/*`) are folded by the
   transcript reducer into `ChatMessage` objects; changed messages are sent to the renderer
   (`session:message`), and status changes as `session:state`.
4. `canUseTool` callbacks become pending permission requests shown inline in the chat; the
   renderer answers through `sessions.answerPermission`.
5. After `init` and after every `result`, the runtime asks the CLI for its context usage
   (`getContextUsage({ detail: 'summary' })`) and publishes it in the live state.

## Plan usage
- `UsageService` reads the OAuth token Claude Code stored at login (Keychain item
  `Claude Code-credentials`, or `~/.claude/.credentials.json`), calls the claude.ai usage endpoint
  through `curl` (so proxy variables apply; the token travels in a config document on stdin), and
  normalises the `limits[]` array (session / weekly_all / weekly_scoped per model) plus credits.
- Fallbacks: the structured `/usage` of a running session (SDK), then the `rate_limit_event`
  messages every API response carries (merged per window).
- Refresh: timer (Settings), after finished turns (rate-limited to once per 20 s), menu / popover.
- Snapshots are broadcast as `usage:update`; the renderer shows them in the top-right corner.

## Git
- Every git IPC call takes the session's working directory; the repo root is resolved with
  `git rev-parse --show-toplevel`. Commands run with the captured login-shell environment
  (credential helpers, `gh`, proxies) and `GIT_TERMINAL_PROMPT=0`.
- `useGitAutoRefresh` re-reads the status on mount, on `fs:changed` events inside the working
  directory, when a turn finishes, on window focus and on the configured intervals; the result
  feeds both the Git panel and the badges in the file tree.

## Theme
- Settings hold `theme` (system / light / dark) and `accent`. Main sets `nativeTheme.themeSource`,
  reports `shouldUseDarkColors` and the macOS accent colour (`systemPreferences.getAccentColor`),
  and broadcasts `theme:changed` when either changes. The renderer writes CSS variables and
  `data-theme` / `data-density` / `data-translucent` attributes on `<html>`.

## Session lifecycle
- `stopped` (no process) -> `starting` -> `idle` / `running` / `requires_action`.
- A session is started lazily on first send, or at launch according to "Resume sessions on launch";
  history is loaded from the JSONL transcript.
- Stopping = end the input iterator (graceful) then `query.close()` after a grace period.
