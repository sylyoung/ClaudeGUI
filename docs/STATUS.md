# ClaudeGUI — build status

Last updated: 2026-09-11 (session 4, v1.0.20)

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

### v1.0.11
- [x] The compaction summary the CLI re-sends as a user message is folded into the `compact_boundary`
      row (`data.summary`, opened from "what Claude kept") instead of standing in the chat; the CLI's
      `<local-command-stdout>Compacted</local-command-stdout>` note is dropped
      (`TranscriptState.absorbHousekeeping`)
- [x] Replayed history has no `compact_boundary` (the CLI does not repeat it), so the summary would
      arrive as a plain user message and be shown as a prompt — a "Context compacted earlier in this
      chat" row is created for it instead. Verified live in an isolated instance (haiku,
      sandbox/compact-test): live compaction 30,170 → 3,291 tokens produced one row and no extra
      lines, unread stayed at 4, and after a restart the replayed chat showed the new row
- [x] Folded system lines are named by what they are (`houseKeepingLabel` in MessageItem.tsx)
- [x] The model name in a session row is no longer coloured by model family

### v1.0.12
- [x] The "working" status (`WorkingStrip`) moved out of the band above the composer and into
      `MessageList`, as the last row of `.messages-inner` (after the flow, before the queued block),
      so it scrolls with the conversation; `ChatView` passes `working` and `turnStartedAt`
- [x] It is drawn as a rounded row hugging its text (`align-self: flex-start`), 15px blue label on a
      soft blue tint, elapsed time in grey mono and only from one second on
- [x] `--blue-soft` / `--blue-line` / `--blue-edge` added to both themes; the status row and the
      glowing composer border use them instead of hard-coded dark-theme rgba values
- [x] Verified live in an isolated instance (haiku, sandbox/status-look, port 45199) in both themes:
      the row appears under the streaming answer and above the waiting-prompts block

### v1.0.13
- [x] Prompt states are tracked in the host (`SessionLiveState.promptDelivery`: `queued` /
      `working`) from the CLI's own reports — `user_message_uuid(s)` on the turn's first reply frame
      and on the result, plus `queued_turn_count` — instead of being inferred from a message's
      position relative to the last result row
- [x] A prompt that leaves the CLI's queue without being named as consumed is taken for the next
      turn → `working`, which is the case a `/compact` produced: its result names no prompt at all,
      so the prompt typed during the compaction was marked "answered" before it had run
- [x] `send()` queues a prompt whenever an earlier one is unfinished, not when the status looks
      busy (the status is idle for a moment between two turns)
- [x] Stale marks are swept after ten idle seconds and when the process ends
- [x] The renderer prefers the tracked state and falls back to the transcript only for prompts
      replayed from an earlier run; only the newest prompt may fall back to "being answered"
- [x] Verified live in an isolated instance (haiku, sandbox/compact-queue, port 45199) with a probe
      recording every state change: queued during the compaction → being answered when the CLI took
      it → answered when its turn ended; ordinary queueing during a normal turn unchanged

### Known issues found after the v1.0.19 release (to fix next)
- **The session host ran out of JavaScript memory.** 2026-09-11 03:06:42 (local): the user's 1.0.18
  host (pid 29226, 32 live chats, up 57 min) aborted in `node::OOMErrorHandler` (crash report
  `~/Library/Logs/DiagnosticReports/ClaudeGUI Helper-2026-09-11-030647.ips`). The app started a new
  host at once with no live chats; the user quit and reopened it at 03:09. Likely cause: every live
  chat keeps its whole transcript (tool results, images) in the host's heap. Not caused by the
  v1.0.19 tests (separate dev process and data folder).
- **A crashed host leaves its Claude processes running, and the reopened app starts a second one per
  chat.** After the crash, five CLI processes had parent pid 1 (two still running tools), and the new
  host resumed the same five sessions, so two processes wrote to one transcript each. Fix ideas: the
  host records its children's pids and the next host stops leftovers before resuming; or the CLI
  children are tied to the host's lifetime.

