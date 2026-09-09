# ClaudeGUI architecture

```
src/
  shared/
    types.ts               IPC contract: session records/groups, live state, chat message model,
                           settings, git, plan-usage, context-usage, host, update, permission views
    defaults.ts            DEFAULT_SETTINGS (shared by the window and the session host)
    util.ts                splitList, version comparison, compareRecords / compareByLastPrompt
    colors.ts              Group colour palette (macOS system colours), next free colour
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
  host/                    Session host: plain Node process (bundle helper binary + ELECTRON_RUN_AS_NODE)
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
                           queue for interrupt restore, files/panel state persisted per session,
                           sidebar sections for the groups / recent views, multi-selection, bulk
                           start / stop)
    lib/sessionState.ts    Visual state of a session and its marker (working "..." / permission "!" /
                           option "Q" / unread "N" / idle·tasks "↻" / idle / not running / error)
    lib/sessionMenu.ts     Context-menu entries shared by sidebar, status board and chat header
    lib/options.ts         Full-name labels for permission modes and effort levels
    lib/theme.ts           Theme/accent resolution -> CSS variables, highlight.js theme swap
    lib/tasks.ts           Task counts, context percentage and the context colour rule (the
                           thresholds of ~/.claude/statusline-command.sh: 200k / 500k tokens, 85 %)
    App.tsx                Layout: sidebar | (status board / chat | files), tooltip layer
    components/
      Sidebar.tsx          Groups / Recent views, pointer-event drag & drop, group colours,
                           multi-selection toolbar, view options menu
      StatusBoard.tsx      One-line statistics bar (counts per state with markers, tasks, Start all)
      common/StateMark.tsx State marker ("..." animated, "!", "Q", "N", "↻", "·", "○", "×")
      common/Tooltip.tsx   Global hover explanations for elements with data-tip
      common/ContextMenu.tsx  Menus with submenus ("Move to group")
      common/PopupSelect.tsx  Drop-down with a short closed label and full-text options
      common/GroupColorPicker.tsx  Palette popover for group colours
      chat/                ChatView (header with action buttons incl. expand/collapse all tool
                           details, one-line configuration row, status row + ContextBar),
                           MessageList (prompt states; prompts still queued are moved to the end),
                           MessageItem (per-prompt state mark + rewind button), ToolCallCard
                           (per-card show/hide), PermissionPrompt, WorkingStrip (what Claude is
                           doing + elapsed time, drawn as the last row of the message list while a
                           turn runs), Composer (command matching
                           anywhere in the text via slashTokenAt, clear, restore, ↑/↓ prompt history)
      files/               FilePanel (tabs), FileTree (order: name / changed / size / type),
                           FileViewer, TasksPanel
      git/                 GitPanel, useGitAutoRefresh
      status/              UsageStatus (top-right pills + popover), UpdatePill
      dialogs/             NewSession, ImportSession (full-height list, keyboard walking),
                           Settings (tabbed), UpdatesPanel, PermissionsPanel,
                           RewindDialog (conversation only or conversation + files, dry-run counts)
```

## Rewinding a chat
A double tap on Escape opens `RewindPicker`, the list of the prompts you have sent in this chat
(newest first, waiting ones left out because there is nothing after them to remove); picking one
opens `RewindDialog`, which is where the choice between the conversation alone and the conversation
together with the files is made. The same window is reachable from the button on your own prompt and
from its right-click menu. Escape is handled in `ChatView`: a single press stops the turn that is
running, a second press within 700 ms opens the picker, and a dialog that is open keeps Escape for
itself. `⇧⇥` steps through `CYCLE_MODES` (default → acceptEdits → plan), as it does in the terminal.

`SessionRuntime.rewindPreview(messageId)` asks the CLI (`query.rewindFiles(uuid, { dryRun: true })`)
what would change on disk; `rewind(messageId, restoreFiles)` optionally calls `rewindFiles` for real,
stops the process, drops every transcript message from that prompt on and remembers a fork point.
The fork point is the `chainUuid` of the last top-level assistant message before the prompt — Claude
Code's own transcript uuid, which is not the same as the API message id used as our message id. The
next start passes `resume` + `resumeSessionAt: forkPoint`, so the CLI replays only up to there;
the fork point is cleared once `system/init` confirms the start, and dropped with a warning in the
chat if the CLI refuses it. File backups exist only when the session was started with
`enableFileCheckpointing` (settings: `fileCheckpointing`).

## Messages the CLI writes about its own housekeeping
Some user-role messages in the stream are not prompts: the summary kept when the context is
compacted (`isCompactSummary`, or its fixed opening words on a replay), the CLI's
`<local-command-stdout>` note about a command it ran, command echoes, system reminders and task
notifications. `TranscriptState.absorbHousekeeping` folds the compaction summary into the
`compact_boundary` row (`data.summary`) and drops the note that only repeats it; on replayed history
there is no boundary message, so a "Context compacted earlier in this chat" row is created to hold
the summary — otherwise the summary would appear as a prompt the user seemed to have typed. The rest
stay as folded rows, named by `houseKeepingLabel` in the renderer instead of "system message".

## What happened to each prompt
A prompt sent while a turn is running goes into the CLI's own command queue. The host tracks every
prompt the app sends in `SessionLiveState.promptDelivery` (`queued` = still in the CLI's queue,
`working` = taken by the turn running now) and keeps the waiting ones, in order, in `queuedIds`.
The states come from what the CLI reports about itself, never from the position of a message in the
chat:
- a prompt is queued on send whenever an earlier prompt is still unfinished (the session status can
  be idle for a moment although the CLI has already taken the next prompt);
- `user_message_uuid` / `user_message_uuids` on the turn's first reply frame name the prompts that
  turn has taken → `working`, and the same fields on the result name the prompts it answered →
  dropped from the map;
