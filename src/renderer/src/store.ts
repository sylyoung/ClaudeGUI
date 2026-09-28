import { create } from 'zustand'
import type {
  AuthState,
  AppInfo,
  AppSettings,
  ChatMessage,
  GitCommitInfo,
  GitDiffResult,
  GitStatusResult,
  ImageAttachment,
  PermissionDecision,
  ProviderView,
  SessionEvent,
  SessionGroup,
  SessionLiveState,
  SessionRecord,
  SidebarSort,
  SidebarView,
  ThemeInfo,
  UpdateState,
  UsageState
} from '@shared/types'
import { applyTheme } from './lib/theme'
import { comparatorFor } from '@shared/util'
import { emptyUsageState } from '@shared/defaults'
import { rowPlace, trimLimit, withKeptChildren } from '@shared/rows'

export type DialogKind = null | 'new-session' | 'import-session' | 'settings' | 'shortcuts' | 'sign-in'
export type SettingsTab = 'general' | 'appearance' | 'claude' | 'files' | 'git' | 'usage' | 'advanced' | 'about'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
}

export interface FileTab {
  path: string
  line?: number
  /** bump to force a reload */
  version: number
}

export type PanelTab = 'files' | 'tasks' | 'git'

export interface FilesState {
  open: FileTab[]
  active?: string
  /** set of expanded directories in the tree */
  expanded: string[]
  revealPath?: string
  tab: PanelTab
  /** Whether the folder (files / tasks / git) panel is shown for this chat; undefined = shown. */
  panelOpen?: boolean
}

export interface GitSelection {
  path: string
  staged: boolean
}

export interface GitState {
  status?: GitStatusResult
  log?: GitCommitInfo[]
  loading: boolean
  error?: string
  /** Label of the action currently running (push, commit…). */
  busy?: string
  selected?: GitSelection
  diff?: GitDiffResult
  diffLoading?: boolean
  lastFetchAt?: number
}

interface State {
  ready: boolean
  appInfo?: AppInfo
  settings?: AppSettings
  theme: ThemeInfo
  usage: UsageState
  /** Whether Claude Code can authenticate (see AuthNotice). */
  auth: AuthState
  update: UpdateState
  /** Other model providers and their models (Settings, Claude tab), read at start and on demand. */
  providers: ProviderView[]
  providersAt: number
  providersError?: string
  records: Record<string, SessionRecord>
  live: Record<string, SessionLiveState>
  groups: SessionGroup[]
  messages: Record<string, ChatMessage[]>
  /**
   * Prompts sent during the current turn (restored into the composer when the turn is interrupted).
   * `id` is the id the prompt has in the chat; it arrives with the answer of the send call, so it is
   * missing for the moment between pressing enter and the host answering.
   */
  sentQueue: Record<string, { id?: string; text: string; images: ImageAttachment[] }[]>
  /** Text to put back into the composer of a session (set by interruptSession). */
  composerRestore: Record<string, { text: string; images: ImageAttachment[]; nonce: number }>
  historyLoaded: Record<string, boolean>
  /**
   * Where the rows the window holds of a chat begin in its transcript file. Scrolling up reads the
   * part before this; a find searches the file before it and the rows from it on. Unknown with a
   * session host of 1.0.54 or older, which keeps that place itself (live.historyFrom).
   */
  rowsFrom: Record<string, number | undefined>
  /** The session host can find a row's line in the file, so the window may let go of this chat's older rows. */
  trimmable: Record<string, boolean>
  /** The chat on screen shows its end and follows new output (reported by the chat's list). */
  following: Record<string, boolean>
  /** Chats opened lately, the one on screen first: the window keeps the rows of these and of no others. */
  recentChats: string[]
  /** A chat is being read further back right now (the user scrolled to the top of it). */
  earlierBusy: Record<string, boolean>
  activeId?: string
  dialog: DialogKind
  /** Tab to open the Settings dialog on (null = last used). */
  settingsTab: SettingsTab | null
  sidebarOpen: boolean
  /** Folder panel visibility of the active chat (mirrors files[activeId].panelOpen). */
  filesOpen: boolean
  sidebarWidth: number
  filesWidth: number
  search: string
  showArchived: boolean
  toasts: Toast[]
  files: Record<string, FilesState>
  git: Record<string, GitState>
  composerFocusNonce: number
  /** Bumped when all tool cards should follow the global expanded/collapsed setting again. */
  toolExpandNonce: number
  /** Expand-all / collapse-all chosen in the chat header; overrides what a card shows by default. */
  toolDetails: 'expand' | 'collapse' | null
  searchFocusNonce: number
  /** The last find command for the chat on screen (⌘F, ⌘G, the menu); the chat acts on each new nonce. */
  findRequest: { cmd: 'open' | 'next' | 'previous'; nonce: number }
  /** Multi-selection in the sidebar (⌘-click / ⇧-click); bulk actions apply to these ids. */
  selectedIds: string[]
  /** Ids whose process is being started / stopped by a bulk action (for progress display). */
  bulkBusy: Record<string, 'start' | 'stop'>