### Incident 2026-09-11 03:06:42 (local): the user's session host crashed (set aside)
- Set aside at the user's request ("ok leave out the crash for now. finish my required updates in the
  new version"): no crash hardening, no restart-after-crash and no host memory reading in 1.0.19 (the
  reading written for the investigation was removed again). Notes below are the starting point.
- Evidence: `~/Library/Logs/DiagnosticReports/ClaudeGUI Helper-2026-09-11-030647.ips` — pid 29226
  (host 1.0.18, started 02:09:32 with 32 resumed chats) aborted in `node::OOMErrorHandler`; the
  host's JavaScript heap limit is 4192 MB (Electron pointer compression). No stop command reached
  it: my dev-copy stops ran at 03:03:19 and 03:08:44 and only touched `sandbox/userdata`.
- Not the cause (measured): screenshots (all 32 chats hold 6 pictures, 4 MB); the 783 MB transcript
  `649fe6da…` (belongs to 套磁视频, not a ClaudeGUI chat, not open).
- Mechanism found: the SDK's `getSessionMessages` reads the whole transcript into the calling
  process's heap. In an Electron-as-Node process with the host's limit: HSDA (1246 MB file) peak heap
  ~1333 MB / process 2688 MB for 6 returned messages; 报奖 (834 MB) ~1235 MB; MMBCI (904 MB) ~932 MB;
  DataPruning (536 MB) ~568 MB. `getSessionInfo` is cheap (11 MB). Two or three such loads at once
  exceed 4 GB. The trigger at 03:06:42 is not yet known.
- Also measured: the Import dialog's `listSessions` peaks at 56 MB; history loads happen once per
  chat per host; in the host's last hour all chats wrote ~35 MB (busiest: this chat, 9.9 MB incl.
  7.7 MB of screenshots), so neither is it.
- Crash report vmSummary: "Memory Tag 253" 51.8 G virtual in 2317 regions (Chromium's page tags:
  253 = PartitionAlloc, which backs Node Buffers / ArrayBuffers; 255 = V8, 1.4 T reserved). So the
  process ran out of buffer memory, not JavaScript heap. Leading hypothesis to verify: the host
  re-sends a whole changed top message on every 45 ms flush; after six 1.3 MB screenshots the top
  message was ~7.7 MB and kept changing while the reply streamed, and `writeFrame` ignores socket
  backpressure, so unsent frames piled up in the host until the buffer partition was exhausted
  (crash 21–25 s after the screenshots, during the next streamed reply).
- Code check: each API assistant message is its own top message, so the screenshots' message was only
  re-sent as each result arrived (~27 MB in all). But every change inside a subagent touches the
  parent top message, and `flush()` re-sends the whole top message (all subagent children) every
  45 ms while anything in it streams; `emit()` ignores `socket.write` backpressure. MMBCI had at
  least three subagents running across the crash (06:52–07:44, 06:56–07:24, 06:56–07:18 UTC,
  2.4 / 0.9 / 1.2 MB). Reproduction in the dev copy prepared: `sandbox/host-memory-check/
  repro_backlog.py` with the new host "[memory]" reading (`CLAUDEGUI_HOST_MEMORY_MS`).
- Reproduction in the dev copy (Haiku, host "[memory]" reading every 2 s): three parallel subagents
  reading 360 KB files → 19 MB sent in 108 s, nothing waiting for the window, host ≤ 122 MB; six
  1.4 MB images then a long reply → 17 MB sent in 49 s, at most 3.9 MB waiting, host ≤ 156 MB.
  Not reproduced. A suspected 12-minute stall of the user's window before the crash is refuted:
  few turns ended then, and usage checks followed TDBrain's turn ends at 06:57:10 and 07:05:25 UTC.
- Conclusion so far: out-of-memory in the host's buffer memory; trigger not determinable from the
  logs. Weak spots confirmed in code (none reproduced to crash size): `emit()` ignores socket
  backpressure; `flush()` re-sends whole changed top messages; `attachToolResult` keeps `structured`
  tool output unbounded; `getSessionMessages` / `forkSession` load whole transcripts in the host.
- After the crash several old Claude processes kept running detached (at 03:22: 29645 VLMEEG,
  29759 MMBCI, 29939, 30491, 30527 = this chat), next to the new processes the user started — the
  "two of every chat" the user saw. They kept working unattended (this chat's copy committed and
  pushed). All but MMBCI's ended on their own within minutes.
