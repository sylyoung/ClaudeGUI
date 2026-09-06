# ClaudeGUI architecture

```
src/
  shared/
    types.ts               IPC contract: session records/groups, live state, chat message model,
                           settings, git, plan-usage, context-usage, host, update, permission views
    defaults.ts            DEFAULT_SETTINGS (shared by the window and the session host)
    util.ts                splitList, version comparison, compareRecords (sidebar order)
  main/                    Electron window process
    index.ts               App lifecycle, window (+ saved bounds), menu, theme, notifications,
                           session-host connection and replacement, quit / restart-for-update
    hostClient.ts          Client of the session host: attach or spawn, RPC over the socket, typed
                           helpers mirroring the session manager, stale-host shutdown
    updater.ts             Check tags → checkout → npm ci (if lock changed) → build → verify →
                           apply-update.sh (swap bundle, reopen); startup notice
    permissions.ts         macOS privacy probes / requests / System Settings panes
    windowState.ts         window-state.json (bounds, maximized)
    env.ts                 Login-shell environment capture (zsh -ilc, claude wrapper aware)
    store.ts               JSON files: SettingsStore (window) and SessionsStore (host, with groups)
    ipc.ts                 ipcMain handlers (sessions → host, fs, shell, git, usage, update, perms)
    fsService.ts           Directory listing (exclude patterns), file probe/reading, watching
    shellService.ts        Open URLs / files / editor / Finder / "open -a App"
    gitService.ts          git + gh command wrapper (status, stage, commit, push, diff, branches…)
    usageService.ts        Plan rate-limit windows (claude.ai usage endpoint via curl, fallbacks)
    debugServer.ts         Dev-only HTTP endpoint (screenshots, state, host/update state, eval)
  host/                    Session host: plain Node process (app binary + ELECTRON_RUN_AS_NODE)
    index.ts               Unix-socket server, RPC dispatch, lifecycle (idle exit, shutdown)
    protocol.ts            NDJSON frames: hello/welcome, req/res, events; HOST_PROTOCOL version
    sessions/
      transcript.ts        Pure reducer: SDK messages -> ChatMessage model (live + history)
      SessionRuntime.ts    One Claude Code process (SDK query, input queue, permissions,
                           context usage, cwd checks, transcript relocation)
      SessionManager.ts    Registry of runtimes, records + groups + manual order, events,
                           notifications, resume-on-launch
  preload/index.ts         contextBridge -> window.api
  renderer/src/
    store.ts               zustand store (records, live, groups, messages, update, sent-prompt
                           queue for interrupt restore, files/panel state persisted per session)
    lib/sessionState.ts    Visual state of a session (working / attention / idle-tasks / …)
    lib/sessionMenu.ts     Context-menu entries shared by sidebar, status board and chat header
    lib/options.ts         Full-name labels for permission modes and effort levels
    lib/theme.ts           Theme/accent resolution -> CSS variables, highlight.js theme swap
    lib/tasks.ts           Task counts and context-percentage helpers
    App.tsx                Layout: sidebar | (status board / chat | files), tooltip layer
    components/
      Sidebar.tsx          Groups, drag & drop ordering, coloured rows, indicators, search
      StatusBoard.tsx      Overview strip with one chip per session
      common/Tooltip.tsx   Global hover explanations for elements with data-tip
      common/ContextMenu.tsx  Menus with submenus ("Move to group")
      chat/                ChatView (+ ContextBar, toolbar info), MessageList, ToolCallCard,
                           PermissionPrompt, Composer (ranking, clear, restore)
      files/               FilePanel (tabs), FileTree, FileViewer, TasksPanel
      git/                 GitPanel, useGitAutoRefresh
      status/              UsageStatus (top-right pills + popover), UpdatePill
      dialogs/             NewSession, ImportSession, Settings (tabbed), UpdatesPanel,
                           PermissionsPanel
```

## Data flow
1. Renderer calls `window.api.sessions.send(id, text)` → IPC → `HostClient.send` → socket request.
2. In the host, `SessionRuntime` pushes an `SDKUserMessage` into the async input queue feeding
   `query({ prompt: asyncIterable, options })`.
3. SDK messages (`stream_event`, `assistant`, `user`, `result`, `system/*`) are folded by the
   transcript reducer into `ChatMessage` objects; changed messages travel as host events
   (`session` → `session:message`) to the renderer, state changes as `session:state`.
4. `canUseTool` callbacks become pending permission requests kept in the host and shown inline in
   the chat; the renderer answers through `sessions.answerPermission`.