  init: () => Promise<void>
  /** Read the other model providers; refresh = run their launchers and ask for their model lists again. */
  loadProviders: (refresh?: boolean) => Promise<void>
  applyEvent: (e: SessionEvent) => void
  selectSession: (id: string | undefined) => Promise<void>
  ensureHistory: (id: string) => Promise<void>
  send: (id: string, text: string, images?: { mediaType: string; data: string; name?: string }[]) => Promise<void>
  /** Stop the current turn and put the prompts of that turn back into the composer. */
  interruptSession: (id: string) => Promise<void>
  /** Cut a chat back to one of your prompts; the prompt text goes back into the input box. */
  rewind: (id: string, messageId: string, restoreFiles: boolean) => Promise<void>
  /**
   * Take a prompt that is still waiting back out of Claude Code's queue. Returns false when Claude
   * had already taken it, in which case it stays in the chat and is answered.
   */
  takeBackQueued: (id: string, messageId: string, toComposer?: boolean) => Promise<boolean>
  /** Put a text back into the input box of a chat (used by the prompt menu). */
  restoreComposer: (id: string, text: string) => void
  answerPermission: (id: string, requestId: string, decision: PermissionDecision) => Promise<void>
  setDialog: (d: DialogKind) => void
  openSettings: (tab?: SettingsTab) => void
  setUpdate: (u: UpdateState) => void
  /** Re-read records and live states from the main process (after the session host was replaced). */
  reloadSessions: () => Promise<void>
  /**
   * Fetch the part of a chat that comes before the part on screen, and put it above it. A chat is
   * opened on its recent messages only; this is what scrolling to the top asks for.
   */
  loadEarlier: (id: string) => Promise<boolean>
  /** The chat's list says whether it shows the chat's end (only then may its older rows be let go of). */
  setFollowing: (id: string, following: boolean) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  setSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** Settings pushed from the main process (menu changes etc.). */
  receiveSettings: (s: AppSettings) => void
  setTheme: (t: ThemeInfo) => void
  setUsage: (u: UsageState) => void
  setAuth: (a: AuthState) => void
  /** Copy a chat into a new one, as Claude Code's /branch does, and open the new chat. */
  forkSession: (id: string, name?: string) => Promise<void>
  openFile: (sessionId: string, path: string, line?: number) => void
  closeFile: (sessionId: string, path: string) => void
  setActiveFile: (sessionId: string, path: string | undefined) => void
  toggleExpanded: (sessionId: string, dir: string, open?: boolean) => void
  setFilesTab: (sessionId: string, tab: PanelTab) => void
  setRevealPath: (sessionId: string, p: string | undefined) => void
  bumpFileVersion: (path: string) => void
  refreshGit: (sessionId: string, opts?: { log?: boolean; fetch?: boolean; quiet?: boolean }) => Promise<void>
  selectGitFile: (sessionId: string, sel: GitSelection | undefined) => Promise<void>
  runGit: (sessionId: string, label: string, fn: () => Promise<unknown>, opts?: { successToast?: string }) => Promise<boolean>
  toggleSidebar: () => void
  /** Show / hide the folder panel of the active chat (remembered per chat). */
  toggleFiles: () => void
  setFilesOpen: (open: boolean) => void
  showPanelTab: (tab: PanelTab) => void
  setSearch: (s: string) => void
  setShowArchived: (v: boolean) => void
  focusComposer: () => void
  /** Expand or collapse the details of every tool operation in the chat. */
  setToolDetails: (expanded: boolean) => void
  focusSearch: () => void
  requestFind: (cmd: 'open' | 'next' | 'previous') => void
  setWidths: (patch: { sidebarWidth?: number; filesWidth?: number }) => void
  setSelectedIds: (ids: string[]) => void
  /** Start the Claude process of several sessions, one after the other (staggered). */
  startSessions: (ids: string[]) => Promise<void>
  /** Stop the Claude process (and background tasks) of several sessions. */
  stopSessions: (ids: string[]) => Promise<void>
}

let toastSeq = 0

/** History requests on their way, by chat: a second request for the same chat waits for the first. */
const historyRequests = new Map<string, Promise<void>>()

/**
 * How much of a chat the window holds. A chat keeps adding rows while it runs — over a thousand an
 * hour in the busiest chats measured — and the window used to hold every one of them for every chat,
 * including all 43 chats' opening rows (70 MB) whether they were ever looked at or not. Now it holds
 * only the chat on screen and the few opened before it; past ROWS_MAX rows the oldest go, down to
 * about ROWS_KEEP (see shared/rows.ts), and a chat left behind keeps about ROWS_KEEP as well —
 * which also lets go of everything read in while scrolling up in it. Scrolling up reads them back
 * from the chat's transcript. The chat on screen loses rows only while it shows its end.
 */
const ROWS_MAX = 600
const ROWS_KEEP = 300
/** Chats besides the one on screen whose rows are kept, so going back to them is immediate. */
const RECENT_CHATS_KEPT = 3

/** A row whose update came in: the window's copy put in its place (or at the end, for a new row). */
function upsertMessage(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id)
  if (idx >= 0) {
    const next = list.slice()
    next[idx] = msg
    return next
  }
  // A row the window does not have that is older than the first one it has: the window let go of
  // that part of the chat, and the row belongs there, not at the end.
  if (list.length && msg.ts < list[0].ts) return list
  return [...list, msg]
}

/** A background task Claude Code still reports as running, by the chat's live state. */
function taskRunningIn(live: SessionLiveState | undefined): (taskId: string) => boolean {
  const ids = new Set((live?.backgroundTasks ?? []).map((t) => t.taskId))
  return (taskId) => ids.has(taskId)
}

/** Chats whose older rows are being let go of right now. */
const trimming = new Set<string>()
/** When letting go of a chat's rows last found no line to cut at: not tried again for a minute. */
const trimFailedAt = new Map<string, number>()
/** Rows asked for whole (an update named a subagent step the window lacks), so each is asked once. */
const rowRequests = new Set<string>()

export const defaultFiles = (): FilesState => ({ open: [], expanded: [], tab: 'files' })
const defaultGit = (): GitState => ({ loading: false })

