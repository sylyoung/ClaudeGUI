# Changelog

## 1.0.45 — 2026-09-23

### A chat that is stopped mid-work leaves a note in its input box, and a draft is no longer lost

- Request: "I want that regardless of whether I use the update and restart button, or use command +
  Q, the running chats with monitors/shells/subagents would all generate text in the chat box that
  explains the unfinished things and let the chat be able to pick up when the app is reopened. such
  text would not be automatically inputted, waiting for me to input, and stays there no matter
  regardless of whether there are more closes/restarts, i.e., only gets deleted from the input box
  when I delete them."
- When a chat's process ends with work still in hand, the session host writes a note into that
  chat's input box: the turn that was cut off (and what it was running), the background shells,
  monitors and subagents that died with the process (with the command behind each), a command
  started from the input box, a tool that was waiting for permission, prompts that were never
  answered, and Claude Code's own last recap of where the chat stood. It ends with what to do about
  it, so sending it as it stands is a sensible instruction. Nothing is sent: the note waits in the
  box until the user decides.
- It is written on every path that ends a chat's process: quitting the app (⌘Q), restarting the
  session host, a Stop, a provider or model switch that replaces the process, and a process that
  ends by itself. A chat that was only sitting idle loses nothing and gets no note.
- The note lives with the chat, in sessions.json, not in the window. It is put back into an empty
  input box every time the chat is opened, however many times the app is closed in between, and it
  goes away only when the user edits it out of the box, clears the box or sends it. A newer note
  takes the place of the one before it while that one is still exactly as the app wrote it; words
  the user typed themselves are never overwritten — the note goes below them.
- Found while testing this and fixed with it: an unsent draft did not survive a quit at all. The
  input box was kept in the window's own storage, which is not written out when the app closes, so
  anything typed and left unsent was gone on the next start (measured: the stored value was there
  six seconds after typing and missing after the restart). Drafts are now kept with the chat like
  the note, saved a moment after the typing stops; a draft still lying in the old storage is taken
  over the first time that chat is opened.
- Checked in a running app, with the app quit and reopened between each step: a chat with a command
  still running left its note and showed it on reopening; a typed draft survived the quit; a second
  stop replaced the note and kept the typed words above it; deleting the note kept it deleted; a
  chat stopped with nothing running left no note; and a chat stopped while it was on screen showed
  its note immediately.
- What this cannot cover: a session host that is killed outright or crashes has no chance to write
  anything, and the note is only written by a host of this version — chats stopped by an older one
  leave nothing behind.

## 1.0.44 — 2026-09-23

### The model list offers only models that can be chosen

- Report: "the gpt 5.2-5.4 old ones are unusable, no need to show up".
- The model picker used to end its GPT section with the ids the bridge still carries but the
  ChatGPT subscription no longer sells — gpt-5.2, gpt-5.3-codex with its spark and fast variants,
  gpt-5.4 and gpt-5.4-mini — shown greyed with a note saying Codex would refuse them. They are
  gone: a model that cannot be chosen is only something to read past. The GPT section now lists
  what the subscription offers, in the order the subscription ranks it, and nothing else.
- What is still shown greyed is the opposite case, which the user can act on: a model the
  subscription does offer but the local bridge does not know yet. That row is what says the bridge
  needs updating — which is exactly how GPT-6 Sol and GPT-6 Luna turned up this round.
- Checked in a running app: the GPT section reads GPT-6 Astra, Sol and Luna, then GPT-5.6 Sol,
  Terra and Luna, then GPT-5.5, each with its fast variant and every one of them selectable; the
  DeepSeek and Kimi sections are unchanged.
- Outside the app, on this machine: the bridge that carries the GPT chats (claude-code-proxy,
  started by cc-gpt) was updated from 0.1.39 to 0.1.42, which is the version that knows gpt-6-sol
  and gpt-6-luna. The app itself needed no change for the new models — it reads each provider's
  list from the provider.

## 1.0.43 — 2026-09-22

### A drag in the sidebar always ends, and a compaction stands where it happened

- Reports: "there is a blue box over all pinned. and claudegui chat is greyed out even though it is
  active. also I could not see the last /compact chat text".
- The blue box and the faded row were one thing: a drag that never ended. A session row only heard
  the release while it still held the pointer, and nothing else in the sidebar listened, so letting
  go over the empty space below the sessions — or after the list had redrawn the row away — left
  the drag running with nothing to end it. The section under the pointer stayed lit as the drop
  target, which is the blue box over the pinned sessions, and the row being carried stayed at a
  third of its opacity, which is the greyed-out chat. Reproduced in a dev instance with exactly
  that picture, and gone with the fix.
- The window now ends a drag as well — on the release, on a cancelled pointer, and on losing the
  window, which is where the release goes when the pointer leaves the app. The listeners go up with
  the press rather than when the drag starts, so a flick quicker than one redraw is caught too.
  Dropping a chat on the pinned section still pins it, a plain click still opens a chat, and
  leaving the window in the middle of a drag now cancels it instead of committing it.
- The compaction was in the chat, but at the top of it. Claude Code hands a chat's history back
  with the summary first, before the messages the compaction kept, and the app added rows in the
  order they arrived — so the "Context compacted" row, and the whole summary folded into it, stood
  above the answer that came before the compaction instead of under the /compact that caused it.
  Rows that arrive out of the chat's order are now put in their place by their own time once the
  whole history has been read.
- That only works if the rows have their times, and the largest chats had none: a transcript over
  200 MB was given up on rather than indexed, so every row in it showed the moment the chat was
  created. The index no longer has a size limit — the file is read in pieces and no line is ever
  held whole beyond a megabyte, since it is the length of the lines, not of the file, that costs
  the memory. The 346 MB transcript of the ClaudeGUI chat indexes in 0.7 s in a few megabytes.
- Checked on that chat itself: before, the compaction notice came first and every row carried the
  chat's creation time; after, the rows carry their real times and the notice sits between the
  /compact at 01:04 and what followed at 05:17, with "what Claude kept" opening the summary.

## 1.0.42 — 2026-09-22

### The ChatGPT login is renewed by the app, and a chat's name keeps the whole of its own line

- Reports: "refresh the chatgpt token automatically, or add a button in the app for it", and
  "the chat name would get shrinked when model name is too long, but weirdly that the full first
  line is not taken, for example check Interview with GPT-5.6".
- Why the ChatGPT login lapsed: a Codex access token lives exactly ten days, the Codex CLI renews it
  while it runs, and ClaudeGUI only ever read it. The one stored on 12 September reached its limit
  at about 00:24 on 22 September, which is the minute the app first logged "ChatGPT did not accept
  the stored Codex login (HTTP 401)" and the Codex CLI asked to be signed in again.
- The app now renews that login itself: a day before it would expire, and again if ChatGPT refuses
  it, in which case the question is simply asked once more with the new token. It is the same
  exchange the CLI performs — the refresh token is presented to auth.openai.com with Codex's own
  client id, over the route the GPT chats take — and the file is replaced in one step, only after a
  complete answer has arrived, so a failed renewal leaves the previous login untouched.
- Plan usage limits → ChatGPT now shows both logins a GPT chat rests on, because they are separate
  and expire apart: the Codex login the limits are read with (with a "Renew now" button), and the
  local bridge's own login, which the chats themselves talk through and which is kept in the macOS
  Keychain (with a "Sign in…" button for when it can no longer renew itself).
- The chat rows in the sidebar were two lines sharing one column for whatever stands on the right,
  so the wider of the two decided for both: on a row with context or task chips on the second line,
  the first line lost exactly that width, the chat's name was cut to make room, and the space taken
  from it stayed empty after the time. Measured on the Interview chat on GPT-5.6 Sol (1M) in a
  270-pixel sidebar: the first line had 90 pixels for the name and the model with 62 pixels unused,
  and the name was squeezed to nothing. Each line is now a row of its own: 153 pixels, nothing
  unused, and the name keeps its share.

