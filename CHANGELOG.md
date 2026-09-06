# Changelog

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