export const useStore = create<State>((set, get) => ({
  ready: false,
  theme: { systemDark: localStorage.getItem('theme-dark') !== '0', accent: '#007aff' },
  usage: emptyUsageState(),
  auth: { status: 'unknown', checkedAt: 0 },
  update: { status: 'idle', currentVersion: '', log: [], autoRestart: true },
  providers: [],
  providersAt: 0,
  records: {},
  live: {},
  groups: [],
  messages: {},
  sentQueue: {},
  composerRestore: {},
  historyLoaded: {},
  rowsFrom: {},
  trimmable: {},
  following: {},
  recentChats: [],
  earlierBusy: {},
  dialog: null,
  settingsTab: null,
  sidebarOpen: true,
  filesOpen: true,
  sidebarWidth: Number(localStorage.getItem('sidebarWidth') || 270),
  filesWidth: Number(localStorage.getItem('filesWidth') || 360),
  search: '',
  showArchived: false,
  toasts: [],
  files: loadFilesState(),
  git: {},
  composerFocusNonce: 0,
  toolExpandNonce: 0,
  toolDetails: null,
  searchFocusNonce: 0,
  findRequest: { cmd: 'open', nonce: 0 },
  selectedIds: [],
  bulkBusy: {},

  init: async () => {
    const [info, settings, list, theme, usage, update] = await Promise.all([
      window.api.app.info(),
      window.api.settings.get(),
      window.api.sessions.list(),
      window.api.app.theme().catch(() => get().theme),
      window.api.usage.get().catch(() => get().usage),
      window.api.update.state().catch(() => get().update)
    ])
    const records: Record<string, SessionRecord> = {}
    const live: Record<string, SessionLiveState> = {}
    for (const r of list.records) records[r.id] = r
    for (const l of list.live) live[l.id] = l
    applyTheme(settings, theme)
    set({ appInfo: info, settings, theme, usage, update, records, live, groups: list.groups ?? [], ready: true })
    void get().loadProviders()
    window.api.auth.state().then((auth) => set({ auth })).catch(() => undefined)
    const last = localStorage.getItem('activeId')
    const initial = last && records[last] ? last : currentOrder({ records, groups: list.groups ?? [], showArchived: false, settings })[0]?.id
    if (initial) await get().selectSession(initial)
    window.api.app
      .startupNotice()
      .then((n) => {
        if (n) get().toast(n.text, n.kind)
      })
      .catch(() => undefined)
  },

  setAuth: (auth) => set({ auth }),

  loadProviders: async (refresh = false) => {
    if (!refresh && get().providers.length && Date.now() - get().providersAt < 10 * 60_000) return
    try {
      const providers = await window.api.providers.list(refresh)
      set({ providers, providersAt: Date.now(), providersError: undefined })
    } catch (err) {
      set({ providersAt: Date.now(), providersError: (err as Error).message })
    }
  },

  forkSession: async (id, name) => {
    try {
      const record = await window.api.sessions.fork(id, name)
      set((s) => ({ records: { ...s.records, [record.id]: record } }))
      await get().selectSession(record.id)
      get().toast(`Forked into "${record.title}". The original chat is unchanged.`, 'success')
    } catch (err) {
      get().toast(`Fork failed: ${(err as Error).message}`, 'error')
    }
  },

  reloadSessions: async () => {
    const list = await window.api.sessions.list()
    const records: Record<string, SessionRecord> = {}
    const live: Record<string, SessionLiveState> = {}
    for (const r of list.records) records[r.id] = r
    for (const l of list.live) live[l.id] = l
    // The chats themselves are kept. This runs when the window's link to the session host was
    // re-made, which happens on its own from time to time (a broken connection, a host replaced by
    // an update), and emptying every chat here is what used to make a chat that had been open for
    // hours say "Loading history…" again. Only the "already read" marks go, so that each chat is
    // read again — from its own record, in milliseconds — the next time it is opened.
    set((s) => ({ records, live, groups: list.groups ?? [], messages: s.messages, historyLoaded: {}, rowsFrom: {}, trimmable: {} }))
    const id = get().activeId
    if (id && records[id]) await get().ensureHistory(id)
    else if (id) set({ activeId: undefined })
  },

  applyEvent: (e) => {
    switch (e.type) {
      case 'state':
        set((s) => {
          const prev = s.live[e.state.id]
          const wasBusy = prev && (prev.status === 'running' || prev.status === 'requires_action' || prev.status === 'starting')
          const nowQuiet = e.state.status === 'idle' || e.state.status === 'stopped' || e.state.status === 'error'
          // The command and model lists come only when they changed; otherwise the window's own stay.
          const state = e.keeps ? { ...e.state, ...Object.fromEntries(e.keeps.map((k) => [k, prev?.[k]])) } : e.state
          const patch: Partial<State> = { live: { ...s.live, [e.state.id]: state } }
          if (wasBusy && nowQuiet && s.sentQueue[e.state.id]?.length) patch.sentQueue = { ...s.sentQueue, [e.state.id]: [] }
          return patch
        })
        break
      case 'record':
        set((s) => ({ records: { ...s.records, [e.record.id]: e.record } }))
        break
      case 'groups':
        set({ groups: e.groups })
        break
      case 'record-removed':
        set((s) => {
          const records = { ...s.records }
          const live = { ...s.live }
          const messages = { ...s.messages }
          delete records[e.id]
          delete live[e.id]
          delete messages[e.id]
          return { records, live, messages, activeId: s.activeId === e.id ? undefined : s.activeId, selectedIds: s.selectedIds.filter((x) => x !== e.id) }
        })
        break
      case 'message': {
        // Only the chats the window holds: every running chat sends its updates here, and a chat
        // that is opened later is read whole from the session host then.
        if (!holdsChat(get(), e.sessionId)) break
        const list = get().messages[e.sessionId] ?? []
        let message = e.message
        if (e.keeps) {
          const r = withKeptChildren(
            list.find((m) => m.id === message.id),
            message
          )
          message = r.message
          if (r.missing) void fetchRow(e.sessionId, message.id)
        }
        set((s) => ({ messages: { ...s.messages, [e.sessionId]: upsertMessage(s.messages[e.sessionId] ?? [], message) } }))
        if ((get().messages[e.sessionId]?.length ?? 0) > ROWS_MAX) void trimChat(e.sessionId, ROWS_MAX)
        break
      }
      case 'message-removed':
        if (!holdsChat(get(), e.sessionId)) break
        set((s) => ({ messages: { ...s.messages, [e.sessionId]: (s.messages[e.sessionId] ?? []).filter((m) => m.id !== e.messageId) } }))
        break
      case 'messages-reset':
        if (!holdsChat(get(), e.sessionId)) break
        set((s) => ({
          messages: { ...s.messages, [e.sessionId]: e.messages },
          historyLoaded: { ...s.historyLoaded, [e.sessionId]: true },
          rowsFrom: { ...s.rowsFrom, [e.sessionId]: e.from }
        }))
        break
      case 'focus':
        void get().selectSession(e.sessionId)
        break
    }
  },

  selectSession: async (id) => {
    const left = get().activeId
    set((s) => ({ activeId: id, filesOpen: id ? (s.files[id]?.panelOpen ?? true) : s.filesOpen }))
    if (id) keepRecent(id)
    // The chat left behind keeps only its newest rows: what was read in while scrolling up in it
    // (its pictures included) goes, and is read again from the file if it is scrolled up once more.
    if (left && left !== id && get().historyLoaded[left]) void trimChat(left, ROWS_KEEP)
    if (id) localStorage.setItem('activeId', id)
    await window.api.sessions.setActive(id)
    if (id) {
      if (!get().files[id]) set((s) => ({ files: { ...s.files, [id]: defaultFiles() } }))
      await get().ensureHistory(id)
    }
  },

  ensureHistory: async (id) => {
    if (get().historyLoaded[id]) return
    // Clicking a chat again while it is still loading asks for nothing new: the answer on its way
    // is the same, and every extra copy of a long chat is more for the app to carry.
    const pending = historyRequests.get(id)
    if (pending) return pending
    const request = (async () => {
      try {
        const page = await window.api.sessions.history(id)
        const msgs = page.messages
        set((s) => {
          // Live messages may have arrived while loading; merge by id. Rows the window read from
          // further back than the page begins go (only a host of 1.0.55 on says where it begins):
          // the chat now begins where the page does, and scrolling up reads them again from there.
          const existing = s.messages[id] ?? []
          const byId = new Map(msgs.map((m) => [m.id, m]))
          const first = typeof page.from === 'number' ? msgs[0] : undefined
          for (const m of existing) if (!byId.has(m.id) && (!first || m.ts >= first.ts)) byId.set(m.id, m)
          return {
            messages: { ...s.messages, [id]: [...byId.values()] },
            historyLoaded: { ...s.historyLoaded, [id]: true },
            rowsFrom: { ...s.rowsFrom, [id]: page.from },
            trimmable: { ...s.trimmable, [id]: page.trimmable }
          }
        })
      } catch (err) {
        get().toast(`Failed to load history: ${(err as Error).message}`, 'error')
      } finally {
        historyRequests.delete(id)
      }
    })()
    historyRequests.set(id, request)
    return request
  },

  loadEarlier: async (id) => {
    if (get().earlierBusy[id]) return false
    set((s) => ({ earlierBusy: { ...s.earlierBusy, [id]: true } }))
    try {
      const { messages, from } = await window.api.sessions.earlier(id, get().rowsFrom[id])
      // Where the chat now begins in the file (a host of 1.0.54 or older keeps that place itself).
      if (typeof from === 'number') set((s) => ({ rowsFrom: { ...s.rowsFrom, [id]: from } }))
      if (!messages.length) return false
      let added = 0
      set((s) => {
        const existing = s.messages[id] ?? []
        const have = new Set(existing.map((m) => m.id))
        // They go above the chat in the order the transcript has them, which is the order the chat
        // was written in. It is not always the order of the clock — a compaction rewrites the file
        // and the times of the entries around it overlap — and the transcript's own order is the
        // one to follow there.
        const older = messages.filter((m) => !have.has(m.id))
        added = older.length
        return older.length ? { messages: { ...s.messages, [id]: [...older, ...existing] } } : {}
      })
      return added > 0
    } catch (err) {
      get().toast(`Could not read earlier messages: ${(err as Error).message}`, 'error')
      return false
    } finally {
      set((s) => ({ earlierBusy: { ...s.earlierBusy, [id]: false } }))
    }
  },

  send: async (id, text, images) => {
    // "!" at the start runs the line as a shell command, as in the terminal ("！" is the same key
    // typed with a Chinese input method on).
    if (/^[!！]/.test(text) && !images?.length) {
      try {
        await window.api.sessions.runShell(id, text.slice(1))
      } catch (err) {
        get().restoreComposer(id, text)
        get().toast((err as Error).message, 'error')
      }
      return
    }
    // "/branch [name]" forks the chat, as Claude Code's own /branch does.
    const branch = /^\/branch(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (branch && !images?.length) {
      await get().forkSession(id, branch[1])
      return
    }
    const entry = { text, images: images ?? [] }
    set((s) => ({ sentQueue: { ...s.sentQueue, [id]: [...(s.sentQueue[id] ?? []), entry] } }))
    try {
      // The id the prompt has in the chat comes back here, so a prompt that is still waiting can be
      // taken out of Claude Code's queue again even before its row has reached the chat.
      const messageId = await window.api.sessions.send(id, text, images)
      set((s) => ({ sentQueue: { ...s.sentQueue, [id]: (s.sentQueue[id] ?? []).map((q) => (q === entry ? { ...q, id: messageId } : q)) } }))
    } catch (err) {
      set((s) => ({ sentQueue: { ...s.sentQueue, [id]: (s.sentQueue[id] ?? []).filter((q) => q.text !== text) } }))
      get().toast(`Send failed: ${(err as Error).message}`, 'error')
    }
  },

  interruptSession: async (id) => {
    const queued = get().sentQueue[id] ?? []
    if (queued.length) {
      const text = queued.map((q) => q.text).filter(Boolean).join('\n\n')
      const images = queued.flatMap((q) => q.images)
      set((s) => ({
        sentQueue: { ...s.sentQueue, [id]: [] },
        composerRestore: { ...s.composerRestore, [id]: { text, images, nonce: (s.composerRestore[id]?.nonce ?? 0) + 1 } }
      }))
    }
    try {
      await window.api.sessions.interrupt(id)
    } catch (err) {
      get().toast(`Interrupt failed: ${(err as Error).message}`, 'error')
    }
  },

  takeBackQueued: async (id, messageId, toComposer) => {
    try {
      const r = await window.api.sessions.cancelQueued(id, messageId)
      if (!r.cancelled) {
        get().toast('Claude had already taken that prompt off the queue, so it is being answered.', 'info')
        return false
      }
      set((s) => ({ sentQueue: { ...s.sentQueue, [id]: (s.sentQueue[id] ?? []).filter((q) => (q.id ? q.id !== messageId : q.text !== r.text)) } }))
      if (toComposer) get().restoreComposer(id, r.text)
      return true
    } catch (err) {
      get().toast(`Taking the prompt back failed: ${(err as Error).message}`, 'error')
      return false
    }
  },

  restoreComposer: (id, text) => {
    set((s) => ({ composerRestore: { ...s.composerRestore, [id]: { text, images: [], nonce: (s.composerRestore[id]?.nonce ?? 0) + 1 } } }))
    get().focusComposer()
  },

  rewind: async (id, messageId, restoreFiles) => {
    try {
      const r = await window.api.sessions.rewind(id, messageId, restoreFiles)
      set((s) => ({
        sentQueue: { ...s.sentQueue, [id]: [] },
        composerRestore: { ...s.composerRestore, [id]: { text: r.text, images: [], nonce: (s.composerRestore[id]?.nonce ?? 0) + 1 } }
      }))
      const files = restoreFiles ? `, ${r.filesRestored} file${r.filesRestored === 1 ? '' : 's'} put back` : ''
      const skipped = r.filesSkipped ? `, ${r.filesSkipped} skipped (links)` : ''
      const claude = r.restarted ? ' Claude Code was restarted at that point, and the' : ' The'
      const cut = r.cut ? ' The chat transcript was cut back to that prompt; the removed part is kept beside it.' : ''
      get().toast(`Rewound to your earlier prompt${files}${skipped}.${claude} prompt is back in the input box.${cut}`, 'success')
    } catch (err) {
      get().toast(`Rewind failed: ${(err as Error).message}`, 'error')
      throw err
    }
  },

  answerPermission: async (id, requestId, decision) => {
    try {
      await window.api.sessions.answerPermission(id, requestId, decision)
    } catch (err) {
      get().toast(`Failed: ${(err as Error).message}`, 'error')
    }
  },

  setDialog: (dialog) => set({ dialog, settingsTab: dialog === 'settings' ? get().settingsTab : null }),
  setFollowing: (id, following) => {
    if (get().following[id] === following) return
    set((s) => ({ following: { ...s.following, [id]: following } }))
    // Back at the end of a chat that grew while it was scrolled up in.
    if (following && (get().messages[id]?.length ?? 0) > ROWS_MAX) void trimChat(id, ROWS_MAX)
  },
  openSettings: (tab) => set({ dialog: 'settings', settingsTab: tab ?? null }),
  setUpdate: (update) => set({ update }),

  toast: (text, kind = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setSettings: async (patch) => {
    const settings = await window.api.settings.set(patch)
    applyTheme(settings, get().theme)
    set({ settings })
    if (patch.providers) void get().loadProviders(true)
  },
  receiveSettings: (settings) => {
    applyTheme(settings, get().theme)
    set({ settings })
  },
  setTheme: (theme) => {
    const s = get().settings
    if (s) applyTheme(s, theme)
    set({ theme })
  },
  setUsage: (usage) => set({ usage }),

  openFile: (sessionId, path, line) => {
    set((s) => {
      const fs = s.files[sessionId] ?? defaultFiles()
      const exists = fs.open.find((t) => t.path === path)
      const open = exists ? fs.open.map((t) => (t.path === path ? { ...t, line, version: t.version + 1 } : t)) : [...fs.open, { path, line, version: 0 }]
      return { filesOpen: s.activeId === sessionId ? true : s.filesOpen, files: { ...s.files, [sessionId]: { ...fs, open, active: path, tab: 'files', panelOpen: true } } }
    })
  },
  closeFile: (sessionId, path) => {
    set((s) => {
      const fs = s.files[sessionId] ?? defaultFiles()
      const open = fs.open.filter((t) => t.path !== path)
      const active = fs.active === path ? open[open.length - 1]?.path : fs.active
      return { files: { ...s.files, [sessionId]: { ...fs, open, active } } }
    })
  },
  setActiveFile: (sessionId, path) => {
    set((s) => ({ files: { ...s.files, [sessionId]: { ...(s.files[sessionId] ?? defaultFiles()), active: path } } }))
  },
  toggleExpanded: (sessionId, dir, open) => {
    set((s) => {
      const fs = s.files[sessionId] ?? defaultFiles()
      const isOpen = fs.expanded.includes(dir)
      const want = open ?? !isOpen
      const expanded = want ? (isOpen ? fs.expanded : [...fs.expanded, dir]) : fs.expanded.filter((d) => d !== dir)
      return { files: { ...s.files, [sessionId]: { ...fs, expanded } } }
    })
  },
  setFilesTab: (sessionId, tab) => set((s) => ({ files: { ...s.files, [sessionId]: { ...(s.files[sessionId] ?? defaultFiles()), tab } } })),
  setRevealPath: (sessionId, p) => set((s) => ({ files: { ...s.files, [sessionId]: { ...(s.files[sessionId] ?? defaultFiles()), revealPath: p } } })),
  bumpFileVersion: (path) =>
    set((s) => {
      const files: Record<string, FilesState> = {}
      let changed = false
      for (const [sid, fs] of Object.entries(s.files)) {
        if (fs.open.some((t) => t.path === path)) {
          changed = true
          files[sid] = { ...fs, open: fs.open.map((t) => (t.path === path ? { ...t, version: t.version + 1 } : t)) }
        } else files[sid] = fs
      }
      return changed ? { files } : {}
    }),

  refreshGit: async (sessionId, opts) => {
    const record = get().records[sessionId]
    if (!record) return
    const cur = get().git[sessionId] ?? defaultGit()
    if (cur.loading && !opts?.fetch) return
    set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), loading: true } } }))
    try {
      if (opts?.fetch) {
        await window.api.git.fetch(record.cwd)
        set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), lastFetchAt: Date.now() } } }))
      }
      const status = await window.api.git.status(record.cwd)
      let log = cur.log
      if (status.info.isRepo && (opts?.log || !log)) log = await window.api.git.log(record.cwd, 30)
      set((s) => {
        const g = s.git[sessionId] ?? defaultGit()
        // Drop the selection when the file no longer has that kind of change.
        let selected = g.selected
        if (selected) {
          const f = status.files.find((x) => x.path === selected!.path)
          const still = f && (selected.staged ? f.index != null : f.worktree != null)
          if (!still) selected = undefined
        }
        return { git: { ...s.git, [sessionId]: { ...g, status, log: status.info.isRepo ? log : undefined, loading: false, error: undefined, selected, diff: selected ? g.diff : undefined } } }
      })
      const sel = get().git[sessionId]?.selected
      if (sel) void get().selectGitFile(sessionId, sel)
    } catch (err) {
      const message = (err as Error).message
      set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), loading: false, error: message } } }))
      if (!opts?.quiet) get().toast(`Git: ${message}`, 'error')
    }
  },

  selectGitFile: async (sessionId, sel) => {
    const record = get().records[sessionId]
    if (!record) return
    if (!sel) {
      set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), selected: undefined, diff: undefined } } }))
      return
    }
    set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), selected: sel, diffLoading: true } } }))
    try {
      const diff = await window.api.git.diff(record.cwd, sel.path, sel.staged)
      set((s) => {
        const g = s.git[sessionId] ?? defaultGit()
        if (g.selected?.path !== sel.path || g.selected?.staged !== sel.staged) return {}
        return { git: { ...s.git, [sessionId]: { ...g, diff, diffLoading: false } } }
      })
    } catch (err) {
      set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), diffLoading: false } } }))
      get().toast(`Git diff: ${(err as Error).message}`, 'error')
    }
  },

  runGit: async (sessionId, label, fn, opts) => {
    set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), busy: label } } }))
    try {
      await fn()
      if (opts?.successToast) get().toast(opts.successToast, 'success')
      return true
    } catch (err) {
      get().toast(`${label} failed: ${(err as Error).message}`, 'error')
      return false
    } finally {
      set((s) => ({ git: { ...s.git, [sessionId]: { ...(s.git[sessionId] ?? defaultGit()), busy: undefined } } }))
      void get().refreshGit(sessionId, { log: true, quiet: true })
    }
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleFiles: () => get().setFilesOpen(!get().filesOpen),
  setFilesOpen: (open) =>
    set((s) => {
      const id = s.activeId
      if (!id) return { filesOpen: open }
      return { filesOpen: open, files: { ...s.files, [id]: { ...(s.files[id] ?? defaultFiles()), panelOpen: open } } }
    }),
  showPanelTab: (tab) => {
    const id = get().activeId
    if (!id) return
    const cur = get().files[id] ?? defaultFiles()
    const wasOpen = get().filesOpen
    if (wasOpen && cur.tab === tab) {
      get().setFilesOpen(false)
      return
    }
    set((s) => ({ filesOpen: true, files: { ...s.files, [id]: { ...cur, tab, panelOpen: true } } }))
  },
  setSearch: (search) => set({ search }),
  setShowArchived: (showArchived) => set({ showArchived }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
  setToolDetails: (expanded) => {
    set((s) => ({ toolExpandNonce: s.toolExpandNonce + 1, toolDetails: expanded ? 'expand' : 'collapse' }))
    void get().setSettings({ toolCardsExpanded: expanded })
  },
  focusSearch: () => set((s) => ({ searchFocusNonce: s.searchFocusNonce + 1, sidebarOpen: true })),
  requestFind: (cmd) => set((s) => ({ findRequest: { cmd, nonce: s.findRequest.nonce + 1 } })),
  setWidths: (patch) => {
    if (patch.sidebarWidth) localStorage.setItem('sidebarWidth', String(patch.sidebarWidth))
    if (patch.filesWidth) localStorage.setItem('filesWidth', String(patch.filesWidth))
    set(patch)
  },
  setSelectedIds: (ids) => set({ selectedIds: ids.filter((id, i) => ids.indexOf(id) === i) }),

  startSessions: async (ids) => {
    const targets = ids.filter((id) => get().records[id] && !get().live[id]?.processAlive)
    if (!targets.length) {
      get().toast('Every selected session is already running.', 'info')
      return
    }
    set((s) => ({ bulkBusy: { ...s.bulkBusy, ...Object.fromEntries(targets.map((id) => [id, 'start'])) } }))
    let failed = 0
    for (let i = 0; i < targets.length; i++) {
      const id = targets[i]
      try {
        await window.api.sessions.start(id)
      } catch (err) {
        failed += 1
        get().toast(`${get().records[id]?.title ?? id}: ${(err as Error).message}`, 'error')
      } finally {
        set((s) => {
          const bulkBusy = { ...s.bulkBusy }
          delete bulkBusy[id]
          return { bulkBusy }
        })
      }
      // Stagger the starts: each Claude process loads settings, MCP servers and its transcript.
      if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 800))
    }
    get().toast(`Started ${targets.length - failed} of ${targets.length} session${targets.length === 1 ? '' : 's'}.`, failed ? 'error' : 'success')
  },

  stopSessions: async (ids) => {
    const targets = ids.filter((id) => get().records[id] && get().live[id]?.processAlive)
    if (!targets.length) {
      get().toast('None of the selected sessions is running.', 'info')
      return
    }
    set((s) => ({ bulkBusy: { ...s.bulkBusy, ...Object.fromEntries(targets.map((id) => [id, 'stop'])) } }))
    let failed = 0
    await Promise.all(
      targets.map(async (id) => {
        try {
          await window.api.sessions.stop(id)
        } catch (err) {
          failed += 1
          get().toast(`${get().records[id]?.title ?? id}: ${(err as Error).message}`, 'error')
        } finally {
          set((s) => {
            const bulkBusy = { ...s.bulkBusy }
            delete bulkBusy[id]
            return { bulkBusy }
          })
        }
      })
    )
    get().toast(`Stopped ${targets.length - failed} of ${targets.length} session${targets.length === 1 ? '' : 's'}.`, failed ? 'error' : 'success')
  }
}))