## 1.0.41 — 2026-09-21

### A chat with a very large transcript no longer kills the session host

- Report: "why cant ClaudeGUI use both GPT models and claude models? I started a GPT one, working
  fine, and then a claude one, and then broke".
- Mixing providers was not the cause. macOS kept the crash report: the session host process ran out
  of JavaScript memory ("abort() called" from V8's out-of-memory handler) at 11:19:41, three minutes
  after it started, and everything it owned went down with it — the app noticed it was gone and
  started a new one, which is why all the chats stopped at once.
- What it ran out of memory on: opening a chat makes Claude Code read that chat's history, and it
  does so by going through the whole transcript file and keeping everything written since the last
  compaction. The cost follows the size of the file, not the number of messages it gives back. Of
  the chats opened in those three minutes, one had a transcript of 1.2 GB (TDBRAIN) and two of about
  340 MB (MEGNet and this one); reading the 1.2 GB one alone takes about 2.7 GB and returns six
  messages. The session host cannot have more than about 4 GB, and that ceiling cannot be raised —
  Electron builds V8 with compressed pointers, which caps it — so a few of those reads next to each
  other went through it.
- A transcript larger than 64 MB is now read in a separate process that exists only for that read,
  so the memory it needs is given back to the system when it exits and the session host only ever
  receives the messages themselves. No two history reads run at the same time either, whatever their
  size, so their peaks cannot add up.
- Measured on the same chats: opening all six at once used to take gigabytes inside the host; it now
  costs it 204 MB at its highest, and every chat came back with exactly the history it had before.
- The host log now says how big the transcript was and where it was read, for example
  "history loaded: 6 entries (transcript 1179 MB, read in its own process)".

## 1.0.40 — 2026-09-18

### The recap is written when a chat finishes working out of sight, and it is kept

- Reports: "there is still no automatic recap", then "I restarted. still no recap".
- Three things were in the way. The session host that owned the chats was the one ClaudeGUI 1.0.34
  had started, and the recap is host code that arrived in 1.0.35, so it had never run at all; the
  restart fixed that one. On the new host the recap was still only asked for while the whole window
  was out of focus, and only for a chat whose last turn had ended between three and four and a half
  minutes earlier — so with many chats open, the chats the user was not looking at never got one.
  And a recap the app asked for lived only in memory, because it is asked for through the call that
  deliberately leaves nothing in Claude Code's transcript, so it disappeared whenever the session
  host was restarted.
- A chat that finishes a turn while you are looking at another chat, or away from the window, is now
  recapped once it has been quiet for 45 seconds — early enough that Claude Code answers out of the
  prompt cache that turn left behind, late enough that a follow-up prompt comes first. The older
  rule, which recaps the running chats when the window loses focus, is unchanged.
- The recap is kept in the chat's own record, so the sidebar still has it after the session host is
  restarted, and opening the chat puts it back where it belongs in the conversation.
- Settings → Claude has a switch for it, "Recap a chat that worked while you were looking
  elsewhere", the same choice Claude Code offers in its own /config.

## 1.0.39 — 2026-09-18

### The model is shown by its company's logo, not by a colour

- Request: "actually all bad. what are other ways to make the names differentiable easily, but not
  through color?", answered with "download the model icons images, put it before model name (after
  chat name), then the model name is all in general text color, no distinct color, and make the top
  model in bold".
- The logo of the company a chat's model comes from now stands between the chat's name and the
  model's name, in the sidebar row and on the model picker in the chat header: the Anthropic
  starburst, the OpenAI knot, the DeepSeek whale and the Kimi K. The model name itself is written in
  the ordinary text colour, so the only colour left on a row is the one that means something — the
  group, carried by the chat's name.
- The best model of each company is still the only one in bold: Fable, Astra, DeepSeek V4 Pro,
  Kimi K3.
- The logos are real files kept in the app (`src/renderer/src/assets/models`, with a README naming
  where each came from). The two marks their companies draw in one colour, OpenAI's and Kimi's, take
  the colour of the text beside them, so they stay legible in both the light and the dark theme.
- Everything the previous version added for colouring model names — the company-to-colour table, the
  CSS variables written when the theme changes — has been removed rather than left unused.

## 1.0.38 — 2026-09-18

### The model names use the app's own colours

- Request: "the colors of the models I do not like. use same color palette like the chat names".
- The colours a model name can be written in are now the same macOS system palette a chat name is
  written in when it belongs to a group — the twelve colours offered for groups — instead of the
  colours each company signs its own name with. One colour per company still: Claude orange, GPT
  mint, DeepSeek blue, Kimi purple, anything else graphite. The best model of each company stays in
  bold (Fable, Astra, DeepSeek V4 Pro, Kimi K3).
- The palette now exists in one place, `src/shared/colors.ts`, and the model colours are read from
  it when the theme is applied, so a chat name and a model name can never drift into two different
  sets of colours.

## 1.0.37 — 2026-09-18

### The sidebar tells you what a chat is about, and which model it runs on

- Request: "I also need no chat name in the second line in the snapshot. the second line in the
  snapshot should be 1) model name 2) status 3) last chat", then, on what the last line should say:
  "I actually wanted the recap, but I find it is still not enabled in this version 1.0.36, or the
  first sentence of last reply like it is now", on the folder: "just add the info of the chat's
  folder to right click that chat's info", and on the layout: "put model name to first line, after
  chat name. also give model name a coloring, each color for one enterprise family, and the best
  model (e.g., Fable, Astra, Deepseek Pro) in bold font against lower model in normal font".
- A chat's row now reads: first line the chat's name and the model it runs on, second line its state
  and what the chat itself last had to say. The folder name is gone from it — for most chats it was
  the chat's own name written twice — and is in the right-click menu instead, as "Folder: …", which
  copies the path when clicked; it is still in the row's tooltip too.
- What the chat has to say is Claude Code's recap of it when the chat ends on one, marked with the
  same sparkle the recap card in the chat carries, and the last thing Claude said otherwise. The
  state is now always written: an idle chat used to show its last reply *instead of* saying "idle".
- Those two lines no longer come only from chats that have run since the session host started. The
  end of a chat's transcript is read backwards at startup — the recap, or the last answer — so every
  chat has its line from the first moment. Checked against all 37 chats and their transcripts, up to
  1.77 GB each: the backwards scan finds the same line at chunk sizes from 4 KB to 8 MB, and the
  same line a plain whole-file read finds, in every one of them.
- Markdown is taken off that line: a summary that begins "**No — the data isn't out yet**" now reads
  "No — the data isn't out yet". Only the pairs of asterisks and the backticks go, never a character
  inside a word, so a file name with an underscore or a star in it is left alone.
- The model name is written in its company's colour — Claude in Anthropic's coral, GPT in OpenAI's
  green, DeepSeek in its blue, Kimi in purple, anything else grey — and the best model of each
  company in bold: Fable, Astra, DeepSeek V4 Pro, Kimi K3. The model shown in a chat's own header
  follows the same colours, which until now were one per Claude tier.
- Note for the recap itself, which is a session host feature and was added in 1.0.35: the session
  host running here is still 1.0.34, started on 16 September, so no recap has been written yet in
  this app. The installed 1.0.36 build does contain it (checked in the packaged bundle). It starts
  working after Updates → "Restart session host", with the chats stopped first.

## 1.0.36 — 2026-09-18

### Chinese, dashes and accents survive opening a chat

- Request: "the snapshot of chats conversions in special characters will shown as question mark.
  check my recent ChallengeNeurIPS26".
- What was happening: the app window and the session host talk over a Unix socket in
  newline-delimited JSON, and the socket delivers whatever bytes happen to be ready — a chat's
  history arrives as hundreds of chunks cut at byte offsets that have nothing to do with characters.
  The parser turned each chunk into text on its own, so a character whose bytes were split between
  two chunks was replaced by the Unicode replacement character, the black diamond with a question
  mark in it. Since that is still valid JSON nothing complained; the character simply arrived broken
  in the chat. Every character outside plain ASCII was exposed: Chinese, the em dash, curly quotes,
  Greek letters, accented Latin.
