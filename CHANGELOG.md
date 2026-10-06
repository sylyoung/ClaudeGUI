# Changelog

## 1.0.59 — 2026-10-06

### Rewinding no longer stops background tasks

- A rewind used to restart Claude Code at the chosen prompt, and the restart ended every background
  task of the chat: shell commands, monitors, subagents. A running Claude Code is now taken back in
  place, with the same request Claude Code's own rewind uses, so its background tasks keep running.
  The conversation is cut the same way, and a chat resumed later sees the rewound conversation.
- Prompts still waiting in the queue are taken back before the rewind, as the restart dropped them.
- A rewind still restarts Claude Code when it is not running, when the prompt is older than the
  last compaction, or when Claude Code declines to rewind in place. The rewind window says whether
  Claude Code is taken back in place, and how many background tasks a restart for an older prompt
  would end; the message after a rewind says whether Claude Code was restarted.

### Approval requests are logged

- Each approval request is written to the session host's log with the tool, the chat's permission
  mode and the reason Claude Code gives. In bypass mode Claude Code still asks for a few things
  (rules that say "ask", tools that always ask, some safety checks); the log line tells which one it
  was.

## 1.0.58 — 2026-10-06

### The repository's history starts here

- Earlier versions are no longer published; this version is the repository's first commit. Version
  numbers go on from the earlier ones, so an installed copy finds this update as usual.
- The app works as 1.0.57 did, apart from its bundle id, now `io.github.sylyoung.claudegui`. macOS
  takes the updated app for a new one, so it may ask once more for permissions granted before
  (notifications, and any folder, accessibility or screen access).
- Code comments and the README no longer refer to one particular proxy setup.