// ---------------------------------------------------------------------------
// Which chats the window holds, and how much of each (see ROWS_MAX).
// ---------------------------------------------------------------------------

type StoreState = ReturnType<typeof useStore.getState>

function holdsChat(s: StoreState, id: string): boolean {
  return Boolean(s.historyLoaded[id]) || historyRequests.has(id)
}

/** The chat just opened goes first; the chats beyond the few kept are let go of whole. */
function keepRecent(id: string): void {
  const s = useStore.getState()
  const recent = [id, ...s.recentChats.filter((x) => x !== id)]
  const kept = recent.slice(0, RECENT_CHATS_KEPT + 1)
  const dropped = recent.slice(RECENT_CHATS_KEPT + 1).filter((x) => !historyRequests.has(x))
  if (!dropped.length) {
    useStore.setState({ recentChats: kept })
    return
  }
  useStore.setState((st) => {
    const messages = { ...st.messages }
    const historyLoaded = { ...st.historyLoaded }
    const rowsFrom = { ...st.rowsFrom }
    for (const x of dropped) {
      delete messages[x]
      delete historyLoaded[x]
      delete rowsFrom[x]
    }
    return { recentChats: kept, messages, historyLoaded, rowsFrom }
  })
}

/**
 * Let go of the older rows of a chat holding more than `max`, down to about ROWS_KEEP, where the
 * session host finds that everything let go of lies before the line the kept part begins at
 * (shared/rows.ts). Not while the chat is on screen and scrolled up (the rows being read would
 * vanish), nor while it is being read further back, nor with a session host that cannot say where.
 */