- Measured on the real ChallengeNeurIPS26 transcript: one 3.17 MB history sent over a real socket
  arrived in 407 chunks and lost 15 characters that way. The parser now keeps the trailing bytes of
  an unfinished character until the rest of it arrives, and the same 3.17 MB comes back identical to
  what was sent, with no replacement characters at all. Fed the same frame split at every one of its
  byte offsets in turn, all of them now round-trip; 49 of 133 used to corrupt the text.
- Nothing was lost on disk. The transcripts Claude Code writes were never touched by this — the
  damage was on the way to the screen only, so the chats read correctly again once the app and the
  session host are both running this version.
- The same mistake was in two smaller places and is fixed there too: the backwards scan that finds a
  chat's last prompt in a large transcript (a split character made that line unreadable and the
  chat's time in the list came from an older prompt), and the update log, which shows the output of
  the commands an update runs.

## 1.0.35 — 2026-09-17

### The chats get Claude Code's own recap, and the chat filter stays while you open results

- Request: "I realize that there is no recap in the chats. I need this", then, when the first plan was
  to have the app write its own summary: "no. why cant you just use claude code CLI's in-use recap
  function?", and finally "check really carefully if the recap function is really not capable to be
  implemented in the app without extra cost."
- The recap is Claude Code's, not a copy of it. In the CLI the recap and the side-question panel
  (`/btw`) are the same call — one turn, no tools, the previous turn's parameters reused so the
  answer comes out of the prompt cache, no new cache entry written, and nothing added to the
  conversation. The recap generator itself is unreachable from here: it lives in the terminal's
  interface and only fires when the terminal reports itself blurred, a state a chat driven through
  the SDK never reaches (measured: four prompts and four minutes idle, with
  `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=1`, produced nothing; `/recap` over the SDK produced nothing; a
  dev instance driving a real chat produced nothing). The same call is reachable, though, as a
  control request the SDK exposes as `askSideQuestion`, and that is what the app now sends, using
  Claude Code's recap instruction word for word.
- What it costs, measured: 2.4–2.5 s on a live chat, 5.1 s on a chat just reopened with no turn sent
  yet, and in every case the chat's transcript file came back byte-identical — the recap is not a
  message in the conversation, so the next thing typed is answered as if it had never been asked
  for. A recap is a generated sentence, so it is one model call; what it is not is a second process,
  a re-sent conversation or a new cache entry.
- When it happens: Claude Code's own rules, with this window's focus standing in for the terminal's.
  Three minutes after a chat's last turn, if the window has been left, if the chat is idle with
  nothing queued and no permission waiting, and if the chat has at least three messages the user
  wrote themselves and two since the last recap. It stops at four and a half minutes after the turn,
  because past the life of that turn's prompt cache the same question would mean paying for a second
  copy of the whole conversation — which is the point at which Claude Code gives up too. So a chat
  left quiet for the afternoon costs nothing, and a chat that has just finished something gets the
  sentence that says so.
- Recaps already in a chat's history are read back as well: `getSessionMessages` drops the type and
  text of Claude Code's system messages, so they are parsed out of the transcript file in the same
  pass that reads the timestamps, and placed where they happened (checked against a real chat: 140
  history entries, 25 recaps in the file, 3 belonging to the loaded part, each landing between the
  right neighbours).
- They are shown as a card with a small accent "RECAP" heading, like Claude Code's own.
- Request: "another thing is that when I use the search bar as finding a chat and click it, it returns
  back to the before-search view, but I am locked to the chat I selected."
- Picking a search result no longer clears the filter, so the list still shows what was searched for
  and the next result is one click away. Escape or the ✕ clears it, which the field's tooltip now
  says.

## 1.0.34 — 2026-09-14

### The in-app update can reach GitHub again, and a retired DeepSeek model id is remapped

