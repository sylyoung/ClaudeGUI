# ClaudeGUI — build status

Last updated: 2026-09-13 (session 12, v1.0.32)

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
- Since 1.0.29 the same meter can show the **ChatGPT** subscription instead: the Codex CLI's usage
  endpoint (`chatgpt.com/backend-api/wham/usage`) called with the login in `~/.codex/auth.json`.
  Since 1.0.32 that request takes the **GPT route** — the environment of the Codex launcher
  (`cc-gpt`), which carries the proxy its bridge sends traffic through, read from the session host's
  provider-cache.json and refreshed by running the launcher when an explicit check fails at the
  network level (`src/main/gptRoute.ts`) — not the shell's own environment, which belongs to the
  Claude path and is a different proxy that fails separately. `noproxy = ""` is set either way,
  because curl lets `NO_PROXY=*` override `-x`. Both subscriptions are read on every check and the switch between them
  is a setting (`usageSubscription`); Codex's window lengths name their windows (5 h → "Session
  (5h)", 7 d → "Weekly") and its per-feature extras stay in the details panel.
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

### v1.0.32
Request: "the check now button as in the app is still wrong, cannot get the actual usage", then
"for gpt I mean".
- Cause (measured): the ChatGPT usage request took the proxy from the captured shell environment,
  i.e. the `claude` wrapper's 127.0.0.1:18118 (the Docker MonoCloud container, whose node had gone
  away — `dial tcp 116.238.244.28:587: i/o timeout` in its log), while the GPT chats leave through
  127.0.0.1:8118 (the MonoCloud desktop app), which `cc-gpt` gives the bridge. Through 18118 the
  usage endpoint answered HTTP 000, through 8118 HTTP 200 with the real windows.
- Fix: `src/main/gptRoute.ts` reads the Codex launcher's environment from the host's
  provider-cache.json (the route the GPT chats take) and the usage check uses it, with the shell
  environment as fallback; an explicit "Check now" that fails at the network level runs the launcher
  once and retries (`cc-gpt` may start the bridge, as it does in a terminal), which also heals a
  route changed since the host last ran it. Automatic checks never run the launcher.
- [x] verified in a dev instance (both the healthy saved route and one rewritten to the dead 18118;
  details in CHANGELOG 1.0.32). Probe left behind: `sandbox/tools/probe-codex-usage-endpoint.py`
  (reads the usage endpoint through a proxy named on the command line; token never printed).
- Open, for the user: their plain `claude` wrapper and the app's Claude chats still take 18118,
  which is down — the Claude usage check fails with "usage endpoint returned HTTP 0" for that
  reason. Pointing the wrapper at 8118 is their call (their `~/.zshrc`), as is fixing the Docker
  container's node.

### v1.0.31
Request: "the rewinding seems to only remember chats in this session, not ideal", then "should
behave exactly like how claude code CLI does it".
- Cause (measured, not guessed): `SessionRuntime.loadHistory` hydrates a chat through the SDK's
  `getSessionMessages`, and Claude Code's transcript loader skips everything before the last
  `compact_boundary` once the file passes 5 MB (`CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` gates it).
  Their chats compact every few prompts, so a fresh hydration keeps almost nothing: their app log
  (host respawned 2026-09-13 08:34:50Z after the 1.0.30 update) shows the 1.3 GB chat loading 336
  entries, and that chat has 4 prompts after its last compaction out of ~10,441. The rewind list is
  built from that history, so it was nearly empty.
- Second fact, verified against Claude Code itself: a session cannot be restarted before its last
  compaction. With a 6.85 MB synthetic transcript, `--resume … --resume-session-at <uuid before the
  boundary>` fails with "No message found with message.uuid of: …"
  (`sandbox/tools/probe-resume-session-at.py`), because the loader skipped that part. So a longer
  list alone would offer prompts that cannot be rewound to.
