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

## Forking a chat
`SessionManager.fork(id, name?)` does what the CLI's `/branch` does, through the SDK's
`forkSession(claudeSessionId, { dir: cwd, title })`: the transcript is copied under a new session id
(message uuids remapped, no file-history snapshots), and a new record gets that id, the title
"<title> (Branch)" / "(Branch N)" (`branchTitle`, an existing suffix is stripped first) or the name
given to `/branch`, and the original's folder, group, model, permission mode, effort and last-prompt
time. The original runtime is not involved at all — no stop, no queue change, no write to its
transcript file (checked live: size and modification time unchanged while the fork answered). The
renderer selects the fork (`forkSession` in the store); `/branch [name]` typed in the input box is
routed there instead of being sent to the CLI. A fork of a running chat copies what the transcript
holds at that moment; the result footers are not part of a transcript, so a fork shows none for the
copied turns.

## Shell commands typed after "!"
`SessionRuntime.runShell(command)` is the terminal's shell mode: the renderer routes a message that
starts with `!` (or `！`) there. The host adds a synthetic row `<bash-input>…</bash-input>`
(`TranscriptState.addLocalShellRun`), lists its id in `live.runningShellIds`, and runs
`$SHELL -ilc <command>` in the chat's folder with the session environment, `detached` so it has its
own process group. When it ends, the row becomes `<bash-input>` + `<bash-stdout>` + `<bash-stderr>`
(output kept to its first and last 15 000 characters, terminal escape codes removed, an exit code or
"(stopped)" appended to stderr), and the same text is pushed to the CLI with `shouldQuery: false`:
it is appended to the conversation without starting a turn and merged into the next prompt that
does (the SDK documents this for the desktop app's bash mode). Each such append still produces an
empty `result` naming no prompt; `handleLifecycle` sets `shellResultExpected` when the append is
`started` while no prompt is being answered, and that result is dropped — no footer, no unread
mark, no notification. Stop (`stopShell`, also on interrupt and stop) sends SIGHUP and SIGTERM to
the process group and SIGKILL 1.5 s later: an interactive zsh ignores SIGTERM and would otherwise go
on to the next part of `a; b`. Commands are stopped after 10 minutes. The renderer shows these rows
(`ShellRun` in MessageItem.tsx), including the ones the terminal's own shell mode left in an
imported transcript.

## Messages the CLI writes about its own housekeeping
Some user-role messages in the stream are not prompts: the summary kept when the context is
compacted (`isCompactSummary`, or its fixed opening words on a replay), the CLI's
`<local-command-stdout>` note about a command it ran, command echoes, system reminders and task
notifications. `TranscriptState.absorbHousekeeping` folds the compaction summary into the
`compact_boundary` row (`data.summary`) and drops the note that only repeats it; on replayed history
there is no boundary message, so a "Context compacted earlier in this chat" row is created to hold
the summary — otherwise the summary would appear as a prompt the user seemed to have typed. The rest
stay as folded rows, named by `houseKeepingLabel` in the renderer instead of "system message".

## The unread mark
`SessionLiveState.unread` counts the finished turns the user has not looked at; it feeds the "N"
mark and the count badge in the sidebar, the state pill in the chat header, the statistics bar and
the number on the dock icon (`SessionManager.refreshBadge`). It is raised in
`SessionManager.onTurnFinished` only when the turn was not in the foreground (the window focused
*and* that session selected) and was not housekeeping, and it is cleared when the session is
selected or the window regains focus (`setActive` → `SessionRuntime.markRead`) and, since 1.0.18,
whenever a prompt is sent into the chat — writing into a chat means having it in front of you.

A turn counts as housekeeping (`compactionOnly` in the `result` branch of `SessionRuntime`) when the
only prompts it answered were a `/compact`. The prompts of a turn are the ones the result names
(`user_message_uuids`) together with the ones still marked `working`, because a `/compact` the CLI
refuses ("Not enough messages to compact") answers without naming anything; the notes the CLI writes
itself are excluded (`synthetic`), and the command is recognised both as the user typed it and in
the CLI's echo of it (`<command-name>/compact</command-name>`). A compaction that the CLI ran on its
own in the middle of a turn is housekeeping only while the turn wrote nothing else
(`turnHadCompaction && !turnHadText`): once there is an answer, there is something to read.

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
- `{type: 'command_lifecycle', command_uuid, state}` frames (not declared in the SDK's message union)
  report every message the CLI was handed: `queued`, `started`, `completed`, `cancelled`. `started`
  is treated like a named prompt → `working`, and `cancelled` drops it. This is the only report of a
  prompt sent during a running turn being taken: the CLI folds such a prompt into that turn together
  with the next tool result, and no reply frame names it until the turn's result (an SDK probe: sent
  at 5.8 s, `started` at 13.3 s, first naming at the result, 16.4 s);
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

## File paths in the chat
- `lib/paths.ts` finds paths in plain text (`findPaths`, used by `LinkifiedText` and by the remark
  plugin in `Markdown.tsx`) and judges inline code (`isProbablyPath`). A segment is
  `[\p{L}\p{N}\p{M}_.\-+@%~()]+` under the `u` flag: the letters and digits of every writing
  system, because `\w` stops at the first Chinese character and cut such a path in half.
- Chinese, Japanese and Korean are written without spaces, so a sentence touches the path it names.
  Two heuristics keep that readable: `cutGluedSentence` ends a match at the file extension when the
  text goes on in one of those scripts (`测试文件.md的内容`), and `cutGluedPrefix` starts an absolute
  path at a root directory when the characters before it are of those scripts
  (`打开/Users/me/文件.md`). A relative path glued to the words before it cannot be separated by
  looking at the text alone, which is what `fs:locate` is for.
- `fs:locate` (`locatePath` in `fsService.ts`) is `fs:resolve` plus repair: if the path as written
  does not exist and it contains such characters, the spellings with those characters dropped from
  the front of the first segment and from the end of the last are tried, longest first, and the
  first one that exists is returned. Clicking a path in the chat and its right-click menu both go
  through it; everything else still uses the plain `fs:resolve`.
- `Markdown.tsx` marks the paths it finds as links with the internal address `claudegui-file://…`.
  react-markdown empties the address of any protocol it does not know, which silently killed every
  such link, so the component passes a `urlTransform` that lets that one address through and hands
  everything else to react-markdown's own check.
- `lib/keys.ts` holds `isComposing`, which is true while an input method is still assembling a
  character. Chinese, Japanese and Korean input methods use Enter, Escape and the arrows to pick
  among their candidates, so every handler that reads those keys (the chat box, the window-level
  Escape and ⇧⇥ of `ChatView`, `Modal`, the filter lists, the rename boxes, the Git panel) returns
  early while a composition is open.

## Claude Code's login
- Claude Code renews its 8-hour access token itself with a refresh token; the refresh token has an
  end date of its own (`refreshTokenExpiresAt` in the stored login, possibly moved by each renewal).
  When the login server refuses it, the CLI removes the stored login and every turn fails with an
  assistant frame carrying `error: 'authentication_failed'` (model `<synthetic>`). Only a browser
  sign-in brings it back; the app never renews or writes the login, because a second renewer would
  invalidate the refresh token the CLI holds.
- `claudeLogin.ts` (`readStoredLogin`) is the one reader of the stored login (Keychain item
  `Claude Code-credentials`, or `~/.claude/.credentials.json`): the access token for the usage
  check, and the two expiry dates. Tokens are never logged or sent to the renderer.
- The host sets `live.authFailedAt` / `authError` on such a frame and clears them with the next real
  answer. The main process re-checks the login whenever a state event carries a newer
  `authFailedAt`.
- `AuthService` (main): `check()` every 10 minutes, at startup and on a failure: a stored login →
  `signed-in` (with `loginEndsAt`); otherwise `claude auth status --json` → `signed-out` or
  `api-key` (only `loggedIn`, `authMethod`, `subscriptionType` are read). Becoming signed out raises
  a system notification. `signIn()` runs `claude auth login` with piped stdio: its stdout carries
  "If the browser didn't open, visit: <url>" (the CLI opens the browser itself through `open` on
  PATH), stdin takes a pasted `code#state`, exit 0 means signed in. State goes to the renderer as
  `auth:update` (`AuthState`).
- Renderer: `AuthNotice` above the chat — signed out (red, cannot be dismissed), chats that failed
  since the status last changed while a login is stored (amber, "send again"), or a login ending
  within three days (amber) — each with **Sign in…**, which opens `SignInDialog`.
- Calls the window adds for a newer host (fork, `runShell`) go through `needsCurrentHost` in ipc.ts,
  which turns an older host's "Unknown host method" into "quit ClaudeGUI completely and open it
  again", because the host outlives updates.

## Plan usage
- `UsageService` reads the OAuth token Claude Code stored at login (through `readStoredLogin`), calls the claude.ai usage endpoint
  through `curl` (so proxy variables apply; the token travels in a config document on stdin), and
  normalises the `limits[]` array (session / weekly_all / weekly_scoped per model) plus credits.
- Fallbacks: the structured `/usage` of a running session (through the host), then the
  `rate_limit_event` messages every API response carries (merged per window).
- There are no bars: the percentage itself carries the colour (green below the warning threshold
  from the settings, amber above it, red from `CRITICAL` = 90 %), and the breakdown states the scale
  in a sentence whose words "green", "amber" and "red" are printed in the colours they name, so the
  red is on screen at any level of use. The thresholds match the terminal's status line.

## Sidebar order, views and groups
- `SessionRecord.groupId` / `order` / `lastPromptAt` / `lastModel`; `SessionGroup {id, name, order,
  collapsed, color}` in sessions.json. `lastPromptAt` is set by `SessionRuntime.send`; records from
  older versions get it from the transcript (`lastPromptTimeFromFile`, scanning the file backwards
  in 1 MB chunks for the last user line that is a real prompt) or from the loaded history.
- Settings `sidebarView` ('groups' | 'recent') and `sidebarSort` ('lastPrompt' | 'manual').
  `sidebarSections` (renderer store) builds the sections: per group + ungrouped, or Pinned + Recent;
  inside a section `compareByLastPrompt` (pinned first, newest prompt first) or `compareRecords`
  (pinned first, manual `order`). Only `moveSession` renumbers `order`.
- Chats working in the same folder belong to one group: `create` and `importCli` put a chat into
  the group of the chats already in its folder when no group was chosen, a fork inherits its
  original's group, and `moveSession` moves the folder's other chats along (unless a chat is only
  being put in another place among them). In the groups view, folders with two or more chats are
  gathered under a folder row even with `groupSessionsByFolder` off; the recent view never is.
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