- Request: "I was experiencing a lot of errors with deepseek in claudegui, `API Error: API returned an
  empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request …`.
  I used another model to apply some fix … check if this is real, make sure everything is good."
- The DeepSeek half, measured — the model id was not the cause. `https://api.deepseek.com/models`
  publishes exactly `deepseek-flash` and `deepseek-v4-pro`; `deepseek-v4-flash` is no longer listed,
  but the API still answers it properly: a live POST to `api.deepseek.com/anthropic/v1/messages` with
  `deepseek-v4-flash` returned HTTP 200 and a valid Message, streaming (SSE, `message_start`) and
  non-streaming alike, and the CLI running this very session was started with `--model
  deepseek-v4-flash`. The text the user saw is Claude Code's own report of a 200 whose body was not an
  Anthropic Message — that wording is in the bundled CLI, not in the app's source — so the app
  produced neither the error nor its cause, and no probe reproduces it now: DeepSeek answered
  everything, `server: openresty`, valid Messages. (`server: nginx` in the user's message is not
  DeepSeek's front end, which is what their error text suspected: something else answered then.)
- The remap is kept anyway: `RETIRED_MODEL_ALIASES` in `ProviderService` moves a chat that remembers
  `deepseek-v4-flash` onto the published `deepseek-flash`, and `SessionRuntime.start` writes the
  current id back into the session record so the chat's model pill follows. Both ids work today, and
  the CLI logs `unrecognized_model` for both (measured by running the CLI with each), so this changes
  no behaviour — it just stops the app from asking for an id its provider no longer lists.
- The update half, measured — the in-app update really was broken, but not because of 18118. The
  update log shows `git clone https://github.com/sylyoung/ClaudeGUI.git` failing with
  `LibreSSL SSL_connect: SSL_ERROR_SYSCALL` at 21:17Z and again at 21:27Z, and the environment those
  tools are given carries **no proxy at all**: the app is started by Finder, so it inherits the
  minimal LaunchServices environment, no shell startup file exports a proxy, and the login-shell
  capture the app builds its tool environment from returns `{}` for every proxy variable. Direct
  `https://github.com/` is unreachable from this machine (HTTP 000 after 20 s) while the same request
  through `127.0.0.1:8118` — the macOS system proxy — answers in 1.7 s, and a `git ls-remote` of the
  update repository through it lists the tags. The 18118→8118 swap added earlier could not fire,
  because it required 18118 to be configured in an environment that configures nothing.
- Fix: `src/main/systemProxy.ts` (new) plus `src/main/updater.ts`. The update tools now choose a route
  instead of inheriting one — the environment's proxy when it can actually carry a connection to
  GitHub, otherwise the macOS system proxy from `scutil --proxy`, otherwise direct — and a `*` entry
  in `NO_PROXY` (which switches every proxy variable off, and is what a launcher-set shell carries
  here) is dropped whenever a proxy is used. "Can carry a connection" means a CONNECT tunnel **plus a
  completed TLS handshake**, not just a listening port: the stale Docker container at 18118 answers
  `200 Connection established` and then carries nothing, which is exactly what made it look healthy
  to the port check it replaced. The route applies to update child processes only; chats keep the
  route their launcher sets.
- [x] `npm run typecheck` clean, production build clean. `sandbox/tools/check-update-route.sh` calls
  the same two functions the updater calls — on three environments: no proxy at all (what the app has
  today), the macOS system proxy, and the dead container — and then performs the operation that
  failed, a real `git ls-remote` through the chosen route, with the launching shell's `NO_PROXY=*`
  deliberately left in the mix. All three now choose 8118 and list tags v1.0.30…v1.0.33; before the
  fix the first and third went direct and failed with `Failed to connect to github.com port 443`.
- Environment note from the same round: `~/.zshrc` had already been edited at 17:30 today by the
  other model — `cc-ds` now sets the published `deepseek-flash` instead of building
  `deepseek-v4-flash`, in three places (help text, `ds_model`, `ds_subagent_model`); nothing else in
  the file changed. That file is the user's own and there is no backup of it from before that edit
  (the newest one under `sandbox/backups/` is 2026-09-13 22:47).

## 1.0.33 — 2026-09-13

### A markdown link to a file opens the file

- Request: "check my 报奖 chat, why cannot I open any of the file links?"
- Cause, measured: a link written as markdown — `[Helfrich proposal](/Users/…/Helfrich-project-proposal.docx)`,
  which is how a GPT model lists files, and 报奖 is a GPT chat — was not recognised as a file at all.
  Only paths written as plain text become file links (those carry the app's own `claudegui-file://`
  address, made in `Markdown.tsx`); a markdown link kept the address the model wrote, so a click
  handed `/Users/…` to `shell.openExternal`. Electron opens URLs, not paths: measured with this
  project's Electron 44, `shell.openExternal('/Users/…/优秀博士论文评奖对比.xlsx')` rejects with
  `Invalid URL`, while the same file as `file:///…` opens. The renderer never caught that rejection,
  so the click did nothing at all — no window, no message, in any chat. GPT chats show it everywhere
  because they write every path this way; Claude chats hide it by writing bare paths.
- Fix (`src/renderer/src/components/chat/Markdown.tsx`): a link whose address has no URL scheme and
  is not an in-document `#…` anchor is a file and behaves like a path in the text — resolved against
  the chat's folder, opened by Settings → Files → "Clicking a file opens it", with the same
  right-click menu. Web links are unchanged. A `shell.openExternal` that fails now says so in a
  toast instead of vanishing. Outside a chat (a Markdown file open in the viewer) an absolute path is
  opened with the default app, and a relative one — which has nothing to resolve against there — is
  left as plain text rather than as a link that cannot work.
- [x] `npm run typecheck` clean, production build clean. Verified in a dev instance with a real GPT
  turn (codex chat, bridge on 8118) that returned both forms: the absolute link and the relative
  `tmp/link-target-2.md` rendered as `span.file-link` with no `a[href^="/"]` anywhere in the chat,
  and a click on each opened the right file (its text on screen in the viewer, no error toast); the
  right-click menu offered all six entries (viewer, editor, default app, open with…, reveal, copy
  path). In a Markdown preview of a file containing all three kinds, the DOM showed absolute → file
  link, relative → plain text, `https://example.com` → `<a href>`; the preview's absolute link was
  not clicked, because that path opens the file with the default app and no test needs to launch one.
- Measurement side effect worth knowing: the Electron probe that established the cause was run with
  two control targets, so one browser tab to `example.com` and one file (an `.xlsx` in the user's
  报奖 folder) opened in their default apps, at about 2026-09-13 23:25 local.
- Test material left behind: `sandbox/tmp/link-target.md`, `sandbox/tmp/link-target-2.md`,
  `sandbox/tmp/preview-links.md`, and the driver scripts `sandbox/tmp/{inspect-link2,click-link,inspect-and-click,open-preview,chat-link-recheck}.js`.

## 1.0.32 — 2026-09-13

### The ChatGPT plan limits are read over the GPT route, not the Claude one

- Request: "the check now button as in the app is still wrong, cannot get the actual usage — for gpt
  I mean". The panel showed "ChatGPT's usage endpoint could not be reached at all. Codex traffic
  goes through the same proxy as Claude, so check that the proxy is running."
- Cause, measured: the check took its proxy from the captured shell environment, that is from the
  `claude` wrapper, which exports the Docker MonoCloud container (127.0.0.1:18118). The GPT chats
  leave through the MonoCloud desktop app (127.0.0.1:8118) instead — the bridge's upstream, which
  `cc-gpt` sets — so the two paths are different proxies that fail separately. The container's node
  had gone away (its log: `dial tcp 116.238.244.28:587: i/o timeout`), so every check failed with
  HTTP 0 while the GPT chats themselves were fine: the same request was 000 through 18118 and 200
  through 8118.
- Fix: the request uses the Codex launcher's environment — the route the GPT chats take — read by
  `src/main/gptRoute.ts` from the environment the session host saved the last time it ran `cc-gpt`
  (provider-cache.json), with the shell environment as the fallback when there is none. An explicit
  "Check now" that fails at the network level runs the launcher once and tries again with what it
  sets, so a route changed after that saved run (or a proxy that died) heals itself instead of
  leaving the panel stuck; automatic checks never run the launcher. The failure message names the
  proxy it tried and no longer blames the Claude path.
- [x] `npm run typecheck` clean, production build clean. Verified in a dev instance: with the saved
  route healthy, "Check now" returned ChatGPT `endpoint`, plan `prolite`, Weekly=55%,
  GPT-5.3-Codex-Spark Session (5h)=25% and Weekly=11%, gpt-reserve Weekly=0%, no error. With the
  saved route rewritten to the dead 18118, the same click logged `[usage] chatgpt: cc-gpt now routes
  through http://127.0.0.1:8118` and returned the windows (Weekly=56%).
- Not part of this change: the Claude side still checks over the shell's own proxy, which is the
  Docker container and is down (`usage endpoint returned HTTP 0` in the log). The plain `claude`
  wrapper and the app's Claude chats take that same route, so they are affected too.

## 1.0.31 — 2026-09-13

### Rewinding reaches every prompt of the chat, the way Claude Code's own rewind does

- The rewind list (double tap on Escape) only held the prompts since the chat's last compaction.
  When Claude Code loads a transcript larger than 5 MB it hands back only the part after the last
  compaction, and a chat that compacts often has little left after it: the biggest chat here loaded
  336 of its 503,000 transcript entries, which left its list 4 prompts out of the 10,441 sent over
  the chat's life. After the app (and with it the session host) restarted, rewinding looked like it
  remembered nothing but this session.
- The list is now read from the chat's transcript file itself, which holds every prompt. One
  streaming pass over the file — 2.1 s for the 1.3 GB chat, and only the lines written since the
  last read on every pass after that — keeps the prompts the chat's own history would keep: tool
  results, the CLI's notices and compaction summaries stay out.
- A prompt older than the conversation Claude Code still has cannot be rewound by restarting the
  session at the answer before it: Claude Code refuses a resume before its last compaction
  ("No message found with message.uuid of: …", verified against Claude Code 2.0.x), because that
  part is exactly what it skipped when it loaded. For those prompts the chat's transcript is cut at
  that answer instead — the same thing Claude Code's own rewind does to its transcript — and the
  removed part is kept beside the transcript as `<session id>.jsonl.rewound-<time>`, a name Claude
  Code ignores. Prompts after the last compaction are rewound the way they always were, by
  restarting at the fork point.
- [x] `npm run typecheck` clean, production build clean. Verified in a dev instance with a scratch
  chat: after its transcript was given a compaction and pushed past 5 MB, a restart left the loaded
  history with 0 prompts while the rewind list showed both prompts of the chat; rewinding to the
  earlier one cut the transcript from 6,069,490 to 64,924 bytes, kept the removed part in
  `<id>.jsonl.rewound-…`, cut the chat to the kept prompt, restarted the session (verified with the
  process alive), and Claude Code resumed the cut conversation seeing only the kept prompt
  ("PINEAPPLE", not the code word sent after it). The rewind list of the cut chat afterwards showed
  the remaining prompts. Screenshots: `sandbox/shots/rewind-picker-whole-chat.png`.
- Known limit: a rewind made by an earlier version left its abandoned branch in the transcript
  file, and those prompts appear in the list too. They are gone from the file once the chat is
  rewound with this version, and rewinding to one of them lands on that state of the chat.
- Cost: reading the transcript is CPU work in the session host (2.1 s for 1.3 GB, ~200 MB of
  transient memory), so it happens when the rewind list is opened, not at load.

## 1.0.30 — 2026-09-13

### The Claude / ChatGPT switch in the usage panel can be clicked

- The panel opened from the usage meter did not react to the mouse: its buttons — the Claude /
  ChatGPT switch, "Check now", "Sign in…" — did nothing when clicked. The panel is opened from the
  chat header, or from the file panel's tab bar, and both are window-drag areas (`.chat-header
  drag`, `.files-top drag`). The panel is a child of the bar it is anchored to, so it inherited
  `-webkit-app-region: drag` from it; on macOS a click inside a drag area moves the window instead
  of reaching the control, so the click never arrived. Every other control living in those bars
  carries `no-drag` for exactly this reason — the floating panels were the ones missing it, and had
  been since the usage panel was added, which also made its "Check now" button dead there.
- Fixed in the stylesheet rather than at each call site: `.popover`, `.ctx-menu` and `.modal` now
  set `-webkit-app-region: no-drag` themselves, so any panel anchored to a title bar is clickable
  wherever it is opened from. Dragging the window by the header is unchanged — the panel hangs
  below the bar and only its own area opts out.
- [x] `npm run typecheck` clean, production build clean. Verified in a dev instance: before the fix
  every button in the panel computed to `-webkit-app-region: drag`, after it to `no-drag`; the
  switch still moves the corner between Claude's "5h · Wk · Fable" pills and ChatGPT's "Wk" pill
  (`usageSubscription` becomes `codex`), and the Settings → Usage control is unaffected. A physical
  mouse click could not be exercised from this shell — macOS refused synthetic events ("not allowed
  assistive access"), and the JavaScript clicks used to test the switch in 1.0.29 bypass the
  drag-area check, which is exactly why that round's verification of this panel passed while the
  panel was dead to the mouse.

## 1.0.29 — 2026-09-13

### The plan-usage meter reads the ChatGPT subscription as well, with a switch

- **Click the usage meter and a Claude / ChatGPT switch sits at the top of the panel**; Settings →
  Usage has a labelled control for the same setting, so the corner always shows the subscription you
  chose. Both are read on every check, so switching costs no request. The switch's choice is a
  setting, so it survives a restart.
- **The corner shows the selected subscription's own windows.** For a ChatGPT login those are the
  ones ChatGPT reports for Codex: Codex names a window by its length, so the 5-hour window becomes
  "Session (5h)" and the weekly one becomes "Weekly" — here the main limit *is* the weekly window
  (measured 6 % used, resetting in 6 d 19 h). The per-feature extras ChatGPT also reports
  ("GPT-5.3-Codex-Spark" 5-hour and weekly, "gpt-reserve" weekly) appear in the details panel, named,
  rather than crowding the corner.
- **Where the numbers come from**: `GET https://chatgpt.com/backend-api/wham/usage` — the endpoint
  the Codex CLI itself reads — with the token Codex keeps in `~/.codex/auth.json`, sent over the same
  network path as Claude (the user's rule: GPT like Claude, Kimi and DeepSeek direct). When the
  captured shell environment configures a proxy, the request is pinned to it with `noproxy = ""`,
  because curl otherwise lets `NO_PROXY` — which can be `*` on this machine — silently send it out
  directly, where ChatGPT refuses it. The token travels in a curl config on stdin and is never logged.
- The plan name ("max", "prolite") moved from the panel header to its footer line, which now reads
  e.g. "ChatGPT (prolite) · last check: … · next in 4m".
- [x] `npm run typecheck` clean. Verified in a dev instance: the app's own `usage:get` returns both
  subscriptions with live numbers (Claude's windows plus ChatGPT's four); the normalizer was run over
  a live document through `sandbox/tools/codex-usage-normalize-check.ts` and mapped the weekly 6 %
  and the three extras as intended; the popover switch and the Settings control both switch the
  corner (Claude's "5h 60 % · Wk 100 % · Fable 17 %" ↔ ChatGPT's "Wk 6 %"); Cancel in Settings leaves
  the saved choice alone and Save persists it. Screenshots sandbox/shots/usage-{claude,chatgpt}.png
  and settings-usage.png. Dev instance and helpers stopped.
- Supersedes the open question of 1.0.28: reading ChatGPT's backend was the only way to show this,
  and it now answers HTTP 200. The earlier failure ("HTTP 000") was this machine's `NO_PROXY=*`
  making the probe curl bypass the proxy; the launcher's preflight was hardened for it in the same
  round (`--noproxy ''`, and a `*` dropped from the environment handed to the bridge).

## 1.0.28 — 2026-09-13

### Background work that ended with a chat is written into its input box, unsent
- **When a chat's process is replaced or stopped while background shells, monitors or subagents were
  running, the app writes a note about them into that chat's input box** — what was running, with the
  command each one started with, and the fact that it cannot be resumed. It is never sent by itself:
  read it, edit it, send it or delete it.
- Why a note is the only option, measured 2026-09-13 in a dev instance: a background shell is a child
  of that chat's Claude Code process (pid 86624, parent the chat's CLI process). Stopping the chat
  killed the CLI and the shell with it — its log file stopped at the line it had reached — and starting
  the chat again reported no background tasks at all. A new process cannot reattach to the old one's
  children: their output pipes closed with it. Starting the work again is the only way back, which is
  why the decision is left to the user.
- A model switch **inside** a provider does not restart anything (the running process just switches
  model), so nothing is lost or noted there; it is a provider switch (Claude / GPT / DeepSeek / Kimi)
  or an explicit stop that ends the process.
- The note never goes over words already typed: if the input box has text, the note waits in the store
  until the box is empty, then appears. Verified in a dev instance both ways (typed text untouched
  while the note waited; the note placed once the box was cleared), and nothing is written when the
  app itself is quitting.

## 1.0.27 — 2026-09-13

### Model names written the same way everywhere
- **One spelling for every model, in the sidebar, the chat header, the message rows and the picker**:
  `gpt-5.6-sol[1m]` reads "GPT-5.6 Sol (1M)", `kimi-k2.7-code` reads "Kimi K2.7 Code",
  `deepseek-v4-flash` reads "DeepSeek V4 Flash", `claude-haiku-4-5-20251001` reads "Haiku 4.5".
  A version number stays attached to the word in front of it (GPT-5.6) while variant words are
  separated by spaces (Codex Spark, Mini, Fast).
- The launchers name their own models in mixed styles — Codex supplied "GPT-6-Astra" beside raw
  "gpt-5.2", DeepSeek and Kimi supplied raw ids — so the app now spells them itself (the choice was
  the user's: brand-and-version hyphenated, variants spaced). Where a launcher's label says something
  the id does not, such as DeepSeek's "what cc-ds uses by itself", that note is kept as the row's
  tooltip.
- A chat on another provider that runs the launcher's own choice now reads "Default · GPT-5.6 Sol
  (1M)" instead of "default model ()".

### The context meter is no longer the part that gets cut off
- **The chat's status row gives way in order so the meter always fits.** The row is a single line that
  cannot wrap: with the file panel open it needs about 900 px inside an 868 px panel (measured), and
  the meter at its end was the part that lost its rounded edge and its number — the number being the
  reason the row exists. The decorations now drop in a fixed order when room runs short (folder size,
  git remote, changed-file count, last-activity time, last-prompt time, git branch, push button), and
  nothing is hidden while the row still fits. Only if even a stripped row is too narrow does the meter
  itself make room, its label ending in an ellipsis.
- Measured in a dev instance: at 868 px one item drops (the folder size) and the meter keeps
  "25k / 872k · 3%" on screen; at 578 px five drop and the meter is still whole; at 238 px (a chat
  column squeezed beside a 900 px sidebar and the file panel) the label ellipsises instead of the
  panel cutting the pill.

### Measured, not fixed: the two context counts behind the toolbar percentage
- Right after a compaction the toolbar number can read *higher* than before it (dev chat: 24k → 40k,
  twice; the chat's own row said "24,274 tokens → 1,829"). Claude Code answered differently each way
  it was asked, for the same idle chat, seconds apart:
  - **On a Claude chat** (`claude-opus-5`, 2026-09-13) the two agree once the out-of-window rows are
    taken out: summary total 21,566 = its rows minus "System tools (deferred)" 25,956; full total
    32,198 = the same rule with the newest Messages row counted (10,632). Both are internally
    consistent.
  - **On a GPT chat through the bridge** the two disagree row by row: System tools 20,897 vs 4,770,
    System prompt 2,270 vs 1,680, Memory 1,149 vs 768, Messages 2,603 vs 1,996 — and the summary's
    total (24,153) does not equal its own rows (33,863) either. The bridge counts with Codex's
    tokenizer while Claude Code estimates, so the same row is measured two ways.
  - The app shows the CLI's `summary` number (refreshed after each turn) and its `full` number behind
    the popover's *Recount* button; which of the two is shown is what makes the percentage move.
    Nothing was changed here: the CLI's own number is also the one its compaction acts on (a
    compaction boundary reported pre 23,682 tokens while the toolbar read 24,153 in summary mode).
  - Noted while measuring: the CLI reported `autoCompactThreshold` 839,000 for the 872,000 window,
    i.e. window minus the 33,000 reserve, although `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=92` was set — the
    ~802,240 the launcher's help text promises. Worth checking whether the 92 % reaches the CLI.

## 1.0.26 — 2026-09-13

### A compaction shows that it is running, instead of a percentage frozen from before it
- **The context bar in the chat toolbar animates while Claude Code compacts the context** and reads
  "compacting… 1m 12s" in place of the old number; it returns to the measured number when the
  compaction finishes. Asked for after a `/compact` in a long chat sat for minutes showing nothing.
- Why there is no real progress bar: measured with `sandbox/tools/compact-stream-probe.mjs`
  (2026-09-13, the same bundled CLI and SDK call the app drives) — a manual `/compact` reports
  `status compacting` at 0 s, the same status again at 30 s, and ends at 41.8 s with
  `compact_boundary` (`trigger=manual`, pre 23,682 → post 1,911 tokens, `duration_ms` 41,807).
  Between those there are **no tokens, no partial output and no percentage**, so a filling bar
  would be invented; the bar times the wait and covers it with a moving highlight.
- The elapsed time is a new `activitySince` on the live state, set by the host when the activity
  changes — Claude Code repeats "compacting" every 30 s, which must not restart the clock.
- The Compact button in the context popover is disabled while the chat is already compacting.
- Noted, not fixed: right after a compaction the toolbar number can read *higher* than before (dev
  test: 23k → 39k although the chat's own row said "24,274 tokens → 1,829"). The CLI's two context
  counts disagree — `summary` answered 39,257 and `full` answered 19,650 for the same idle chat,
  measured 30 s apart — and the app shows whichever it asked for last. Worth a look of its own.

## 1.0.25 — 2026-09-13

### An answer you are half-way through typing survives a chat switch
- **Ticked options and a typed "Other" answer on a question card are kept per request.** The card is
  part of one chat's transcript, so switching to another chat and back rebuilt it blank: the ticks
  and the text you had written were gone and had to be made again. Both are now remembered for the
  request and dropped once the card is answered or dismissed.
- The context window shown for a GPT chat is whatever the launcher declares: `cc-gpt` exported
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000`, so a chat on GPT-5.6-Sol was measured against 272,000
  although the model's own list gives it 272,000 standard and **872,000 maximum**, and Codex accepted
  a 530,546-token prompt through the bridge (measured 2026-09-13). `cc-gpt` now declares the model's
  full 872,000-token window at 92 % (~802,240 tokens before compaction); `cc-gpt-safe` stays
  conservative at 220,000. Chats already open keep the window they started with until they are
  restarted.

## 1.0.24 — 2026-09-12

### Other-provider chats when the launcher refuses, and only models the account offers
- **A launcher that refuses to start no longer takes the provider down with it.** `cc-gpt`, `cc-ds`
  and `cc-kimi` run their own checks before they hand Claude Code an environment: the bridge is up,
  the network route answers, the login is valid. When one of those fails they exit without setting
  anything, so no chat could start on them — although the bridge they started earlier was still
  running and answering. The app now keeps the environment of each launcher's last successful run
  (`provider-cache.json`, mode 600, in the app data folder) and uses it when the launcher refuses,
  after checking that the provider still answers with it. The reason stays visible rather than
  hidden: the provider is listed with "…refused just now (…); this runs on the settings it produced
  on …", and the host log records the same.
- **Only models the account really offers are offered.** A ChatGPT subscription answers "not
  supported when using Codex with a ChatGPT account" for the older ids the bridge still carries
  (`gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`); those are now listed greyed with that
  reason instead of being pickable. The GPT list is the subscription's own list (the Codex CLI's
  model cache), so a model the bridge accepts and the subscription offers — GPT-6-Astra with bridge
  0.1.36 or newer — appears by itself and can be picked.
- **Switching to a provider that cannot start leaves the chat usable**: it goes back to the model it
  ran on, that process is started again, and the picker says what went wrong.
- **Chats no longer inherit the Claude Code variables the app itself was started with.** A chat's
  model, endpoint and keys come from the shell the app reads (your `claude` wrapper or the provider
  launcher) and from Settings → Environment; starting ClaudeGUI from a terminal inside another
  Claude Code chat can no longer re-point its chats at that chat's provider.
- Session host change: after the update, quit the app fully (Cmd-Q) and open it again.

## 1.0.23 — 2026-09-12

### Models of other providers in the model picker
- **GPT (ChatGPT subscription through the Codex bridge), DeepSeek and Kimi models sit in the same
  model picker as the Claude models**, in the chat toolbar and in the New session window, grouped by
  provider. Pick one and the chat runs on it; pick a Claude model again and it comes back. Switching
  to another provider restarts Claude Code and continues the same conversation there, the way
  `cc-gpt --continue` does in the terminal.
- **The lists come from the providers, not from the app**: the GPT list is what your Codex
  subscription offers right now (the Codex CLI's own model cache) matched against what the bridge
  accepts, so a new model such as GPT-6 shows up by itself; a model the bridge does not know yet is
  shown greyed with "bridge update needed". DeepSeek and Kimi are asked for their model lists with
  the key your launcher uses. Lists are read at every app start and with "Refresh model lists".
- **Set up from Settings → Claude → Other model providers**: one row per provider with the command
  from your shell that runs Claude Code on it (`cc-gpt`, `cc-ds`, `cc-kimi` by default). The app
  runs that command in your login shell with a stand-in `claude`, exactly as the terminal would (the
  bridge is started, keys come from the Keychain, the compaction limits apply), and reads the
  environment it sets. Rows can be added, switched off or removed. A provider whose command is not
  defined or whose login is missing is listed with the reason instead of its models.
- Chats on these providers keep the app's own permission mode (the terminal launchers default to
  bypassing permissions; the app does not).
- Session host change: after the update, quit the app fully (Cmd-Q) and open it again.

## 1.0.22 — 2026-09-12

### A rewind keeps the chat running
- **Rewinding no longer leaves the chat "not running".** Claude Code can only replay a cut
  conversation when it starts, so a rewind has to replace the chat's Claude process. Until now the
  process was stopped and stayed stopped until the next prompt started a new one. Now a new process
  is started at the fork point straight away: the chat is back to idle within a few seconds, with
  the prompt in the input box, and Claude no longer remembers what was cut. A chat that was not
  running before the rewind stays as it was.
- The rewind window and the confirmation say so ("Claude Code was restarted at that point").
- Session host change: after the update, quit the app fully (⌘Q) and open it again for this to take
  effect — the same quit the 1.0.19 and 1.0.20 host fixes are waiting for.

## 1.0.21 — 2026-09-11

### Every file opens with its default macOS app
- **Clicking a file hands it to the app Finder would use, whatever kind of file it is.** Until now
  text files and images (`.md`, `.txt`, `.py`, `.png`…) opened in the built-in viewer and only
  Word, PDF, spreadsheets and the like went to their macOS app. That split is gone: a path in the
  chat, a row in the file tree and a changed file in the Git panel all open with the default app.
  The built-in viewer is still one right-click away ("Open in viewer"), and `⌘`-click still opens
  the file in your editor.
- **One setting instead of the old checkbox.** Settings → Files → "Clicking a file opens it" offers
  the new default (default macOS app for every file), the previous behaviour (text and images in
  the viewer, other files in their app) and "always in the viewer".
- **A double click no longer opens a file twice.** The second click of a double click used to count
  as another single click; and when both the single and the double click are set to the default
  app, the double click now does nothing extra.
- Window only: no full quit needed after the update.

## 1.0.20 — 2026-09-11

### The chat shows that it is working from the moment Claude Code takes a prompt
- **A queued `/compact` no longer runs behind a chat that says idle.** When a `/compact` typed
  during a turn was taken after that turn, the prompt was marked registered but the sidebar, the
  status board and the chat header showed idle for the whole compaction (measured: 14 seconds). The
  end of the earlier turn had set the chat idle, and a compaction writes no answer that would have
  set it working again. Taking a prompt now counts as working, and so does Claude Code reporting
  that it is compacting or waiting for the model.
- **The same gap for an ordinary prompt is closed.** A queued prompt taken after a turn showed the
  chat idle for about a second, until the first token of its answer; it now shows working from the
  moment Claude Code takes it.
- **A prompt waiting behind a `/compact` is no longer marked registered too early.** At the end of a
  turn Claude Code reports how many prompts are still waiting, and that number is 0 even when
  prompts are waiting; the host read it as "all taken" and marked every waiting prompt registered
  at once, moving it up the chat while it was still in the queue. The host now trusts only Claude
  Code's per-prompt "started" report, which arrives the moment a prompt is really taken.
- These changes live in the session host: after updating, quit ClaudeGUI completely (⌘Q) and reopen
  it once; the chats keep their history.

## 1.0.19 — 2026-09-11

### When Claude Code's login runs out
- **The window says so, and signs Claude Code in again.** Claude Code renews its 8-hour access token
  by itself. When the login server stops accepting the longer-lived refresh token behind it, Claude
  Code removes the stored login and every chat fails with "Failed to authenticate"; only signing in
  again in a browser brings it back, so no app can renew it silently. A notice above the chat now
  says that Claude Code is signed out, and **Sign in…** runs `claude auth login` from the app: the
  browser opens Claude's sign-in page, and if the page shows a code, it is pasted into the dialog.
  The chats keep their history and continue with your next message; nothing has to restart.
- **A warning before the login ends.** Claude Code records when its refresh token stops being
  accepted; three days before that date the notice appears, so you can sign in again before chats
  fail. A system notification is sent when Claude Code becomes signed out.
- **A failure while the login is still there is named as one.** When chats fail to authenticate but
  the login is still stored — a network problem, or a renewal that was in progress — the notice says
  that, and that sending the message again is the first thing to try.
- **The usage meter tells the truth.** It said "API-key users have no plan limits" when Claude Code
  was signed out; it now says the login expired and offers Sign in, and describes an access token
  that expired between messages as the normal thing it is.
- ClaudeGUI still only reads the login; renewing it stays Claude Code's job, because a second
  renewer would invalidate the refresh token Claude Code holds.

### Forking a chat
- **Fork chat copies a conversation into a new chat, as Claude Code's `/branch` does.** The new chat
  is named "<title> (Branch)", then "(Branch 2)" and so on, you continue in it, and the original chat
  — its process, its queue and its transcript file — is not touched. It is in the chat's right-click
  menu and in the chat header, and typing `/branch` (optionally followed by a name) does the same.
- **Chats that work in the same folder belong to one group.** A fork lands in its original's group,
  a new or imported chat joins the group of the chats already in its folder, and moving one moves the
  others. In the Groups view they sit together under the folder's row, even with folder rows
  switched off; the Recent view stays ordered by your last prompt and nothing else.

### Shell commands with "!"
- **"!" at the start of a message runs the rest as a shell command, as in the terminal** — in the
  chat's folder, with your own shell's environment and aliases; "！" typed with a Chinese input
  method works as well. The command and what it printed get their own row, with a Stop button while
  it runs (Stop ends everything the command started). Claude reads the command and its output with
  your next message; running it starts no turn, adds no footer and leaves no unread mark. Very long
  output keeps its beginning and its end, and a command is stopped after 10 minutes.

### A queued prompt turns "registered" when Claude Code takes it
- A prompt sent while Claude is working is often read by Claude Code inside the running turn,
  together with a tool result, instead of in a turn of its own, and no message named it until that
  whole turn was over — so it kept its amber "queued" mark long after Claude had read it. The app now
  follows Claude Code's own report of taking each prompt, and the mark turns green at that moment.

### After updating
- Forking, "!" commands, the queued-prompt fix and noticing failed chats live in the session host,
  which keeps running across updates so your chats survive. Quit ClaudeGUI completely (⌘Q) and open
  it again once to start the new host; until then, forking and "!" say so instead of failing.

## 1.0.18 — 2026-09-09

### Compacting the context leaves no unread mark
- **A chat you have just written in counts as read.** Sending a prompt clears the chat's unread
  mark, because typing into a chat means you are looking at it. Until now a mark left by an earlier
  answer stayed on the chat while you typed `/compact`, so after the compaction the red circle was
  still there and looked as though the compaction itself had left something new to read.
- **A refused compaction is housekeeping too.** When the conversation is too short, Claude Code
  answers `/compact` with a notice of its own ("Not enough messages to compact."); that reply marked
  the chat unread and raised a notification. It no longer does.
- **The command is recognised in the form the CLI writes it back.** A turn counts as housekeeping
  when the only prompt it answered was a `/compact`, whether that prompt reads as you typed it or as
  the CLI's own echo of it, and the notes the CLI puts in a chat itself (reminders, task
  notifications, command echoes) no longer count as prompts of yours that need an answer.
- A turn that compacted the context on its own and then went on answering is unchanged: the answer
  still marks the chat unread, because there is something to read.

## 1.0.17 — 2026-09-09

### Files with Chinese names open from the chat
- **A path is now recognised whatever alphabet it is written in.** The chat looked for paths with a
  pattern that only accepted Latin letters, digits and `_`, so `中文目录/测试文件.md` was either
  ignored or cut off at the first Chinese character; the same held for Japanese, Korean, Russian and
  accented names. Letters and digits of every writing system now count as part of a name.
- **Clicking a path in an answer works again at all.** Every file path the app found inside an
  answer was turned into a link whose address react-markdown then threw away, because it does not
  know our internal `claudegui-file://` address; the link stayed on screen but did nothing. Such
  links are let through now — this affected Latin paths as much as Chinese ones.
- **A sentence glued to a path no longer breaks it.** Chinese, Japanese and Korean are written
  without spaces, so an answer says `打开/Users/me/文件.md的内容` with the words touching the name.
  The chat cuts the sentence off an absolute path, and when a path as written does not exist the app
  tries the shorter spellings before reporting it missing, so the click still opens the right file.
- Right-click on such a path (open in the editor, reveal in Finder, copy) uses the same repair.

### Chinese, Japanese and Korean typing in the chat box
- **Enter no longer sends a half-typed prompt.** An input method uses Enter, Escape and the arrows
  to choose among the characters it offers; the chat box took those key presses for itself, so
  pressing Enter to pick 你好 sent the raw "nihao" instead. Every key that belongs to the input
  method is now left to it — in the chat box, in the rename boxes, in the search and filter lists,
  and in the Git panel.
- **Escape while the input method is open does not stop the turn or close the window** any more.

### The plan usage is text, not bars
- **The bars are gone; the numbers carry the colour.** Each pill in the top right is now the name of
  the limit and the percentage, coloured green below the warning threshold, amber above it and red
  from 90 % of the limit.
- **The breakdown says the scale in words**, each word in the colour it names: "A number is green
  below 50 %, amber from 50 % and red from 90 % of the limit."

## 1.0.16 — 2026-09-09

### The plan-usage bars show the whole scale
- **Every usage bar now carries the full scale at all times** — green up to the amber threshold,
  amber up to 90 %, red above it — with the part you have not reached dimmed and a mark at the
  point you stand on. Before, the bar was painted in one colour, the colour of the level you were
  at, so at 2 % used there was no red anywhere on screen and nothing showed how far the red was.
- **The percentage is coloured too**, in the same three colours, so a pill is never plain grey.
- The breakdown behind the pills uses the same bars, one size larger, and says in words what the
  scale means: "whole scale: green to 50 %, amber to 90 %, red above".

### The keys of the terminal chat window
- **Double tap on Escape rewinds**, as in the terminal. It opens a list of the prompts you have sent
  in this chat, newest first, with a filter box; picking one opens the rewind window that asks
  whether only the conversation or the conversation together with the files should go back.
- **A single Escape stops the turn that is running** and puts the prompt back in the input box.
- **⇧⇥ steps through the permission modes** — ask before risky actions → accept file edits →
  read-only planning — and says in a message which one is now in force.
- **A keyboard button beside the input box lists every shortcut** in plain language, also reachable
  with ⌘/ and from the Session menu, because the terminal's "? for shortcuts" had no counterpart
  here. The hint under the input box now mentions "esc esc rewind".

## 1.0.15 — 2026-09-07

### Two states for a prompt, and nothing else
- **A prompt is either registered or queued.** Registered means Claude Code has taken it: the chat
  moves it down so it stands directly above the answer it started. Queued means Claude Code has not
  taken it yet: it waits at the very bottom, below the answer being written, and can be pulled back
  into the input box. The older marks "being answered", "answered" and "sent" are gone — queued is
  amber with a dashed bubble, registered is a green check.
- **The guessing that went with those marks is gone too.** The chat no longer has to work out from a
  reloaded conversation whether a turn finished; a prompt that Claude Code is not holding in its
  queue has been taken, and that is all the chat claims.

### Taking a waiting prompt back with ↑
- **↑ offers the prompt you typed last, even after Claude Code has taken an earlier one.** The walk
  through your earlier prompts now follows the order you typed them in. It used to follow the order
  they stand in in the chat, which stopped being the same thing when a taken prompt began moving
  down to its answer: with two prompts waiting, the first ↑ handed you the one already being
  answered — which cannot be taken back — instead of the one still waiting below it.
- **A prompt can be taken back in the moment before its row appears.** Sending a prompt now answers
  with the id it has in the chat, so ↑ withdraws it from Claude Code's queue straight away instead
  of leaving a copy to be answered behind your back.
- **Taking a prompt back ends the walk**, and its text becomes the draft, so pressing ↑ again does
  not throw away the prompt you just pulled out of the queue.

### Pasting
- **Text copied from a document is pasted as text.** A copy out of Word, a PDF viewer or a web page
  puts the same selection on the clipboard twice — as text and as a picture of the formatted text —
  and the app took the picture, so a pasted paragraph arrived as an image attachment. The text wins
  now; the picture is only taken when the clipboard holds no text at all, as with a screenshot.

## 1.0.14 — 2026-09-07

### Where a prompt sits in the chat
- **A prompt Claude Code has taken moves to the end of the chat, directly above the answer it
  starts.** A prompt typed while an earlier answer was still being written was left where it was
  typed — in the middle of that earlier answer — so the moment it was taken it appeared above the
  previous turn's footer, with its own answer written two rows further down. It is now put where
  Claude Code actually read it: after everything the earlier turn wrote. This is also the order the
  chat has always had after a restart, when it is read back from Claude Code's own record, so the
  live chat and the reloaded one no longer disagree.
- **A prompt still waiting stays at the bottom**, below the answer being written, in the block of
  prompts Claude has not taken yet — unchanged, and now clearly the only thing below the answer.
- **The two states are easier to tell apart**: the mark under a prompt ("⋯ queued", "... being
  answered", "✓ answered") is no longer footnote-sized, and neither is the header of the waiting
  block.

### Prompts read back from an earlier run
- **A prompt from a previous run of the app is marked "answered" when it was answered.** The turn
  footers this app draws are not part of Claude Code's record, and the chat used to take a missing
  footer as evidence that the turn had not finished, so after every restart the whole conversation
  read "sent" — "the turn it started did not finish". The answer itself is now the evidence, and
  the notice Claude Code writes when a turn is stopped is what marks a prompt as unfinished.

## 1.0.13 — 2026-09-07

### What happened to each prompt
- **A prompt typed during a /compact is no longer called "answered" the moment the compaction
  ends.** The chat used to decide what had happened to a prompt from where it stood in the
  conversation: anything above the last finished turn counted as answered. A prompt sent while the
  context was being compacted stands above the compaction's own turn, so it flipped from "queued"
  straight to "answered" although Claude Code had not started it yet, and it stayed wrong for as
  long as the answer took.
- **The marks now come from what Claude Code says about each prompt**: it names the prompts every
  turn takes and answers, and reports how many sends are still in its queue. A prompt is therefore
  "queued" while it is really in the queue, "being answered" from the moment the CLI takes it —
  including the moment right after a compaction, when it is taken for the turn that starts next —
  and "answered" only when the turn that took it has finished. The conversation is only consulted
  for prompts read back from an earlier run of the app.
- **A prompt is queued whenever an earlier one is still unfinished**, rather than when the session
  looks busy. Between two turns the session is idle for a moment although Claude Code has already
  taken the next prompt; a prompt typed in that moment used to be marked as being answered straight
  away.
- **A mark cannot get stuck any more**: prompts still marked as waiting or as being answered after
  ten quiet seconds, or when the process ends, are let go.

## 1.0.12 — 2026-09-07

### The "working" status in a chat
- **What Claude is doing now is the last row of the chat**, right under the answer being written,
  instead of a full-width tinted band squeezed between the message list and the input box. It is a
  rounded row with a soft blue tint that scrolls with the conversation.
- **It is written at reading size.** The status ("compacting the context", "waiting for the model",
  "running Bash", "starting the process") used to be set smaller than the chat text; it is now
  slightly larger than it and blue, with the elapsed time beside it in grey.
- **The elapsed time only appears after a second**, so a turn that has just started no longer shows
  something like "122ms" next to the status.
- The blue of every "this chat is working" mark — the status row and the glowing input border —
  now comes from theme variables, so the light theme uses its own blue instead of the dark theme's.

## 1.0.11 — 2026-09-07

### Compacting the context
- **A /compact is one row in the chat again.** Claude Code writes two extra messages of its own when
  it compacts — the summary it keeps, and a note that it compacted — and both used to land in the
  chat as unnamed "system message" lines under the prompt, so a single /compact looked like several
  entries. The summary is now folded into the "Context compacted" row and can be opened there
  ("what Claude kept"); the note is dropped, because that row already says it.
- **Reopening a compacted chat no longer shows the summary as if you had typed it.** When the
  history is read back after a restart, Claude Code repeats the summary but not its compaction
  notice, so the whole summary appeared as a normal prompt bubble (and could be walked into with ↑,
  or counted among the prompts waiting). Such a chat now starts with a "Context compacted earlier in
  this chat" row that holds the summary.
- **Every folded system line says what it is** — "summary kept after compacting", "what the command
  printed", "reminder Claude Code added", "background agent finished" and so on — instead of
  "system message" for all of them.

### Session list
- **The model name on a session row is no longer coloured**, so the only colours on a row are the
  group (on the chat name) and the session state. The model picker in the chat header keeps its
  colour.

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
