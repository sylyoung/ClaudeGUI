# ClaudeGUI architecture

```
src/
  shared/types.ts          IPC contract: session records, live state, chat message model
  main/
    index.ts               Electron app lifecycle, window, notifications
    env.ts                 Login-shell environment capture (zsh -ilc)
    store.ts               JSON persistence (session index, settings)
    ipc.ts                 ipcMain handlers (sessions, fs, shell, dialog, settings)
    fsService.ts           Directory listing, file reading, watching
    shellService.ts        Open URLs / files / editor / Finder
    sessions/
      transcript.ts        Pure reducer: SDK messages -> ChatMessage model (live + history)
      SessionRuntime.ts    One Claude Code process (SDK query, input queue, permissions)
      SessionManager.ts    Registry of runtimes, event fan-out to the renderer
  preload/index.ts         contextBridge -> window.api
  renderer/src/
    store.ts               zustand store mirroring main-process state
    App.tsx                3-pane layout (sessions | chat | files)
    components/...         Sidebar, ChatView, MessageList, ToolCallCard, PermissionPrompt,
                           Composer, FileTree, FileViewer, dialogs
```

## Data flow
1. Renderer calls `window.api.sessions.send(id, text)`.
2. Main `SessionRuntime` pushes an `SDKUserMessage` into the async input queue feeding
   `query({ prompt: asyncIterable, options })`.
3. SDK messages (`stream_event`, `assistant`, `user`, `result`, `system/*`) are folded by the
   transcript reducer into `ChatMessage` objects; changed messages are sent to the renderer
   (`session:message`), and status changes as `session:state`.
4. `canUseTool` callbacks become pending permission requests shown inline in the chat; the
   renderer answers through `sessions.answerPermission`.

## Session lifecycle
- `stopped` (no process) -> `starting` -> `idle` / `running` / `requires_action`.
- A session is started lazily on first send; history is loaded from the JSONL transcript.
- Stopping = end the input iterator (graceful) then `query.close()` after a grace period.