async function trimChat(id: string, max: number): Promise<void> {
  const s = useStore.getState()
  const from = s.rowsFrom[id]
  if (trimming.has(id) || !s.trimmable[id] || s.earlierBusy[id] || typeof from !== 'number') return
  if (Date.now() - (trimFailedAt.get(id) ?? 0) < 60_000) return
  if (s.activeId === id && !s.following[id]) return
  const rows = s.messages[id] ?? []
  const limit = trimLimit(rows, ROWS_KEEP, max, taskRunningIn(s.live[id]))
  if (limit <= 0) return
  trimming.add(id)
  try {
    const places = rows.slice(0, limit + 1).map(rowPlace)
    const cut = await window.api.sessions.cutPoint(id, places, from).catch(() => null)
    if (!cut) {
      trimFailedAt.set(id, Date.now())
      return
    }
    const now = useStore.getState()
    if (now.rowsFrom[id] !== from || now.earlierBusy[id]) return
    if (now.activeId === id && !now.following[id]) return
    const list = now.messages[id] ?? []
    // The rows above the cut must be the ones the host was asked about (nothing read in above them since).
    if (list[cut.index]?.id !== places[cut.index].id) return
    useStore.setState((st) => ({ messages: { ...st.messages, [id]: list.slice(cut.index) }, rowsFrom: { ...st.rowsFrom, [id]: cut.offset } }))
  } finally {
    trimming.delete(id)
  }
}

