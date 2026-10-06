# Changelog

## 1.0.60 — 2026-10-06

### Going from one of your prompts to the next

- Two buttons in the chat's bottom-right corner, ↑ and ↓, next to "latest": each press puts your
  previous or next prompt at the top of the chat and outlines it for a moment. Going further back
  than the part of the chat on screen reads the earlier messages in, as scrolling to the top does,
  so a whole chat can be walked prompt by prompt. A button is greyed out when there is no prompt
  further that way.

### Scrolling up no longer jumps

- Scrolling close to the top of a chat (but not right to it) read the earlier messages in and then
  threw the chat forward by their height, because the window kept the view in place and the app
  moved it once more. The app now moves it only by what is left to make up.
- The "latest" button was placed inside the scrolling list, so in a chat longer than the window it
  scrolled away with the messages. It now stays in the corner, next to the new buttons.

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
