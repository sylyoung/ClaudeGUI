# ClaudeGUI — build status

Last updated: 2026-09-07 (session 4, v1.0.10)

## Goal
A local macOS desktop app (Electron + React + TypeScript) that manages many long-running
Claude Code sessions in one window: sidebar of sessions in user-defined groups with a stable order,
a status board, rendered chat (markdown, tables, diffs, tool cards), permission prompts in the GUI,
clickable URL/file links, a file explorer + viewer rooted at each session's working directory, git
integration, always-visible plan-usage / context meters, one-click self-updates, and sessions that
survive app restarts.

## Key decisions
- Sessions are driven through `@anthropic-ai/claude-agent-sdk` (0.3.263, same version as the
  installed `claude` CLI 2.1.263) in **streaming input mode**, so one CLI process per session stays
  alive between turns (background shells / monitors keep running).
- Since 1.0.2 the Claude processes are owned by a detached **session host** process
  (`out/main/host.mjs` run by the bundle's helper binary with `ELECTRON_RUN_AS_NODE`), reached over
  a Unix socket. The window can restart (updates) without stopping sessions; `⌘Q` stops everything.
  Since 1.0.5 the host runs through `ClaudeGUI Helper.app` (own bundle id): a host started from the
  app binary is registered by LaunchServices as a running ClaudeGUI, which made `open ClaudeGUI.app`
  fail with error -600 while the window was closed (the 1.0.4 relaunch failure).
- Transcript source of truth = Claude Code's own JSONL under `~/.claude/projects/` (read via the
  SDK's `getSessionMessages`). The app only persists a small session index (records, groups, manual
  order) + settings in `~/Library/Application Support/ClaudeGUI/` (`CLAUDEGUI_USER_DATA` overrides
  the folder; the dev scripts use `sandbox/userdata`).
- Our session id == Claude session id (we pass `sessionId` when creating, `resume` when reopening).
- The CLI subprocess gets the environment the user's terminal `claude` command would get: the host
  runs the login shell and invokes `claude` with a stand-in executable first on PATH that dumps its
  environment (this reproduces the `claude()` wrapper function in `~/.zshrc`, which injects
  `HTTP_PROXY=http://127.0.0.1:18118` etc.). The same environment is used for `git`, `gh`, the usage
  check and the updater's `git`/`npm` runs.
