# Changelog

## 1.0.10 — 2026-09-07

### Prompts that are waiting
- **A prompt is only marked as waiting while it really is waiting.** Claude Code often answers
  several queued prompts in one turn; the app used to count one prompt off per finished turn, so
  every folded-in prompt left a phantom entry behind and the chat could claim four prompts were
  waiting long after they had all been answered. The waiting list now comes from what Claude Code
  itself reports — which prompts a finished turn consumed, and how many of ours are still in its
  queue.
- **↑ takes a waiting prompt back out of the queue.** Recalling a prompt that has not been answered
  yet withdraws it from Claude Code, removes it from the chat and leaves its text in the input box
  for editing, instead of leaving a copy that gets answered while you type. If Claude had already
  taken it, nothing is withdrawn and the app says so.
- **A take-back button** on every waiting prompt (and an entry in its right-click menu) does the same
  without the keyboard.
- **The prompt history no longer lists the same prompt twice** while a turn is running.

### Fixes
- **↑ and ↓ keep walking the history even when the recalled prompt is a command.** Recalling
  "/compact" used to open the command menu over it, which then swallowed the next ↑; the menu now
  stays closed over recalled text until you edit it or move the caret yourself.
- **A /compact you asked for never marks the chat unread**, even when the compaction writes a summary
  — that summary is not an answer to read. An automatic compaction inside a real turn still counts
  as unread, because that turn also answered something.

### Session list
- **The state mark ("...", "!", "Q", "N", "·", "○") is centred on the whole two-line row** instead of
  on the chat name alone.
- **In the recent view the group is shown by the colour of the chat name**; the group name is gone
  from the second line, which now holds only the model and the state.

## 1.0.9 — 2026-09-07

### Writing prompts
- **Commands and skills are matched anywhere in a sentence**, not only when the message starts with
  "/". The menu opens for the "/word" the caret is in, wherever that is, and the chosen command
  replaces exactly that word, so "please run /comp" completes to "please run /compact " with the
  rest of the sentence untouched. A slash after a non-space character (a path such as `src/lib`, a
  date such as 12/3) does not open the menu, Escape closes it for that word, and ↑ ↓ ⇥ still pick.
- **↑ and ↓ keep walking your earlier prompts.** Until now the second ↑ only moved the caret; now,
  once you are walking the history, the arrows keep walking it, and typing or clicking in the box
  ends the walk and gives the arrows back to the caret.

### The chat
- **Prompts Claude has not taken yet stay at the bottom of the chat**, collected under a line that
  says how many are waiting, instead of being pushed up by the output of the turn that is still
  running.
- **Every prompt says what happened to it**, in words and in colour: "⋯ queued" in amber with a
  dashed bubble, "... being answered" in blue, "✓ answered" in green, and a grey "· sent" for a
  prompt whose turn was interrupted or stopped.
- **Buttons for tool details**: each tool card has its own show/hide button, and the chat header has
  one that expands or collapses the details of every tool operation in the chat at once.
- **Finishing a /compact no longer marks the chat unread** and raises no notification: compacting the
  context is housekeeping, not an answer. A turn that also produced an answer still counts as unread.

### Folder panel
- **The files can be ordered**: a button above the tree offers name A → Z, name Z → A, recently
  changed first, largest first, and grouped by type. Folders stay above files, the order applies to
  every folder in the tree, and it is remembered.

### Rewinding a chat
- **"Rewind the chat to here"** on your own prompts, from a button that appears when the pointer is
  over the prompt and from the right-click menu. It asks first what should be included and shows how
  many files would change before anything is done.
- The conversation is cut back to just before that prompt — for Claude as well, which is resumed at
  that point and no longer remembers what came after — and the prompt goes back into the input box
  so you can change it and send it again.
- **The files Claude changed since then can be put back** as they were. This needs the new
  "keep file backups" setting (Settings → Claude, on by default) and works for sessions started
  after it is switched on. If Claude Code refuses to cut its own transcript at that point, the files
  are still restored and the chat says plainly that Claude may still remember the removed messages.

## 1.0.8 — 2026-09-06

### Importing terminal sessions
- **The import window uses the whole screen height.** The list of Claude Code terminal sessions was a
  300-pixel box inside a small dialog (about seven rows); it now fills a dialog that is 88 % of the
  window height and 880 pixels wide, so roughly fourteen rows are visible and the scrolling is over
  the list itself, not the dialog.