/** A row asked for whole, when an update of it named a subagent step the window does not have. */
async function fetchRow(id: string, rowId: string): Promise<void> {
  const key = `${id}:${rowId}`
  if (rowRequests.has(key)) return
  rowRequests.add(key)
  try {
    const row = await window.api.sessions.row(id, rowId)
    if (!row || !holdsChat(useStore.getState(), id)) return
    useStore.setState((st) => {
      const list = st.messages[id] ?? []
      return list.some((m) => m.id === rowId) ? { messages: { ...st.messages, [id]: upsertMessage(list, row) } } : {}
    })
  } catch {
    /* the next update of the row brings it */
  } finally {
    rowRequests.delete(key)
  }
}

export interface SidebarSection {
  /** 'group' / 'ungrouped' in the groups view, 'pinned' / 'recent' in the recent view. */
  kind: 'group' | 'ungrouped' | 'pinned' | 'recent'
  group: SessionGroup | null
  title: string
  sessions: SessionRecord[]
}

function visible(records: Record<string, SessionRecord>, showArchived: boolean): SessionRecord[] {
  return Object.values(records).filter((r) => showArchived || !r.archived)
}

/**
 * Sidebar layout.
 *  - groups view: one section per group (in group order) with its sessions, then the ungrouped ones;
 *  - recent view: a "Pinned" section and a "Recent" section.
 * Inside a section: pinned first, then by your last prompt (newest first) or the manual position.
 */