- Plan usage limits come from the claude.ai usage endpoint (the one the CLI's `/usage` reads) using
  the OAuth token Claude Code stores in the Keychain; the request goes through `curl` so the proxy
  applies. Rate-limit events from API responses are merged into the same windows.
- Updates = git tags of the repository (Settings → About → repository). The updater clones/fetches
  into `~/Library/Caches/ClaudeGUI/update/src`, runs `npm ci` only when the lock file hash changed,
  builds into `…/update/staging` and hands over to `apply-update.sh`, which waits for the app to
  quit, swaps the bundle in place, reopens the app with `open -n --env …` (retried; `CLAUDEGUI_*`
  overrides kept), waits until the app has deleted `pending-update.json`, else starts the executable
  directly, and only then deletes the old bundle (restored if the new version never starts). The
  quit for an update leaves the host running (`updating` flag).
- Builds are signed with an "Apple Development" identity when electron-builder finds one
  (`mac.type: development`), so macOS privacy grants persist across updates; otherwise unsigned.
- Sidebar order (1.0.4): pinned first, then by the time of the user's last prompt (`lastPromptAt`,
  never by Claude's replies); manual `record.order` (drag & drop) is an optional mode. Two views:
  groups (coloured) or pinned / recent. Groups live in `sessions.json` (`groups[]`, with `color`).
- Git is driven through the `git` CLI (porcelain v2 status); untracked files are "discarded" by
  moving them to the Trash, never deleted outright.
- Theme follows macOS by default (`nativeTheme` + `systemPreferences.getAccentColor`).

## Progress checklist

### v1.0.0
- [x] Main process: env, store, session runtime/manager, fs, shell, ipc, debug server
- [x] Renderer: sidebar, chat, tool cards, permissions, composer, file tree, viewer, dialogs
- [x] Live tests: streaming, Bash tool, Write permission, AskUserQuestion, Explore subagent,
      background Bash task + wake-up, stop/resume, restart restoring history, CLI import, `/cost`
- [x] Packaged `.app`, README, public GitHub repository (github.com/sylyoung/ClaudeGUI)

### v1.0.1
- [x] Default-app file opening, "Open with…", double-click action
- [x] Git tab + tree badges, stage/unstage/untrack/discard/ignore/delete, commit/push/pull, diff,
      commits, branches, stash, publish
- [x] Themes (system/light/dark, accent), translucent sidebar, tabbed settings (8 tabs)
- [x] Plan-usage pills with last-check time; context bar; sidebar context % and task counts

### v1.0.2
- [x] Session host process; window reattaches with live state, pending permissions and transcript
      (verified: stop-gui → host + Claude process + `sleep` task survived → new window attached)
- [x] In-app updater (check/build/apply) — verified end to end on an isolated packaged copy against
      a local release repo: 1.0.2 → 1.0.3 built in 13 s (deps unchanged), auto-restart, same host
      pid, background task still running, old bundle removed, "Updated to 1.0.3" notice
- [x] Window bounds, open files, expanded folders and panel tab persist
- [x] Fix: nested `app.quit()` inside `before-quit` was ignored → quit continues on the next tick

### v1.0.3
- [x] 1. Stable order + drag & drop (verified with synthetic drag events: move into group, reorder)
- [x] 2. Groups: create/rename/reorder/collapse/delete, Move to group, group field in New session
- [x] 3. Folder header rows off by default (settings migration `settingsVersion: 2`)
- [x] 4. Status board above the chat (chips per session, summary, ⌘⇧S)
- [x] 5. Hover explanations: global `data-tip` tooltip layer, ~60 titles converted + new tips
- [x] 6. Slash-command ranking (exact → prefix → alias → word start → substring → subsequence)
- [x] 7. Missing working directory: clear error + banner, "Change working directory…" moves the
      transcript (verified: renamed `sandbox/proj-old` → `proj-new`, relocate, resumed with history)
- [x] 8. Session state colours (working / needs input / idle+tasks / idle / not running / error)
- [x] Interrupt puts the sent prompt(s) back into the composer (verified through the store)
- [x] Search box clears after picking a result; clear (×) buttons on search box and composer
- [x] Bigger coloured chips for background shells (blue) and subagents (purple)
- [x] Toolbar: full names for model/permissions/effort; last-activity time, folder size, git remote;
      no cost, no Claude version
- [x] macOS permissions panel (probe/request/open pane), Info.plist usage descriptions,
      Apple Development signing (verified: signed bundle passes `codesign --verify --deep --strict`,
      re-signed `claude` binary runs a session)

## Known limitations / ideas for next iterations
- No embedded terminal (xterm.js + node-pty) yet; "Open folder in Terminal" opens Ghostty instead.
- "Open with…" uses a file picker for the application instead of the Finder-style list of apps
  registered for the file type.
- "Publish to GitHub…" needs the `gh` CLI logged in.
- The claude.ai usage endpoint is not a documented API; if its shape changes, the widget falls
  back to the running session's `/usage` data and to rate-limit events.
- Git diffs are line-based (no word-level highlighting) and the Git panel shows one repository
  per session (the repo containing the session's working directory).
- Updates rebuild from source on the Mac (git, node, npm needed); a prebuilt-zip channel would need
  GitHub Actions and a way around Gatekeeper's quarantine for unsigned downloads.
- The Apple Development certificate expires (currently March 2027); after renewal, builds are signed
  with the new one and macOS asks for the manual grants again.
- Permission states for Automation, Notifications and Local Network are remembered from the last
  request, not read from the system.

## How to run
```
npm run dev        # development (hot reload); scripts/devctl.sh start = dev + debug endpoint
npm run build:mac  # produce dist/mac-arm64/ClaudeGUI.app (quit a running ClaudeGUI first)
```

### v1.0.4
- [x] 1. "ClaudeGUI" label removed from the sidebar top (Groups / Recent switch, view options, settings)
- [x] 2. One-line statistics bar (counts per state, tasks, unread, Start all; click = jump)
- [x] 3. Model / permissions / effort on one line (PopupSelect: short closed label, full-text list)
- [x] 4. Folder panel shown / hidden per chat (header button, ⌘⇧E, remembered per chat)
- [x] 5. Group colours (auto from the macOS palette, changeable; rail, name, tags)
- [x] 6. Pointer-event drag & drop with ghost (verified with synthetic pointer events: move to
      group, manual reorder, pin by drop, group reorder, Escape / cleanup)
- [x] 7. Groups / Recent views ordered by the user's last prompt (`lastPromptAt` on send, transcript
      backfill verified against a 30 MB transcript)
- [x] 8. Visible header buttons (Terminal, Finder, editor, GitHub, panel, pin, start / stop, …)
- [ ] 9. Colour plan: proposal in docs/design/colour-plan.md — waiting for the user's choices
- [x] 10. Option fields: abbreviated when closed, full text in the list
- [x] 11. Multi-selection (⌘/⇧-click, ⌘⇧A) with bulk start / stop / pin / archive / move; Start all
- [x] 12. Model name under the chat name; folder name only while the chat's folder panel is shown

### v1.0.5
- [x] Session host runs through the bundle's helper executable (no LaunchServices confusion)
- [x] Relaunch helper: `open -n`, retries, marker-based start check, direct start fallback,
      rollback only when the new version never starts, notification when nothing opens
- [x] Startup notice accepts a newer running version as "applied"
- [x] Tests: helper script on isolated bundle copies while the real host is registered
      (open -n path and direct-start path), end-to-end update on an isolated app
      (`sandbox/tools/`), type checks and production build

### v1.0.6
- [x] Seven session states (working, permission, option, unread, idle·tasks, idle, not running,
      error) with printed markers instead of dots: `...` `!` `Q` `N` `↻` `·` `○` `×`
- [x] Idle with background work (teal `↻`) separated from plain idle (grey `·`); unread is its own
      state (pink `N`, bolder name, matching badge)
- [x] Working is visible in the chat: animated line under the status row, strip above the input box
      (what Claude is doing, tool time, time since your prompt), glow around the input box
- [x] ↑ / ↓ in the input box walk through this chat's earlier prompts (sent-but-unanswered included)
- [x] Turn footer ends with the finish time; cost only in its tooltip
- [x] Rename works: caret placed and text selected in the chat title, own "Rename…" in the sidebar
      with in-place editing (verified through the host RPC in an isolated instance)
- [x] "N to commit" and "push N" in the chat status row; Git panel button rows wrap
- [x] Context colours follow ~/.claude/statusline-command.sh (200k / 500k tokens, 85 % of the window,
      colours #3fb950 / #d29922 / #da3633)
- [x] Checked in an isolated instance (`CLAUDEGUI_USER_DATA=sandbox/dev-userdata`, debug port 45199)
      with injected example sessions; screenshots in `sandbox/shots/`

### v1.0.7
- [x] Plan-usage limits use the status-line thresholds (amber 50 %, red 90 %) and colours; settings
      migration moves the untouched old default 80 to 50 (`SETTINGS_VERSION` 3)
- [x] Tool cards coloured by kind; permission requests that cannot be undone are red with a tag
- [x] Model name tinted by family (Fable violet, Opus blue, Sonnet teal, Haiku green)
- [x] Status row: branch amber when ahead/behind and red on conflicts, folder size amber >5 GB,
      red >20 GB
- [x] File tree marks files Claude edited in this chat; tasks panel coloured by outcome
- [x] The user picks design options through questions in the chat, not through documents in docs/

### v1.0.8
- [x] The import window fills the screen height (`Modal tall` + a `.list.grow` that scrolls inside it),
      880 px wide, about fourteen rows instead of seven
- [x] Keyboard walking in the import list (↑ ↓, Page Up/Down, Home/End, Enter) while the filter box
      keeps the focus; the highlight scrolls into view and ignores the mouse for 400 ms after a key
- [x] Import rows are exactly two lines (ellipsis instead of wrapping); the session count is shown
- [x] Clicking a session that is already in ClaudeGUI opens that chat instead of doing nothing
- [x] Verified in an isolated instance (debug port 8899): list height 300 → 621 px, Enter imported and
      opened a session, a second click on it re-opened the same chat without a duplicate

### v1.0.9
- [x] Slash matching anywhere in a sentence (`slashTokenAt` in Composer.tsx); paths and dates do not
      trigger it; the completion replaces only that word
- [x] ↑ / ↓ keep walking the prompt history once the walk has started; typing or clicking ends it
- [x] Queued prompts are collected at the bottom of the chat; every prompt shows queued / being
      answered / answered / sent in words and colour (`PromptState` in MessageItem.tsx)
- [x] Show/hide buttons for tool details per card and for the whole chat (store `toolDetails` +
      `toolExpandNonce`)
- [x] A finished /compact no longer marks a chat unread or notifies (`silent` in onTurnFinished)
- [x] Rewind: hover button and right-click entry on your prompts, a window that asks whether files
      should be put back (dry-run counts), `enableFileCheckpointing` behind the new
      `fileCheckpointing` setting, conversation cut with `resume` + `resumeSessionAt` at the previous
      assistant message's chain uuid (`chainUuid` on AssistantChatMessage)
- [x] File tree order: name A→Z / Z→A, recently changed, largest, by type (setting `fileSort`,
      sorted in the renderer so switching is instant)
- [x] Verified live in an isolated instance with a scratch session (haiku, sandbox/rewind-test):
      note.txt went back from "version two" to "version one", the chat lost the later turn, and
      Claude itself answered "version one" afterwards, so the truncating resume worked

### v1.0.10
- [x] Waiting prompts are taken from Claude Code's own facts: `SessionLiveState.queuedIds`, kept in
      step with a finished turn's `user_message_uuids` (which prompts it consumed) and
      `queued_turn_count` (how many of ours are still queued). The old "one off per finished turn"
      count drifted because the CLI folds several queued prompts into one turn — verified: four
      prompts, two results, and the queue still emptied to zero
- [x] Taking a waiting prompt back: `SessionRuntime.cancelQueued` → the CLI's `cancelAsyncMessage`
      control request (implemented in sdk.mjs, not declared on the public `Query` type), plumbed as
      `sessions:cancelQueued` and the store's `takeBackQueued`. ↑ onto a waiting prompt withdraws it
      (the user chose that), and a button on the prompt / its right-click menu does the same
- [x] The prompt history no longer duplicates a prompt that is both in the chat and in `sentQueue`
- [x] The command menu stays closed over recalled text (`noMenu` ref in Composer.tsx) and ↑ / ↓
      belong to the history while a walk is running, so a recalled "/compact" no longer captures them
- [x] A manual /compact is housekeeping whatever it writes: `compact_metadata.trigger === 'manual'`
      marks the turn silent unless a real prompt was folded into it (auto-compaction keeps the unread
      mark, because that turn also answers something)
- [x] Session rows: the state mark spans both lines (`.session-item > .mark { grid-row: 1 / span 2 }`)
      and the baseline glyphs ("...", "·") are nudged up; in the recent view the group is shown by
      the colour of the chat name, and the group tag is gone from the second line
- [x] Verified live in an isolated instance (`CLAUDEGUI_USER_DATA=sandbox/dev-userdata`, port 45199)
      with a scratch session: queue drained to zero after coalescing, a queued prompt withdrawn by ↑
      never reached Claude, /compact (22,911 → 1,616 tokens) left unread at 0, and ↑ walked
      /compact → essay → earlier prompt with the menu closed

### Open after v1.0.6
- The user updates their installed app themselves (Settings → About → check for updates); do not
  touch `dist/mac-arm64` while it runs. Their host is a 1.0.5 one since this session.
- Colour plan (docs/design/colour-plan.md) is a record only — the user does not read documents and
  said to ask them in the chat instead. Chosen in 1.0.7: tool cards by kind, red destructive
  approvals, tinted model names, branch/folder-size warnings, edited-file marks, task outcomes.
  Declined: colouring the permission mode by risk. Still unasked: pinned icon colour, group-coloured
  folders, message bubbles, thinking blocks, turn-footer check marks, window-level accents.
- Restart-free updates were discussed and rejected for now: the window can only be replaced by
  restarting it (sessions survive because they live in the host); migrating sessions one by one to a
  new host would be needed to avoid the host restart. The user said not to build it.