5. After `init` and after every `result`, the runtime asks the CLI for its context usage and
   publishes it in the live state.

## Session host
- Started by the window with `process.execPath host.mjs --data <userData> --log … --version …`,
  `detached`, `ELECTRON_RUN_AS_NODE=1`; it writes `session-host.json` (pid, socket, token, version).
  Asar support is available in that mode, so the script runs straight from `app.asar`.
- The window sends `hello` (token, protocol, settings, focus) and gets `welcome` (pid, version,
  live count). Requests are `{k:'req', id, m, p}` → `{k:'res', id, ok, v|e}`; events `{k:'ev', e, d}`
  (session events, notifications, badge, rate limits, turn finished, exiting).
- Reattach: after a window restart the renderer reloads the list from the host and history per
  session (`ensureHistory` returns the in-memory transcript, so nothing is lost).
- Lifecycle: without a client and without live sessions the host exits after 5 s; `shutdown`
  (normal quit) stops all sessions; SIGTERM does the same. A host from another app version is kept
  while its sessions run and replaced automatically as soon as none is alive (`stale`). A host
  with an incompatible protocol is stopped after the user confirms.

## Updates
- `Updater.check`: `git clone` / `git fetch --tags` of the configured repository into the update
  folder, newest semver tag vs `app.getVersion()`, changelog section for the notes.
- `Updater.install`: `git checkout --detach tags/vX`, `git clean -fdx -e node_modules`, `npm ci`
  when the sha256 of package-lock.json changed, `npm run build:mac -- --config.directories.output=
  <staging>`, plist version check.
- `Updater.apply`: writes `pending-update.json` and starts `apply-update.sh` (waits for the pid,
  moves the old bundle aside, moves the new one in, `open --env CLAUDEGUI_*=… bundle`, deletes the
  old bundle, rolls back on failure), then quits with `updating = true` so the host stays alive.
  `before-quit` continues on the next tick (`setImmediate`) because a nested `app.quit()` inside the
  handler is ignored by Electron.

## Plan usage
- `UsageService` reads the OAuth token Claude Code stored at login (Keychain item
  `Claude Code-credentials`, or `~/.claude/.credentials.json`), calls the claude.ai usage endpoint
  through `curl` (so proxy variables apply; the token travels in a config document on stdin), and
  normalises the `limits[]` array (session / weekly_all / weekly_scoped per model) plus credits.
- Fallbacks: the structured `/usage` of a running session (through the host), then the
  `rate_limit_event` messages every API response carries (merged per window).

## Sidebar order and groups
- `SessionRecord.groupId` / `order`; `SessionGroup {id, name, order, collapsed}` in sessions.json.
- `compareRecords`: pinned first, then `order`, then newest first for records without a position.
  Only `moveSession` (drag & drop, "Move to group") renumbers positions; activity never reorders.
- Drag & drop uses HTML5 DnD with custom MIME types for sessions and group headers.

## Permissions
- `PermissionService` probes folder access with async `readdir` (a blocked folder returns EPERM;
  the first read triggers the system prompt), Full Disk Access by reading the TCC database file,
  Accessibility / Screen / Camera / Microphone through `systemPreferences`, Automation through
  `osascript` (result remembered in `permissions.json`), Notifications by showing one, Local
  Network by sending an mDNS packet. `openPane` uses `x-apple.systempreferences:` URLs.
- Info.plist carries `NS*UsageDescription` strings (electron-builder `extendInfo`); the bundle is
  signed with an Apple Development identity when available (`mac.type: development`).

## Git
- Every git IPC call takes the session's working directory; the repo root is resolved with
  `git rev-parse --show-toplevel`. Commands run with the captured login-shell environment.
- `useGitAutoRefresh` re-reads the status on mount, on `fs:changed` events inside the working
  directory, when a turn finishes, on window focus and on the configured intervals; the result
  feeds the Git panel, the badges in the file tree and the remote/branch shown in the chat.

## Theme
- Settings hold `theme` (system / light / dark) and `accent`. Main sets `nativeTheme.themeSource`,
  reports `shouldUseDarkColors` and the macOS accent colour, and broadcasts `theme:changed`. The
  renderer writes CSS variables and `data-theme` / `data-density` / `data-translucent` attributes.

## Session lifecycle
- `stopped` (no process) -> `starting` -> `idle` / `running` / `requires_action`; `error` when the
  process failed or the working directory is missing (`cwdMissing`).
- A session is started lazily on first send, or at launch according to "Resume sessions on launch";
  history is loaded from the JSONL transcript.
- Stopping = end the input iterator (graceful) then `query.close()` after a grace period.