export function sidebarSections(records: Record<string, SessionRecord>, groups: SessionGroup[], showArchived: boolean, view: SidebarView = 'groups', sort: SidebarSort = 'lastPrompt'): SidebarSection[] {
  const cmp = comparatorFor(sort)
  const all = visible(records, showArchived)
  if (view === 'recent') {
    const pinned = all.filter((r) => r.pinned).sort(cmp)
    const rest = all.filter((r) => !r.pinned).sort(cmp)
    return [
      { kind: 'pinned', group: null, title: 'Pinned', sessions: pinned },
      { kind: 'recent', group: null, title: 'Recent', sessions: rest }
    ]
  }
  const known = new Set(groups.map((g) => g.id))
  const sections: SidebarSection[] = [...groups]
    .sort((a, b) => a.order - b.order)
    .map((g) => ({ kind: 'group' as const, group: g, title: g.name, sessions: all.filter((r) => r.groupId === g.id).sort(cmp) }))
  sections.push({ kind: 'ungrouped', group: null, title: 'Ungrouped', sessions: all.filter((r) => !r.groupId || !known.has(r.groupId)).sort(cmp) })
  return sections
}

/** Every visible session in sidebar order (used for ⌘1…9, next/previous and the statistics bar). */
export function flattenSessions(records: Record<string, SessionRecord>, groups: SessionGroup[], showArchived: boolean, view: SidebarView = 'groups', sort: SidebarSort = 'lastPrompt'): SessionRecord[] {
  return sidebarSections(records, groups, showArchived, view, sort).flatMap((sec) => sec.sessions)
}