- **Keyboard instead of scrolling**: ↑ and ↓ walk the list (Page Up / Page Down jump ten rows, Home
  and End go to the ends) while the filter box keeps the focus, so you can type a few letters and
  press Enter. The highlighted row is always scrolled into view, and it stops following the mouse
  for a moment after a key press so the list does not jump under the pointer.
- **Every row is exactly two lines**, title and folder truncated with an ellipsis instead of
  wrapping, which keeps the row height even and makes scrolling predictable.
- **The number of sessions is shown** next to the filter ("12 of 152 sessions").
- **A session that is already in ClaudeGUI opens instead of being imported again** when you click it
  or press Enter on it, rather than doing nothing.

## 1.0.7 — 2026-09-06

### Colours
- **Plan usage follows the terminal status line** as the context indicators already do: a limit turns
  amber from 50 % and red from 90 % (instead of 80 % / 95 %), in the same three colours (#3fb950,
  #d29922, #da3633). The amber threshold stays adjustable in Settings → Usage; a stored 80 (the old
  default nobody chose) is moved to 50 once, a value you set yourself is kept.
- **Tool cards are marked by kind** with a coloured left edge: shell grey, Read/Grep/Glob blue,
  Edit/Write/NotebookEdit amber, subagents purple, web green, notes and skills teal, questions red,
  MCP pink.
- **Requests that cannot be undone are red** instead of amber, with a "cannot be undone" tag: `rm -r`
  / `rm -f`, `shred`, force pushes, `git reset --hard`, `git clean -fd`, deleting branches or tags,
  `mkfs` / `dd` / `diskutil erase`, `DROP`/`TRUNCATE`/`DELETE FROM`, recursive `chown`/`chmod`,
  `killall`, anything with `sudo`, writing to a device, `npm publish`, `gh repo delete`, and writing
  an empty file over an existing one.
- **The model name is tinted** by family in the chat configuration row and in the sidebar rows:
  Fable violet, Opus blue, Sonnet teal, Haiku green.
- **The status row warns**: the git branch turns amber when the repository is ahead of or behind the
  remote and red when there are conflicts; the working-directory size turns amber above 5 GB and red
  above 20 GB.
- **Folder panel**: files Claude edited or wrote in this chat (subagents included) get an accent dot
  in the file tree, and background tasks are coloured by outcome — running blue, finished green,
  failed or killed red.

## 1.0.6 — 2026-09-06

### Session states
- **Seven states instead of the old six**, and each one is now printed as a marker that cannot be
  overlooked instead of a small coloured dot: `...` **working** (the three dots run one after the
  other, blue), `!` **permission** (a tool waits for your approval, amber), `Q` **option** (Claude
  asked you a question and waits for your choice, red), `N` **unread** (a finished turn you have not
  read, pink), `↻` **idle · tasks** (nothing to read, but background shells, monitors or subagents
  are still running, teal), `·` **idle** (grey), `○` **not running** (grey) and `×` **error** (red).
  The markers appear in the sidebar rows, the group headers, the statistics bar and the chat header.
- A chat that is idle **with background work** is now clearly separated from a completely idle one:
  teal `↻` versus grey `·`. Plain idle chats recede instead of being green.
- **Unread is a state of its own.** A chat whose last turn you have not read is pink, its name is
  bolder, and the unread count badge uses the same colour.
- Permission requests and questions are told apart: a question tool (AskUserQuestion) is "option",
  everything else that waits for approval is "permission".

### Chat
- **The working state is visible in the chat itself**: an animated line under the status row, a strip
  above the input box with `...`, what Claude is doing right now (generating, compacting, or the tool
  it is running), the time the tool has been running and the time since your prompt, plus a blue glow
  around the input box.
- **↑ recalls an earlier prompt.** With the caret at the start of an empty (or any) input box, ↑ walks
  back through the prompts of this chat — including prompts that were sent but not answered yet — and
  ↓ walks forward and finally back to what you had typed. Typing leaves the walk.
- **No cost after a turn.** The line that closes a turn now ends with the time the turn finished
  instead of the accumulated dollar amount ("26.4s · 3 turns · 1.2k out · 08:52"). Tokens and cost
  are still in its tooltip.