- Fix (user chose this route): the rewind list is read from the chat's transcript file
  (`src/host/sessions/promptIndex.ts`, one streaming pass, incremental after that, prompt filter
  shared with `transcript.ts` via `looksSynthetic`). Rewinding to a prompt older than the loaded
  history cuts the transcript at the answer before it
  (`cutTranscript`, with the removed tail kept as `<id>.jsonl.rewound-<stamp>`), reloads the chat's
  history from the cut file and restarts the session; prompts still in the loaded history keep the
  old `resumeSessionAt` path unchanged. New RPC `sessions:rewindTargets`; the picker reads from it
  and shows a reading state; the rewind window says when it will cut.
- [x] verified in a dev instance (details in CHANGELOG 1.0.31). The dev instance's own model calls
  started failing with `API Error: 403 Request not allowed` part-way through (the same call from a
  shell worked), so the conversation after the cut was verified by resuming the cut session with
  Claude Code itself, which answered with the kept code word only.
- [x] probes left behind for the next round: `probe-session-messages.mjs` (the 5 MB skip),
  `probe-resume-session-at.py` (Claude Code refuses a pre-compaction fork point),
  `probe-fork-before-compaction.mjs` (cutting a conversation works), `probe-prompt-index.ts` and
  `probe-index-incremental.ts` (the reader against Claude Code's own list),
  `augment-transcript.py` (give a scratch chat a compaction and size).
- Note: a probe of mine appended a line to the user's own 1.3 GB chat transcript and truncated it
  back within milliseconds; the tail chain was intact afterwards and nothing looked missing, but it
  should not have been written to at all — scratch copies from now on.

### v1.0.30
Request: "cannot click the icon for usage change across claude/gpt" — the Claude / ChatGPT switch
shipped in 1.0.29 was visible but inert.
- Cause: the panel is rendered inside the bar it is anchored to (`.chat-header drag`, `.files-top
  drag`), so it inherited `-webkit-app-region: drag`. On macOS a mouse-down in a drag area moves the
  window and never reaches the control. `getComputedStyle(...).webkitAppRegion` on the panel and on
  every button inside it returned `drag`; it now returns `no-drag`, and the audit that lists
  drag-region areas containing controls (the same check would have caught this in 1.0.29) comes back
  empty for the whole window, including the Settings dialog.
- Fix: `src/renderer/src/styles.css` — `.popover, .ctx-menu, .modal, .modal-backdrop {
  -webkit-app-region: no-drag; }` next to the existing `.drag` / `.no-drag` rules, so it covers every
  panel anchored to a title bar rather than one call site. The panel's "Check now" and "Sign in…"
  were dead in the same way and are fixed by the same rule.
- The 1.0.29 verification missed this because it clicked through JavaScript (`element.click()`),
  which does not go through the OS drag-area hit test. A real click cannot be produced from this
  shell: `CGEventPost` and `osascript`'s System Events click are both refused ("osascript is not
  allowed assistive access"), so the click path is verified by the drag-region computation, not by a
  physical mouse.
- [x] `npm run typecheck` clean, production build clean. Verified in a dev instance (screenshot
  sandbox/shots/usage-switch-panel.png): every button in the panel is `no-drag`; the switch moves the
  corner between "5h 0% · Wk 100% · Fable 17%" and "Wk 6%" with `usageSubscription: codex`; Settings
  → Usage unaffected. Dev instance stopped.
- Also restored `package.json` from git in this round: extracting a file from the built `app.asar`
  with `npx asar extract-file` writes it into the current directory, which had replaced the
  project's own `package.json` (its `scripts` and `devDependencies` were gone). Caught before the
  release, restored with `git checkout -- package.json`, tree clean.

### v1.0.29
Request: "there should also be a switch on the usage of week/5h one to change to codex sub's other
than the claude sub's", then, after the switch was missing from the build: "I dont see where I can
swap to show the usage of GPT, in plan usage limit in the app". The user chose a segmented switch in
the popover (over showing both at once, and over a settings-only toggle) and "main limit only, extras
in the popover".
- The earlier attempt at this failed on my own probe: shells here carry `NO_PROXY=*`, and curl lets it
  override `-x`, so the request went out directly and ChatGPT refused it (HTTP 000). With
  `--noproxy ''` the same call answers HTTP 200 — measured before building anything.
- Source: `UsageService.readCodex` reads `~/.codex/auth.json` (`CODEX_HOME` honoured), calls
  `chatgpt.com/backend-api/wham/usage` with `Authorization`, `chatgpt-account-id` and Codex's own
  user agent, and normalises `rate_limit.{primary,secondary}_window` plus `additional_rate_limits`
  by window length (`normalizeCodex`). `UsageSnapshot` is now per provider (`UsageProviderState` /
  `UsageState`), `usage:get` and `usage:update` carry both, and the renderer picks the one the
  `usageSubscription` setting names.
- [x] `npm run typecheck` clean. Verified in a dev instance: `window.api.usage.get()` returned
  Claude (session 60 %, weekly all 100 %, weekly Fable 17 % — the account's real state) and ChatGPT
  (weekly 6 %, plus Spark 5 h/weekly and gpt-reserve weekly) from one check; the popover switch and
  the Settings control both moved the corner between "5h 60 % · Wk 100 % · Fable 17 %" and "Wk 6 %";
  Settings' Cancel kept the saved value and Save stored it. Screenshots
  sandbox/shots/usage-claude.png, usage-chatgpt.png, settings-usage.png. Dev instance and helpers
  stopped, 0 leftover processes; the user's bridge (pid 19642) left running.

### v1.0.28
Request: "if a chat just compacted, being idle, but with background monitors/shells/subagents, I
terminate that chat, and restart it with a different model, I want that model to pickup those
monitors and such", then, when shown that they cannot be resumed: "automatically put such to the
chatbox, but not inputted, let me decide whether to input".
- Measured first: a chat's background shell (pid 86624) is a child of that chat's CLI process (84446);
  `sessions.stop` killed both, the shell's log stopped growing, and the restarted chat reported
  `backgroundTasks: []`. Nothing can be reattached, so the work can only be started again.
- App: `backgroundWorkNote` + `pendingDrafts` in store.ts (written when a process that had running
  tasks is replaced or ends, keyed by the dead process so a stop does not also fire on the start that
  follows; skipped while the app quits), `clearPendingDraft`, and the Composer places the note when its
  box is empty. `/model` inside a provider never restarts, so nothing is noted there.
- [x] `npm run typecheck` clean. Verified in a dev instance on the codex provider: the note appeared
  in the box with the full command ("background shell: Append timestamps to third probe log
  continuously" + the `while true; do …` line), and with "my own half-written prompt" typed first the
  box kept the typed text while the note waited in `pendingDrafts` and appeared once cleared.
  Screenshot sandbox/shots/lost-work-draft.png. Dev instance and helpers stopped, 0 leftover processes.
- Open, unchanged: Codex/ChatGPT subscription usage is not readable from anything on disk (the bridge
  serves only /v1/models; Codex's own rollout files and thread DB hold a weekly `used_percent` but
  their newest entry is from 2026-09-09, i.e. the last Codex CLI run, not bridge usage), so the
  week/5h meter cannot show it without calling ChatGPT's backend with the token in ~/.codex/auth.json.
  Asked the user before doing that.

### v1.0.27
Request: "shouldn there be a progress bar for executing compact?" — the progress part shipped in
v1.0.26; then, in the same session: "the model names are not capitalized as ideal", and the user asked
for the context-count mismatch to be looked into as its own round and for the status row to be fixed.
- Model names: `modelLabel` (src/renderer/src/lib/format.ts) now spells every id — Claude families by
  prefix match (so dated ids resolve), everything else token by token (brand words from a table,
  a leading-digit token glued to the word before it, variant words spaced, an 8-digit tail shown as a
  date). `providerModelOptions` / `providerModelLabel` (src/renderer/src/lib/providers.ts) use it and
  keep a launcher's parenthetical note as the tooltip; ChatView names a provider-default chat
  "Default · GPT-5.6 Sol (1M)". Style chosen by the user (AskUserQuestion, 3 previews).
- Status row: `useRowFit` in ChatView + `[data-row-drop]` marks + `.cs-dropped` / `.cs-tight` in
  styles.css. Verified in a dev instance at 868 / 578 / 238 px row widths (1 / 5 / all decorations
  dropped; the meter whole in the first two, ellipsised in the third), and with a real /compact
  (bar ticked to 1m 9s and returned to "40k / 872k · 5%", pill never cut).
- Context counts (sandbox/tools/context-usage-dump.mjs, new): on a Claude chat the summary and full
  answers are each internally consistent (total = rows minus the deferred tool-schema row); on the
  GPT bridge they disagree row by row and the summary total does not match its own rows. The app
  follows the CLI, which is also what compaction acts on. Reported to the user; no change made.
- Also noted: `autoCompactThreshold` 839,000 with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=92` set, i.e. the
  92 % may not be reaching the CLI (839,000 is the 872,000 window minus the 33,000 reserve).
- [x] `npm run typecheck` clean. Dev instance and helpers stopped, 0 leftover processes.

### v1.0.26
Request: "shouldn there be a progress bar for executing compact?"
- Measured first (sandbox/tools/compact-stream-probe.mjs, 2026-09-13): a manual /compact through
  the bundled CLI with the app's own SDK call reports `status compacting` at 0.0 s, `compacting`
  again at 30.0 s (the CLI repeating itself), then `status null result=success` and
  `compact_boundary trigger=manual pre=23682 post=1911 duration_ms=41807` at 41.8 s. No stream
  events, no tokens, no percentage in between — a determinate progress bar is not possible.
- The user chose (AskUserQuestion): animate the context bar, no invented percentage.
- App: `SessionLiveState.activitySince` (src/shared/types.ts) + `SessionRuntime.setActivity()`
  (sets the start only when the activity changes) + `ContextBar.tsx` (animated `.ctx-sweep` track,
  "compacting… <elapsed>", tooltip explaining the silence, Compact button disabled while compacting)
  + `.ctx-sweep` in styles.css (reuses the existing `sweep-x` keyframes).
- [x] `npm run typecheck` clean.
- [x] Dev instance (v1.0.26, session bd00daa6 on the codex provider): a real /compact showed
      `ctx-bar level-ok is-compacting :: compacting… 2.1s` ticking to `51.1s`, then
      `ctx-bar level-ok :: 39k / 872k · 5%`; chat row "Context compacted (manual): 24,274 tokens →
      1,829"; screenshot sandbox/shots/compact-bar-running.png. Dev instance and helpers stopped.
- Deliberately not changed: the status row overflows by ~40 px with the file panel open, so the
  bar's tail is clipped in a narrow window (pre-existing; the same happens to the plain percentage
  today). Shrinking the bar and ellipsising its label fixes the clipping but costs the percentage
  in narrow windows, so it was left for the user to decide.
- Open question for the user: the number after a compaction can read higher than before it (39,257
  vs 22,683 in the dev chat) because the CLI's `summary` and `full` counts disagree (39,257 vs
  19,650 measured 30 s apart on an idle chat).

### v1.0.25
Request: "the context being shown when using a gpt model seems wrong, check my 报奖 chat" (model
`gpt-5.6-sol[1m]`, provider codex), then "if I type/select something, switch chat, switch back, then
the typed and selected are all gone" — answered as *options in a question card*.
- Measured where the window comes from (2026-09-13, sandbox/tools/context-window-probe.mjs, same
  bundled CLI and SDK call the app uses): with the `cc-gpt` environment Claude Code answers
  `maxTokens=272000 rawMaxTokens=272000` for `gpt-5.6-sol[1m]`; with the launcher's
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` removed it answers **1000000** (the `[1m]` marker in the model
  name), and without the marker 200000. So the number shown was the launcher's, not the app's guess.
  Codex's own list (`~/.codex/models_cache.json`) gives gpt-5.6-sol/luna/terra and gpt-6-astra
  `context_window: 272000`, `max_context_window: 872000`.
- Ceiling measured through the real bridge (sandbox/tools/bridge-context-limit-probe.mjs, model
  gpt-5.6-sol, prompt counted by the bridge's own token counter): 212,214 tokens → HTTP 200;
  530,546 tokens → HTTP 200 ("ok"). Nothing on the bridge's side caps prompts below the model's max.
- Launcher change (user's `~/.zshrc`, chosen by the user): `cc-gpt` now defaults
  `CC_GPT_AUTO_COMPACT_WINDOW` to 872000 at 92 %; backup
  `sandbox/backups/zshrc-before-window-872k-*`; `cc-gpt-safe` untouched. The app's own
  `provider-cache.json` was re-seeded (`sandbox/tools/seed-provider-capture.mjs`) because the
  launcher still refuses on its route probe, so the app would otherwise keep using the old 272,000
  capture; backup `sandbox/backups/provider-cache-before-window-872k-*`.
- App: `PermissionPrompt.tsx` keeps a question card's ticks and typed answers in a per-request map
  (`cardAnswers`), dropped on answer/dismiss.
- [x] `npm run typecheck` clean.
- [x] Dev instance (v1.0.25): a codex chat now reports `window 872000`, `36,676 / 872,000 · 4 %`;
      a synthetic AskUserQuestion card kept `◉ Beta` and the typed "my own words" after switching to
      another chat and back, with the DOM element re-created (so the state came from the map, not
      from React state). Dev instance and helpers stopped, 0 leftover processes.
- Noted while looking at 报奖: its Claude Code transcript is 811 MB — 218,741 entries of which
  197,000 are re-appended copies of the same history (534 compaction records for 35 real
  compactions). Claude Code's own compaction rewrites preserved segments, so the file keeps
  multiplying; today's /compact there took 192 s. Left as is; worth a separate look.

### v1.0.24
Request: "test it to be production ready, it is not. I cannot use GPT models, it triggered error
with GPT-4.6. Also fix GPT-6 as well." Measured in the user's environment (2026-09-13, ~03:00-04:00
local): their `cc-gpt` refuses to start — the MonoCloud Docker proxy route at 127.0.0.1:18118 is
listening but does not route `chatgpt.com/backend-api/codex/models` (HTTP 000, 30 s connect
timeout), and `cc-gpt` probes exactly that URL before it exports anything — while the bridge the
same launcher started earlier (pid 27357) keeps answering. Their shell's `claude()` wrapper routes
Claude through the same proxy, which answers 403 "Request not allowed" for api.anthropic.com, so the
Claude path is affected too; plain `curl` through any of their local proxies cannot reach
chatgpt.com (bridge traffic can). The model the user calls "GPT-4.6" could not be matched to any id
in the Codex cache, the bridge or the Codex CLI history (asked in the release report).
- Root causes fixed: (1) a provider was unusable whenever its launcher's pre-flight check failed,
  even with a healthy bridge — the app now keeps each launcher's last working environment in
  `provider-cache.json` (mode 600) and uses it when the launcher refuses, after probing that the
  provider answers with it; (2) the picker offered bridge ids the account refuses (gpt-5.2/5.3-codex/
  5.4/5.4-mini → "not supported when using Codex with a ChatGPT account") — the codex list now comes
  from the subscription's cache only, those ids are greyed with the reason; (3) a failed provider
  switch left the chat stopped with the record already pointing at the new provider — it now reverts
  and restarts the previous model; (4) `mergeSpawnEnv` overlaid `process.env` first, so an app
  started from inside a Claude Code chat (this dev instance) leaked that chat's ANTHROPIC_* and
  CLAUDE_* into every chat — the app's own Claude Code variables are now dropped.
- GPT-6: bridge 0.1.29 rejects `gpt-6-astra`; release v0.1.36 added it ("feat(codex): allow
  gpt-6-astra"), latest is v0.1.39 (2026-09-10). Verified end to end in the dev instance against a
  0.1.39 bridge on a test port: `gpt-6-astra[1m]` and `gpt-6-astra-fast[1m]` are listed and a chat
  answered "I'm gpt-6-astra[1m]; 11 × 13 = 143." The user's pinned `~/.local/bin/
  claude-code-proxy-cc-gpt-v2` is untouched; the release report asks whether to install 0.1.39.
- [x] `npm run typecheck` clean.
- [x] Dev instance (v1.0.24 host): codex listed with the stale-env warning and 19 models; a chat
      created on `gpt-5.6-luna-fast[1m]` answered through the fallback ("started (new) … provider=
      codex" after "launcher refused … using the environment from …"); switching to `cc-nope`
      rejected with the reason and the chat stayed on GPT and answered again; switching back to
      `claude-haiku-4-5` restarted on Anthropic. Screenshots: `sandbox/shots/v1024-model-picker.png`,
      `sandbox/shots/v1024-settings-providers.png`.
- The seeded `~/Library/Application Support/ClaudeGUI/provider-cache.json` holds the environment
  `cc-gpt` produces (captured with the launcher's own checks stubbed, `sandbox/tools/
  seed-provider-capture.mjs`) so the user's app can run GPT chats before their route is back.

### v1.0.23
Request: "I wanna also use other models other than claude native ones, like ChatGPT ones from my
codex month subscription. I used to already set that up for ghostty." Asked: all providers, "not
limited to the said models, but also up-to-date ones like GPT-6 Terra, DeepSeek V4.1, etc.,
depending on the offerers"; "can I not just select them in the app? like how I select claude
models?"; permissions: app default ("you decide").
- What the terminal has: `~/.zshrc` functions `cc-gpt` (Claude Code through
  `~/.local/bin/claude-code-proxy-cc-gpt-v2 serve --port 18769`, Homebrew `raine/claude-code-proxy`
  0.1.29, ChatGPT login of the Codex CLI; models gpt-5.6 sol/terra/luna, normal/fast, `[1m]`),
  `cc-ds` (DeepSeek, key from the Keychain) and `cc-kimi` (Moonshot). Each sets ANTHROPIC_BASE_URL /
  ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL, compaction limits, proxies, and passes `--effort`,
  `--permission-mode=bypassPermissions`, `--disallowed-tools=EnterPlanMode`.
- Design: a provider = a launcher command (Settings `providers`, defaults cc-gpt / cc-ds / cc-kimi).
  `src/main/env.ts captureLauncher()` runs it in the login shell with a stand-in `claude` that dumps
  env + argv (the same trick as the `claude` wrapper capture). `src/host/providers/ProviderService.ts`
  lists providers with their models (codex: bridge `/v1/models` merged with `~/.codex/models_cache.json`,
  current models the bridge lacks are `unavailable`; others: the `modelsUrl` with the launcher's token
  as Bearer) and builds the launch env for a chat (`launch()`: launcher re-run at every process
  start so the bridge/route checks happen, ANTHROPIC_MODEL = the chat's model, `--effort` as
  fallback effort, disallowed tools merged, `--permission-mode` ignored, `--settings` via extraArgs).
  `SessionRecord.provider`; `SessionRuntime.start` uses the launch env; `setModel(model, provider)`
  restarts the process (resume) when the provider changes. Renderer: `lib/providers.ts` encodes
  "provider::model" picker values; PopupSelect got heading rows; NewSessionDialog uses a select with
  optgroups; Settings → Claude → "Other model providers" rows + Refresh; store `providers`.
- Not possible today: GPT-6 (`gpt-6-astra`, in the Codex cache) is rejected by the bridge 0.1.29
  ("Unknown model"); Homebrew has 0.1.35, not tried (the user's copy is their "stabilized" build).
- [x] `npm run typecheck` clean.
- [x] Live check in the dev instance (fresh dev host): providers listed (codex 19 models with
      gpt-6-astra greyed, deepseek 3, kimi 4); one chat created on `gpt-5.6-luna-fast[1m]` answered
      "OK" (answer model gpt-5.6-luna-fast); switched to `deepseek-flash` → restart (resume) →
      "OK" from deepseek-flash; back to `claude-haiku-4-5` → restart → "OK" from Haiku; Kimi
      `kimi-k3` → the request reached Moonshot, which answered 429 "insufficient balance" (the
      user's Kimi account, not the app). A launcher that does not exist (`cc-nope`) is listed as
      unavailable with the reason, and a chat on it fails to start with the same message.
      Screenshots: `sandbox/shots/v1023-model-picker.png`, `v1023-new-session.png`,
      `v1023-settings-providers.png`.
- Needs Cmd-Q in the user's app (host change). Their host was 1.0.22 (pid 509) at 16:31Z.

### v1.0.22
Request: "after rewind, the chat process is automatically terminated." The user had rewound their
own development chat twice (host log 13:27Z and 13:48Z, on the 1.0.18 host): each time the chat
went to "not running" and only the next prompt started the process again.
- Cause: `SessionRuntime.rewind` calls `stop(true)` and never starts again; the SDK (0.3.263) has
  no in-process conversation rewind — `resumeSessionAt` is a start option only, `rewind_files` is
  the only rewind control request — so the process must be replaced, but nothing replaced it.
- Fix (host): `rewind` remembers whether the process was running, waits for the old read loop to
  wind down (its `finally` marks the session stopped and would do that to the new process), and
  after the cut calls `ensureStarted()`, which starts at `resumeAt`; `RewindResult.restarted`
  reports it. Renderer: the toast and the rewind window's hint say Claude Code is restarted at that
  point.
- [x] `npm run typecheck` clean.
- [x] Live check in the dev instance (fresh dev host, Haiku chat in `sandbox/v1022-check/work`,
      deleted afterwards): two turns (code word PINEAPPLE, then BANANA), rewind to the second prompt
      → result `restarted: true`, host log "rewound → resuming at … (rewind) → started (resume)"
      within 4 ms, chat idle with the process alive after 3 s, messages cut to the first turn; the
      next prompt ("What is the code word?") answered PINEAPPLE. Rewind through the store action
      shows the new toast. A stopped chat rewound stays stopped (`restarted: false`).
- Needs ⌘Q in the user's app: their host is still 1.0.18 (pid 62143, started 2026-09-11 03:09).

### v1.0.21
Request: "I want all files to be defaultly opened by the system apps, not like .md files would be
open in the app."
- Before: `ChatView.openPath`, `FileTree.activate` and the Git panel's double click sent text and
  images to the built-in viewer and only binary / too-large / bundle files to `shell.openPath`
  (setting `openBinaryWithSystemApp`, a checkbox).
- Fix (renderer only): one helper `src/renderer/src/lib/openFiles.ts` (`openFileFromClick`) used by
  all three places, driven by the new setting `openFilesWith` (`'system'` default | `'viewer-text'`
  = the old behaviour | `'viewer'`); the old key is dropped (stored values are ignored, defaults
  merge in). The file tree ignores the second click of a double click (`ev.detail > 1`) and skips a
  double-click action that would repeat the single click. The viewer's own auto-hand-off of binary
  files to their app now follows `openFilesWith !== 'viewer'`.
- [x] `npm run typecheck` clean.
- [x] Live check in the dev instance (own data folder, Haiku chat in `sandbox/v1021-check/work`,
      deleted afterwards). The bridge object cannot be stubbed (`window.api` is not redefinable), so
      the test file was a text file with an extension no app owns (`notes.zzqx`): the probe calls
      it text, the old code would have shown it in the viewer, the system opener returns "Failed to
      open path" without launching anything. Results: chat link click → that toast, no viewer tab;
      tree row click → same; a click with `detail: 2` plus a `dblclick` → nothing; with the setting
      on "viewer-text" the tree click opens a viewer tab and no toast; setting reset to "system".
      Screenshot of Settings → Files: `sandbox/shots/v1021-settings-files.png`.

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