/** Sidebar order of the current settings (helper for callers that only have the store state). */
export function currentOrder(s: Pick<State, 'records' | 'groups' | 'showArchived' | 'settings'>): SessionRecord[] {
  return flattenSessions(s.records, s.groups, s.showArchived, s.settings?.sidebarView ?? 'groups', s.settings?.sidebarSort ?? 'lastPrompt')
}

// ---------------------------------------------------------------------------
// Open files / expanded folders / panel tab per session survive restarts.
// ---------------------------------------------------------------------------

const FILES_KEY = 'files-state'

function loadFilesState(): Record<string, FilesState> {
  try {
    const raw = JSON.parse(localStorage.getItem(FILES_KEY) || '{}') as Record<string, Partial<FilesState>>
    const out: Record<string, FilesState> = {}
    for (const [id, f] of Object.entries(raw)) {
      if (!f || typeof f !== 'object') continue
      out[id] = {
        open: (f.open ?? []).filter((t) => t && typeof t.path === 'string').map((t) => ({ path: t.path, line: t.line, version: 0 })),
        active: f.active,
        expanded: Array.isArray(f.expanded) ? f.expanded : [],
        tab: f.tab === 'tasks' || f.tab === 'git' ? f.tab : 'files',
        panelOpen: typeof f.panelOpen === 'boolean' ? f.panelOpen : undefined
      }
    }
    return out
  } catch {
    return {}
  }
}

let filesSaveTimer: ReturnType<typeof setTimeout> | null = null
useStore.subscribe((s, prev) => {
  if (s.files === prev.files) return
  if (filesSaveTimer) clearTimeout(filesSaveTimer)
  filesSaveTimer = setTimeout(() => {
    filesSaveTimer = null
    const out: Record<string, Omit<FilesState, 'revealPath'>> = {}
    for (const [id, f] of Object.entries(s.files)) {
      if (!s.records[id]) continue
      out[id] = { open: f.open.map((t) => ({ path: t.path, line: t.line, version: 0 })), active: f.active, expanded: f.expanded, tab: f.tab, panelOpen: f.panelOpen }
    }
    try {
      localStorage.setItem(FILES_KEY, JSON.stringify(out))
    } catch {
      /* quota */
    }
  }, 500)
})

// Debug aid: with the development HTTP endpoint (CLAUDEGUI_DEBUG=1) the store can be read and
// filled with example sessions from the command line to check the interface without a real host.
if (import.meta.env.DEV) (window as unknown as { __store?: unknown }).__store = useStore