- MMBCI leftover (pid 29759) stopped with SIGKILL at the user's choice; its monitor
  `monitor_both_drivers.sh` (pid 78830) keeps running and writing its log.
- Aftermath: 31 old Claude processes ended with the host; MMBCI's (pid 29759) survived detached and
  later started `scripts/speech_rebalance_20260910/monitor_both_drivers.sh`; not stopped yet (the
  user approved stopping it before it had that child; asking again). No transcript split into two
  branches after the crash. Current host 62143: 122–129 MB over two minutes with 32 chats.
- User decisions: find the cause before fixing, fix in 1.0.19; after a host crash the app restarts
  the chats that were running.

### v1.0.20
Request: "when a prompt like /compact was queued, registered later, the chat would not show that the
model is executing the compact but shows idle. I am not sure if for a normal prompt this is also the
case." Seen on the user's 1.0.18 host (still running at 08:32Z with the 1.0.19 window attached); the
1.0.19 host code has the same status gap.
- Measured with an SDK probe (`sandbox/tools/compact-queue-probe.mjs`, Haiku, two warm-up turns so
  the compaction is not refused as "Not enough messages to compact"): a turn's result reports
  `queued_turn_count=0` with two prompts waiting that were sent mid-turn; the `/compact`'s
  `command_lifecycle started` and `status: "compacting"` arrive in the same millisecond as that
  result; the compaction runs 14.5 s with no other frame and ends with `status: null`, `system/init`,
  `compact_boundary (manual)`, the summary as a user message, a
  `<local-command-stdout>Compacted</local-command-stdout>` user message and an empty result naming no
  prompt; the next queued prompt's `started` follows at once, its first token 0.85 s later.
  `session_state_changed` frames only exist with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` set (the
  host does not set it); with it on, `idle` comes only once the whole queue is drained.
- Fix (host, `SessionRuntime`): taking a prompt sets the status running; a `status` frame with
  `compacting` / `requesting` sets it running; a `completed` frame for a prompt no result answered
  clears the mark. The `queued_turn_count` backstop at the result (1.0.14) is removed: with the count
  always 0 it marked the prompt waiting behind the `/compact` as registered, and moved it up the
  chat, while it was still queued — seen in the first live trace of the dev instance.
- [x] Live trace in the dev instance after the fix (`sandbox/tools/status-trace.mjs`):
      `running / compacting [B=working C=queued]` for the whole compaction, then
      `running / requesting [C=working]`, then idle. Only the dev data folder was used.
- Not checked in the user's own app: needs the new host, i.e. a full quit (⌘Q) after the update.

### v1.0.19
Released: commit a3d9f12, tag `v1.0.19` pushed 2026-09-11 03:14 (local). It was pushed by this
chat's own old Claude process (pid 30527), which outlived the session host crash detached from any
window and finished the release steps on its own while the user reopened the chat.
Requests from the user, in the order given:
- [x] Login expiry. Diagnosis: the CLI renews the 8-hour access token itself; on 2026-09-10 the renewal
      was refused, the CLI removed the stored login and every chat failed with `authentication_failed`.
      A refused refresh token needs a browser sign-in; no program can renew it silently. Plan: detect
      the failure in the host (assistant `error: 'authentication_failed'`), check the login
      (`claude auth status --json`, keychain `expiresAt` / `refreshTokenExpiresAt`, never the tokens),
      one notice across the window with an in-app "Sign in" that runs `claude auth login` (stdout
      carries the fallback URL, stdin takes a pasted code), a warning a few days before the refresh
      token's end date, and a truthful usage-meter message (no more "API-key users" when signed out).
- [x] Fork a chat: whole chat only, like the CLI's `/branch` (title "<title> (Branch)", then
      "(Branch 2)"…, the user lands in the new chat, the original is untouched), same folder. The SDK's
      `forkSession(sessionId, { dir })` copies the transcript. In the groups view, chats that share a
      folder are gathered under that folder's row even when folder rows are off.
- [x] "!" at the start of a prompt runs a shell command, as in the terminal. Confirmed with an SDK
      probe: the host runs the command itself and appends `<bash-input>` / `<bash-stdout>` user
      messages with `shouldQuery: false`; each append only produces an empty `result` (no model call,
      must stay silent: no footer, no unread), and the model sees the output with the next prompt.
- [x] A queued prompt must switch to "registered" as soon as Claude Code takes it. Confirmed cause:
      a prompt sent mid-turn is folded into the running turn and no assistant message names it; only
      `{type:'command_lifecycle', command_uuid, state:'queued'|'started'|'completed'|'cancelled'}`
      says when it was taken ("started"). Fix: treat "started" like a named prompt.
- Sidebar decision: Recent view stays strictly by time; in the Groups view chats sharing a folder are
      gathered under the folder row and belong to one group automatically (a fork inherits the group,
      moving one chat moves its folder siblings). None of the 32 existing chats share a folder.
- Implementation written (typecheck clean): host — `command_lifecycle` handling, `runShell`/`stopShell`,
      `authFailedAt` on assistant `error: 'authentication_failed'`, `SessionManager.fork` (SDK
      `forkSession`, "(Branch)" titles), folder-group rule in create/import/move; main — `claudeLogin.ts`
      (stored-login reader), `authService.ts` (checks, `claude auth login` sign-in), usage messages,
      `needsCurrentHost` IPC wrapper for calls an older running host does not know; window —
      `AuthNotice`, `SignInDialog`, shell rows, "!" / "/branch" routing, fork menu item and header
      button, folder rows for shared folders in the groups view.
- [x] Live checks in the dev instance (Haiku chat in sandbox/v1019-check/work):
      queued prompt sent 5 s into a running turn: queued at once, registered 14.5 s later while the
      turn still ran (3.1 s before it ended); "!" while idle: footers 1 → 1, unread 0 → 0, Claude
      answered from the output ("你好"), "！" works; Stop on `sleep 30; echo …` ended in 0.4 s with
      "(stopped)" and nothing after it (first attempt failed: interactive zsh ignores SIGTERM → now
      the process group gets SIGHUP + SIGTERM, SIGKILL after 1.5 s); fork: "(Branch)", "(Branch 2)",
      "(Branch 3)", `/branch named copy`, fork answers on its own, original transcript size and mtime
      unchanged, all shell rows copied.
- [x] UI checks (screenshots reviewed): the groups view gathers the five same-folder chats under the
      folder row; signed-out (red), login-ending-in-2-days and failed-chat (amber) notices; sign-in
      dialog with a stand-in `claude` script: link shown, wrong code → "Login failed: Invalid code…",
      right code → dialog closes with the success toast; `claudeExecutable` restored afterwards.
- Not exercised live: the `needsCurrentHost` message (needs an older host) and a real expired login.
- Host-side changes (queued fix, "!", fork, noticing failed chats) reach the user's app only after a
      full quit (⌘Q): the in-app update leaves the running 1.0.18 host in place.

### v1.0.18
- [x] Sending a prompt marks the chat read (`SessionRuntime.send` → `markRead`), so a mark left by an
      earlier answer cannot survive into a `/compact`
- [x] A turn whose only prompt was a `/compact` is housekeeping even when the CLI refuses it ("Not
      enough messages to compact"): the prompts of a turn are now the ones it consumed plus the ones
      that were marked as being worked on, because a refused compaction names no prompt at all
- [x] The prompts of a turn ignore the notes the CLI writes itself (`synthetic`), and the command is
      matched in the CLI's own spelling (`<command-name>/compact</command-name>`)
- [x] Verified live in the dev instance (sandbox/compact, window deliberately unfocused): an ordinary
      answer still marks the chat unread; sending `/compact` clears the mark at once and it stays
      clear through the compaction and after it; a refused `/compact` no longer marks it (it did
      before the change)

### v1.0.17
- [x] Paths of any writing system are found in the chat (`lib/paths.ts` under the `u` flag), so
      `中文目录/测试文件.md` is clickable; Japanese, Korean, Russian and accented names too
- [x] File links inside an answer work at all again: react-markdown was emptying the address of
      every `claudegui-file://` link, so no path in rendered markdown could be clicked
