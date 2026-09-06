# Changelog

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
