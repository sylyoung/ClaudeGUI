# ClaudeGUI colour plan (proposal for the user to decide)

Status: proposal, nothing below is implemented except the parts marked **done** (1.0.3 / 1.0.4 / 1.0.6).
Every item is independent: accept, change or reject it on its own. Colours follow the macOS
system palette in light and dark variants (the same ones used for the accent colour), so the app
keeps its native look.

## A. Sidebar rows (one chat)

| # | Element | Proposal | Style options |
|---|---------|----------|---------------|
| A1 | State (left bar + marker + state word) | **done (1.0.6)**: seven states with printed markers — `...` working (blue), `!` permission (amber), `Q` option (red), `N` unread (pink), `↻` idle with tasks (teal), `·` idle (grey), `○` not running (grey), `×` error (red) | settled by the user in 1.0.6 |
| A2 | Group membership | **done (1.0.4)**: a coloured rail along the whole group section, group name in the group colour, coloured tag in the Recent view | a) keep; b) also tint the row background very lightly with the group colour (4 %); c) coloured left rail per row instead of per section |
| A3 | Unread badge | **done (1.0.6)**: pink, the colour of the unread state | settled |
| A4 | Selected rows (multi-selection) | **done (1.0.4)**: accent outline + light accent fill | a) keep; b) checkbox column instead of an outline |
| A5 | Pinned | grey pin icon (current) | a) keep; b) pin icon in the accent colour |
| A6 | Time since your last prompt | grey (current) | a) keep; b) turns amber after 24 h, red after 7 days (so stale chats stand out) |

## B. Statistics bar

| # | Element | Proposal | Style options |
|---|---------|----------|---------------|
| B1 | Counts | **done (1.0.4)**: number in the state colour, zero counts dimmed | a) keep; b) filled coloured pills; c) coloured only when non-zero |
| B2 | "needs input" and "error" when > 0 | **done**: light amber / red background | a) keep; b) pulsing like the row dots; c) no background |
| B3 | Tasks (shells / subagents) | blue terminal icon, purple robot icon (current) | a) keep; b) also a coloured count |

## C. Chat header, configuration row and status row

| # | Element | Proposal | Style options |
|---|---------|----------|---------------|
| C1 | State pill next to the title | **done**: same six colours as the sidebar | a) keep; b) drop the pill (the sidebar row already shows it) |
| C2 | Configuration row (model / permissions / effort) | neutral grey controls (current) | a) keep; b) colour the **permission mode** by risk: green default/plan, amber acceptEdits/auto, red dontAsk/bypassPermissions; c) colour the **model**: Fable purple, Opus blue, Sonnet teal, Haiku green |
| C3 | Status row: group tag | **done (1.0.4)**: group colour | a) keep; b) coloured pill with light background |
| C4 | Status row: git branch | grey (current) | a) keep; b) amber when ahead/behind the remote, red on conflicts |
| C5 | Status row: folder size | grey (current) | a) keep; b) amber above 5 GB, red above 20 GB (thresholds adjustable) |
| C6 | Context bar | **done (1.0.6)**: the rule of the user's terminal status line — green up to 200k tokens, yellow up to 500k, red above, red also from 85 % of the window, in #3fb950 / #d29922 / #da3633 | settled |
| C7 | Header action buttons | grey icons, accent when "on" (folder panel, pin) | a) keep; b) coloured per action (Terminal black/green, Finder blue, editor purple, GitHub black) |

## D. Messages

| # | Element | Proposal | Style options |
|---|---------|----------|---------------|
| D1 | Your messages | accent-tinted bubble (current) | a) keep; b) group-coloured bubble; c) plain |
| D2 | Tool cards by kind | neutral cards, coloured border only on error (current) | a) keep; b) coloured left edge per tool kind: Bash grey, Read/Grep/Glob blue, Edit/Write amber, Agent purple, Web green, TodoWrite teal |
| D3 | Permission prompts | amber card (current) | a) keep; b) amber for normal requests, red for destructive commands (rm, git push --force, …) |
| D4 | Thinking blocks | grey italic (current) | a) keep; b) purple accent bar |
| D5 | Results / turn footer | grey; red on error (current) | a) keep; b) green check on success |

## E. Files and Git panels

| # | Element | Proposal | Style options |
|---|---------|----------|---------------|
| E1 | Git status letters and file names | **done**: M amber, A green, D red, U grey, conflicts red | a) keep; b) colour the whole row background lightly |
| E2 | Folders | blue folder icon (current) | a) keep; b) folder icon in the group colour |
| E3 | Files edited by Claude in this session | no marking (current) | a) keep; b) accent dot next to files Claude changed during the current session |
| E4 | Tasks panel | blue shells, purple subagents (current) | a) keep; b) green when finished, red when failed |

## F. Window-level

| # | Element | Proposal | Style options |
|---|---------|----------|---------------|
| F1 | Accent colour | follows macOS (current) | a) keep; b) fixed Claude orange |
| F2 | Active chat highlight in the sidebar | accent (current) | a) keep; b) group colour |
| F3 | Dock badge | red (macOS default) | a) keep; b) none |
| F4 | Toasts | blue info, green success, red error (current) | a) keep |

## How to answer

Reply with the item numbers and the letter you want, for example `A2 b, C2 b, D2 b, rest keep`.
Anything not mentioned stays as it is. Thresholds (A6, C5, C6) can be given as numbers.