- [x] A sentence in a script without spaces glued to a path is cut off it, and `fs:locate` repairs
      what cannot be cut by trying the shorter spellings before reporting the file missing
- [x] Keys that belong to an input method are left to it (`lib/keys.ts`): Enter no longer sends
      half-typed pinyin, and Escape no longer stops the turn while candidates are on screen
- [x] The plan usage is text only — no bars — with the percentage coloured and the scale spelled out
      in words in the breakdown
- [x] Verified live in the dev instance with files named in Chinese under `sandbox/cjk`: every form
      of the path (relative, absolute, `./`, with `:line`, in inline code, glued to a sentence) is a
      link and a click opens the file in the viewer; Enter during a composition sent nothing and the
      same Enter after it sent the prompt; screenshots of the pills in `sandbox/shots/v1017-*.png`

### v1.0.16
- [x] Plan-usage bars show the whole scale at all times (green to the amber threshold, amber to 90 %,
      red above), with the unreached stretch faded and a needle on the current percentage; the
      percentage itself is coloured, and the breakdown says in words what the scale means
- [x] Double tap on Escape opens the rewind list (`RewindPicker`) — the prompts of this chat, newest
      first, with a filter box — and picking one opens the existing rewind window
- [x] A single Escape stops the running turn and puts the prompt back into the input box
- [x] `⇧⇥` steps through the permission modes (default → acceptEdits → plan) with a message naming
      the new one