- `queued_turn_count` on the result says how many sends are still in the queue; prompts that leave
  the queue without being named were taken for the turn that starts next, so they become `working`,
  not answered. This is what a `/compact` used to get wrong: its own result names no prompt at all,
  so a prompt typed during the compaction jumped straight to "answered";
- prompts left marked after ten quiet seconds, or when the process ends, are let go.

Taking a prompt also moves it to the end of the transcript (`TranscriptState.moveToEnd`, emitted as
`message-removed` followed by `message`, which the renderer re-appends). A prompt is written into
the chat when it is sent — in the middle of the answer to the earlier prompt — but the CLI only
reads it when it takes it off the queue, and its own answer is written after everything the earlier
turn wrote. Moving it keeps the prompt directly above the answer it starts and matches the order the
chat has when it is read back from the CLI's transcript after a restart. `takePrompts` therefore
runs before `transcript.apply` for `stream_event` and `assistant`, so the prompt reaches the end
before the first row of the turn it started.

The chat shows two prompt states and no others: **queued** (the CLI has not taken it — it waits at
the very end of the chat, in its own block, and can be taken back) and **registered** (the CLI has
taken it, so it stands above the answer it started). Everything the host reports as `working`, every
prompt it no longer tracks, and every prompt replayed from an earlier run is registered, so the
renderer needs no fallback reading of the transcript for prompts it did not send itself.

`cancelQueued(messageId)` takes a waiting prompt back through the CLI's `cancel_async_message`
control request (`query.cancelAsyncMessage`, implemented in the SDK but not declared on the public
`Query` type); it fails harmlessly when the CLI has already taken the prompt. Two things make that
reachable from the input box: `send` answers with the id the prompt has in the chat, so a prompt can
be withdrawn even in the moment before its row arrives, and the ↑ walk in the composer is sorted by
the time each prompt was sent rather than by its position in the chat. The second matters because a
registered prompt is moved down to its answer: without it, ↑ would offer the prompt already being
answered instead of the one still waiting below it.

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
- Started by the window with `<helper> host.mjs --data <userData> --log … --version …`,
  `detached`, `ELECTRON_RUN_AS_NODE=1`; it writes `session-host.json` (pid, socket, token, version).
  Asar support is available in that mode, so the script runs straight from `app.asar`.
  `<helper>` is `Contents/Frameworks/<App> Helper.app/Contents/MacOS/<App> Helper` next to the app
  binary (`hostExecutable()` in `hostClient.ts`, falling back to `process.execPath`): a process
  started from the app binary itself is registered by LaunchServices as a running instance of the
  app, and `open ClaudeGUI.app` (Dock, Finder, the update helper) then fails with error -600 while
  the window is closed. The helper app has its own bundle id and is a UI element.
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
  moves the old bundle aside, moves the new one in, `open -n --env CLAUDEGUI_*=… bundle` with
  retries, waits until the app has deleted the marker file, otherwise starts the executable
  directly; deletes the old bundle once the app is up, restores it only when the new version does
  not start), then quits with `updating = true` so the host stays alive.
  `before-quit` continues on the next tick (`setImmediate`) because a nested `app.quit()` inside the
  handler is ignored by Electron.

## Plan usage
- `UsageService` reads the OAuth token Claude Code stored at login (Keychain item
  `Claude Code-credentials`, or `~/.claude/.credentials.json`), calls the claude.ai usage endpoint
  through `curl` (so proxy variables apply; the token travels in a config document on stdin), and
  normalises the `limits[]` array (session / weekly_all / weekly_scoped per model) plus credits.
- Fallbacks: the structured `/usage` of a running session (through the host), then the
  `rate_limit_event` messages every API response carries (merged per window).
- Every bar (`ScaleBar` in `UsageStatus.tsx`) is painted with the whole scale — green up to the
  amber threshold from the settings, amber up to 90 %, red above — with the stretch beyond the
  current percentage faded by an overlay and a needle on the percentage itself. A bar in the colour
  of the current level alone showed no red at all until a limit was nearly exhausted, which is not
  what a meter is for; the thresholds themselves are unchanged and still match the terminal's
  status line.

## Sidebar order, views and groups
- `SessionRecord.groupId` / `order` / `lastPromptAt` / `lastModel`; `SessionGroup {id, name, order,
  collapsed, color}` in sessions.json. `lastPromptAt` is set by `SessionRuntime.send`; records from
  older versions get it from the transcript (`lastPromptTimeFromFile`, scanning the file backwards
  in 1 MB chunks for the last user line that is a real prompt) or from the loaded history.
- Settings `sidebarView` ('groups' | 'recent') and `sidebarSort` ('lastPrompt' | 'manual').
  `sidebarSections` (renderer store) builds the sections: per group + ungrouped, or Pinned + Recent;
  inside a section `compareByLastPrompt` (pinned first, newest prompt first) or `compareRecords`
  (pinned first, manual `order`). Only `moveSession` renumbers `order`.
- Group colours: `nextGroupColor` picks the first unused palette colour; groups without a colour
  get one when the host starts (`assignMissingGroupColors`). The renderer maps a palette colour to
  its dark variant in dark mode (`groupColorFor`).
- Drag & drop is implemented with pointer events (no HTML5 DnD): `pointerdown` arms, a 6 px move
  starts the drag (pointer capture, `body.is-dragging`), `elementsFromPoint` finds the target
  (`data-drop-row`, `data-drop-section`, `data-section-group`), a fixed-position ghost shows the
  outcome, `pointerup` commits (`moveSession`, `setPinned`, `moveGroup`), Escape cancels.
- Multi-selection lives in the store (`selectedIds`); bulk start is staggered (800 ms) because
  each Claude process loads settings, MCP servers and its transcript.

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