- **Renaming a chat works.** "Rename…" (chat menu) now puts the caret in the title and selects it,
  double-clicking the title does the same, Escape cancels and Enter saves. The sidebar has its own
  "Rename…" entry and renames in place (double-click the row name).
- **Commit and push from the chat**: the status row shows "N to commit" (opens the Git panel) and
  "push N" when commits are waiting for the remote, so neither needs the Git tab to be found first.
  The buttons in the Git panel wrap instead of being cut off in a narrow panel.

### Context colours
- The context indicators follow the **same rule as the Claude Code status line in the terminal**
  (`~/.claude/statusline-command.sh`): green up to 200k input tokens, yellow up to 500k, red above,
  in exactly those three colours (#3fb950, #d29922, #da3633). A window smaller than 200k tokens would
  never leave green with that rule alone, so a context at least 85 % full is red as well. The rule is
  written out in the tooltip of the context bar.

## 1.0.5 — 2026-09-06

### Fixed
- **"Update and restart" did not reopen the app.** After the helper had swapped the bundle, macOS answered `open ClaudeGUI.app` with LaunchServices error -600; the helper took that for a broken bundle, restored the previous version, and that `open` failed the same way, so no window came back while the session host and its Claude processes kept running. Cause: the session host was the app's own executable running in Node mode, which macOS registers as a running instance of ClaudeGUI. With the window closed, `open` tried to activate the host instead of starting the app. The same confusion could stop the Dock or Finder from reopening the app while a host from a closed window was alive.
- The session host now runs through the helper executable inside the bundle (`ClaudeGUI Helper.app`, its own bundle identifier, no Dock presence), so it is never mistaken for the app. A host started by an earlier version is replaced as before once its sessions have stopped (or from Settings → About).
- The relaunch helper asks for a new instance (`open -n`), retries, waits until the app has consumed the update marker, and as a last resort starts the executable directly. A verified bundle is no longer rolled back because of a launch error; the previous version is restored only when the new one does not come up at all, and a macOS notification tells you if nothing could be opened.
- The startup notice counts an update as applied when the running version is the target version or newer.

## 1.0.4 — 2026-09-06

### Sidebar
- Two views, switched with the Groups / Recent control at the top of the sidebar (⌘⇧V, also Settings → Appearance): **Groups** shows your groups with their sessions; **Recent** shows a Pinned section and then every other session. In both, sessions are ordered by the time of **your last prompt** (newest first) — Claude answering never moves a session. The previous manual order is still available (view options → "Manual order (drag to reorder)").
- The "ClaudeGUI" label at the top of the sidebar is gone.
- **Group colours**: every group has a colour (assigned automatically from the macOS palette when a group is created; existing groups get one on first launch). It marks the rail along the group in the sidebar, the group name, the group tag of each row in the Recent view and the group tag in the chat status row. Change it with the dot next to the group name, right-click → "Change colour…" (12 system colours + custom), or from the chat status row.
- Each row shows the chat name and, under it, the **model** (Fable 5.1, Opus 5, …), then the folder name only while that chat's folder panel is shown, then the state or last message.
- **Drag & drop rewritten** with pointer events: a small ghost follows the pointer and says what will happen ("Move to Papers", "Pin", "Place before this row"), the target group or row highlights, Escape cancels, the list auto-scrolls near its edges, and there is no more half-transparent browser ghost or "fly back" animation. In "last prompt" order dragging moves a session between groups (or pins / unpins it in the Recent view); in manual order it also reorders. Group headers can be dragged to reorder groups.
- **Multi-selection**: ⌘-click toggles a session, ⇧-click selects a range, ⌘⇧A or the view options select all, Escape clears. A toolbar above the list offers Start / Stop processes, Pin / Unpin, Archive and Move to group for the selection; right-click a selected row for the same menu. Group headers offer "Start / Stop all processes in this group".
- **Start all**: a button at the right end of the statistics bar starts every session that is not running, one after the other (staggered so the machine is not flooded); "Stop all processes" is in the view options and the Session menu.
- View options (sliders icon): order, archived sessions, folder header rows, new group, expand / collapse all groups, start / stop all, select all.

### Statistics bar (replaces the status board)
- One line above the chat: total sessions, then **how many are working, need input, idle with tasks running, idle, not running, in error** (numbers in the state colour, zero counts dimmed), the number of running background shells / subagents, unread turns, and the Start all button. Clicking a number jumps to the next session in that state (the tooltip lists them). ⌘⇧S hides it.

### Chat header
- Frequent actions are visible buttons instead of "…" entries: open the folder in Terminal, reveal in Finder, open in the editor, open the GitHub remote, show / hide the folder panel, pin / unpin, start / stop the process. "…" keeps rename, archive, move to group, change working directory, copy resume command and delete.
- **Model / permissions / effort on one line**: the closed controls show a short label (Opus 5, acceptEdits, xhigh) so the row never wraps; the open list shows the full text of every option with an explanation on hover. This rule applies to all option fields.
- A separate status row shows the group tag, the working directory (click: Finder, right-click: copy), branch with ahead/behind, remote (GitHub host omitted), folder size, the time of your last prompt, the last activity, and the context bar.
- **Folder panel per chat**: the files / tasks / git panel can be shown or hidden per chat (header button or ⌘⇧E) and the choice is remembered per chat.

### Data
- Sessions record the time of your last prompt (`lastPromptAt`); for sessions from earlier versions it is read once from the tail of their transcript. The model a process reports at start is remembered (`lastModel`) so it can be shown while the session is not running.

## 1.0.3 — 2026-09-06

### Sidebar
- Sessions keep their position: the list no longer reorders by activity. Drag a session to reorder it or drop it on a group header; pinned sessions stay at the top of their group; new sessions appear at the top of theirs.
- Groups (categories such as Papers, Utilities, Tasks): create them with the folder-plus button, rename by double-click or right-click, reorder (drag the header or Move up / down), collapse, delete (sessions are kept and become ungrouped). Every session menu has "Move to group"; the New session dialog has a Group field.
- Folder header rows are off by default, also for existing installs; each row shows its folder name inline instead. Settings → Appearance can turn them back on.
- Colour-coded states everywhere: working (blue, pulsing), needs input (amber, pulsing), idle with background tasks still running (teal), idle (green), not running (grey outline), error (red) — as a left bar, a dot and the state text of each row.
- Background shell / monitor counts (blue chips) and subagent counts (purple chips) are larger and coloured in the sidebar, the chat header and the status board.
- Picking a search result clears the search box; the box has a clear (×) button.

### Status board
- A strip above the chat shows every session as a chip with its state, task counts and unread count, grouped like the sidebar, plus a summary (n working, n need input, …). Click a chip to switch, right-click for the session menu. ⌘⇧S or Settings → Appearance toggles the board.

### Chat
- Toolbar: model, permission mode and effort show their full names ("Opus 5 (claude-opus-5)", "acceptEdits — accept file edits automatically", "xhigh — extra high"…). The estimated cost and the Claude version are gone; the toolbar shows the time of the last activity, the size of the working directory and the git remote (click to open it) with ahead/behind counts instead.
- Stop (⌘.) puts the prompt(s) of the interrupted turn back into the input box so they can be edited and resent. The input box has a clear (×) button.
- The slash-command menu ranks exact and prefix matches first: "/comp" lists /compact before /autocompact.
- A session whose folder was renamed or deleted shows a clear "folder not found" banner instead of a misleading process error. "Change working directory…" (banner or session menu) points the session at the new location and moves its transcript along, so the history is kept.

### Hover explanations
- Nearly every button, indicator, tab, option and status now has a tooltip explaining what it does (Settings → Appearance → Hover explanations).

### macOS permissions and signing
- Settings → Permissions lists the macOS privacy grants that matter for Claude's tools (Full Disk Access, Desktop / Documents / Downloads, iCloud Drive, external and network volumes, Accessibility, Screen Recording, Camera, Microphone, Automation of System Events / Finder / Terminal, Notifications, Local Network, Developer Tools, App Management) with their state, a Request button where the app can trigger the system prompt, "Request all", and a shortcut to the right System Settings pane for the ones that must be switched on by hand.
- The bundle carries usage-description strings for every protected resource, and the build is signed with an "Apple Development" certificate when one is in the keychain (electron-builder `type: development`), so grants survive updates. Without a certificate the build stays unsigned as before.

### Fixes
- The update restart of 1.0.2 could be ignored by Electron when triggered from inside the quit handler; the app now leaves the handler before quitting. The relaunch keeps ClaudeGUI's own environment overrides (isolated data folder, debug port) through `open --env`.

## 1.0.2 — 2026-09-06

### Session host (sessions survive app restarts)
- Claude processes are no longer children of the app window. A small background process, the session host, owns them; the window talks to it over a local socket. Closing or restarting the window (for example to apply an update) leaves every session, its background shells, monitors and watchers running, and the new window reattaches to them with their live state, pending permission prompts and transcript.
- Quitting ClaudeGUI (⌘Q) still stops all sessions, as before. A host started by an older app version is replaced automatically as soon as none of its sessions is running; Settings → About shows the host state and log.

### In-app updates
- ClaudeGUI → Check for Updates… (also Settings → About). Releases are the git tags of the ClaudeGUI repository. Updating checks the newest tag out into ~/Library/Caches/ClaudeGUI/update, installs dependencies when the lock file changed, builds the app bundle in the background while the current version stays usable, then swaps the bundle at the app's location and reopens it. Sessions keep running through the restart thanks to the session host.
- A pill in the top-right corner shows "Update x.y.z", "Building…" or "Restart to x.y.z". Options: restart automatically after the build, repository URL, build folder, update log.

### Remembered across restarts
- Window position and size, open files, expanded folders and the active right-panel tab per session, in addition to the settings and session list.

## 1.0.1 — 2026-09-06

### Files
- Files that are not text or images (Word, PDF, spreadsheets, macOS document bundles…) now open with their default macOS app when clicked in the file tree or in chat links. The viewer offers "Open with default app", "Open with…" (choose any application) and "Open in editor".
- Double-click action is configurable (default app / editor / viewer); ⌘-click or ⌥-click opens in the editor.
- File tree: exclude patterns, optional file sizes, optional auto-reveal of files Claude just edited, move to Trash / git rm from the context menu.

### Git
- New Git tab in the right panel: branch switcher, remote with ahead/behind counters, Fetch / Pull / Push, commit box (amend, sign-off, template, ⌘⏎), staged / changed / untracked / ignored / conflict sections with per-file stage, unstage, untrack, discard, add-to-.gitignore and delete actions, inline diff for the selected file, recent commits with revert / undo-last-commit / show details / open on GitHub.
- Stash, "Publish to GitHub…" through the `gh` CLI, "Initialize repository" for folders without git.
- Git status badges (M, A, D, U, R, i…) and colours in the file tree, with a dot on folders that contain changes. Status refreshes after file-system changes, when a turn finishes, on window focus and on a configurable timer; optional periodic fetch.

### Appearance
- Light, dark and "match macOS" themes. The default follows macOS; the dark palette is now a macOS-style grey instead of black.
- Accent colour: follows the macOS accent by default, or any of the nine system colours / Claude orange.
- Optional translucent sidebar (macOS vibrancy), interface and code font families and sizes, density, chat column width.

### Settings
- Settings are organised in tabs (General, Appearance, Claude, Files, Git, Usage & status, Advanced, About) with many new options: notification kinds and sound, Dock badge, resume sessions on launch, quit confirmation, default working directory, max turns, max thinking tokens, always-allowed / disallowed tools, settings sources, auto-title, thinking-block display, tool-card expansion, timestamps, tool-result truncation limit, debug server.

### Status
- Plan usage limits (5-hour session, weekly all-models, weekly per-model such as Fable, extra-usage credits) are shown in the top-right corner with the time of the last check; click for reset times, thresholds and a manual "Check now". Data comes from the same claude.ai usage endpoint the CLI's `/usage` uses, refreshed on a timer, after finished turns and from the rate-limit headers of every API response.
- Context window usage is explicit per chat: a bar in the toolbar with tokens / window / percentage and a popover with the `/context` breakdown, Recount and Compact buttons. The sidebar shows each session's context percentage and its background-task and subagent counts; the chat header shows the counts as clickable pills.

## 1.0.0 — 2026-09-06

- First release: multi-session manager for Claude Code with rendered chat, GUI permission prompts, clickable file / URL links, file explorer and viewer, background task tracking, session import from the terminal CLI, macOS notifications and Dock badge.