- [x] Every shortcut is listed in a window of its own, reachable from a button beside the input box,
      from `⌘/` and from the Session menu
- [x] Verified live in the dev instance: Esc Esc opened the picker and Enter opened the rewind window
      for the chosen prompt; ⇧⇥ walked default → acceptEdits → plan → default (host state read back
      each time); Escape during a running turn interrupted it and the prompt reappeared in the box;
      screenshots of the pills (light and dark) and of the breakdown in `sandbox/shots/`

### v1.0.15
- [x] A prompt has two states and no others: registered (Claude Code has taken it; it stands above
      the answer it started) and queued (it waits at the very bottom and can be taken back). The
      earlier "being answered", "answered" and "sent" marks are gone, and with them the transcript
      fallback that guessed between them
- [x] ↑ walks the prompts in the order they were typed, not in the order they stand in in the chat,
      so a waiting prompt is still the first thing ↑ offers after Claude Code has taken an earlier
      one and the chat has moved that one down to its answer
- [x] `sessions.send` answers with the id the prompt has in the chat, kept in `sentQueue`, so a
      prompt can be taken out of the queue even in the moment before its row reaches the chat
- [x] Pasting from a word processor inserts the text, not a picture of it: the app only takes an
      image from the clipboard when the clipboard carries no text
- [x] Verified live in the dev instance: with the chat holding [A, C(queued), B(registered)] — the
      order that follows a take — ↑ recalled C and withdrew it (host queue empty, toast shown); a
      synthetic paste of text+picture inserted the text and attached nothing, a picture-only paste
      attached the image

### v1.0.14
- [x] A prompt the CLI takes off its queue is moved to the end of the chat
      (`TranscriptState.moveToEnd`, emitted as a removal followed by the message again), so it sits
      directly above the answer it starts instead of in the middle of the previous answer, where it
      was typed; `takePrompts` runs before `transcript.apply` so it gets there before the first row
      of the new turn
- [x] Prompts still waiting stay in the block at the very bottom, below the answer being written
- [x] The prompt-state mark and the waiting-block header are 13px semi-bold instead of ~11px
- [x] The transcript fallback (prompts replayed from an earlier run) reads a prompt as answered when
      an answer of Claude's own follows it, and as unfinished only when the CLI's
      `[Request interrupted…]` notice follows; missing turn footers no longer make a whole reloaded
      chat read "sent", because footers are drawn by this app and are not in the CLI's record
- [x] Verified live in an isolated instance (haiku, sandbox/hello, port 45199) with a probe
      recording the order of every row: while a turn runs the queued prompt is the last row of the
      chat; when the CLI takes it, it moves below the previous turn's footer and its answer streams
      under it; an interrupted prompt still reads "sent"; a reloaded chat reads "answered"

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
