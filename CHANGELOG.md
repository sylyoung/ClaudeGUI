# Changelog

## 1.0.63 — 2026-10-13

### Dismiss the signed-out notice

- The Claude Code signed-out notice now has the same close button as the other login notices.
  Dismissing it hides it for the current window, including when switching chats or checking login
  status again. A later signed-out episode can show a new notice.
- Dismissing the notice does not change authentication or stop any chats.

## 1.0.62 — 2026-10-12

### A fast mode switch

- A "fast" chip next to model, permissions and effort turns fast mode on or off for the chat with
  one click; it is amber while on. Fast mode runs the same model with faster output and costs more.
  Every new chat starts with it off.
- On a Claude model it is Claude Code's own fast mode (its /fast), which Claude Code offers for Opus
  4.8 and the Opus 5 models. On a Claude subscription it is paid from usage credits rather than the
  plan's included usage. When Claude Code does not use it (for example because usage credits are not
  turned on), the chip gets a dashed border and its tooltip says why.
- GPT models use the same switch instead of separate "(fast)" models: the model list shows each GPT
  model once, and with the switch on the bridge's fast version of it runs in its place. A chat that
  was on a "(fast)" model becomes that model with the switch on.
- On a model without fast mode (Sonnet, Haiku, DeepSeek, Kimi...) the chip is dimmed and the chat
  runs at standard speed; the switch is kept and applies again on a model that has fast mode.
- Needs the session host of this version: quit ClaudeGUI (⌘Q) and open it again.

## 1.0.61 — 2026-10-06

### The prompt buttons, made easy to use

- After the first press of ↑, the "latest" button appeared beside ↑ and ↓ and pushed them aside, so
  the next press at the same spot jumped to the end of the chat. The three buttons now sit in one
  column (↑, ↓, latest) and never move: each is always there and is only greyed out when it has
  nowhere to go.
- The chat no longer jumps to the prompt: it scrolls there in one smooth movement that starts fast
  and slows into place, however long the answer in between (at most about 0.6 s). "latest" scrolls
  to the end the same way.
- Quick presses add up: three presses go three prompts on, in one movement. A turn of the scroll
  wheel or a swipe stops a movement where it is.
- Pressing the buttons leaves the keyboard in the input box.

### Rewinding to the first prompt after a compaction

- A rewind to the first prompt after a /compact (or an automatic compaction) could fail with "No
  message found with message.uuid", and Claude kept remembering the removed messages. When Claude Code
  had to be restarted for the rewind, the app restarted it at an answer from before the compaction,
  which Claude Code no longer has once a chat is compacted. The point is now taken from the
  conversation Claude Code resumes the chat with, by the rule Claude Code's own rewind uses.

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
