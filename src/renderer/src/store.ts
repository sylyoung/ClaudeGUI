import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  ChatMessage,
  GitCommitInfo,
  GitDiffResult,
  GitStatusResult,
  ImageAttachment,
  PermissionDecision,
  SessionEvent,
  SessionGroup,
  SessionLiveState,
  SessionRecord,
  SidebarSort,
  SidebarView,
  ThemeInfo,
  UpdateState,
  UsageSnapshot
} from '@shared/types'
import { applyTheme } from './lib/theme'
import { comparatorFor } from '@shared/util'

export type DialogKind = null | 'new-session' | 'import-session' | 'settings'
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
  usage: UsageSnapshot
  update: UpdateState
  records: Record<string, SessionRecord>
  live: Record<string, SessionLiveState>
  groups: SessionGroup[]
  messages: Record<string, ChatMessage[]>
  /** Prompts sent during the current turn (restored into the composer when the turn is interrupted). */
  sentQueue: Record<string, { text: string; images: ImageAttachment[] }[]>
  /** Text to put back into the composer of a session (set by interruptSession). */
  composerRestore: Record<string, { text: string; images: ImageAttachment[]; nonce: number }>
  historyLoaded: Record<string, boolean>
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
  searchFocusNonce: number
  /** Multi-selection in the sidebar (⌘-click / ⇧-click); bulk actions apply to these ids. */
  selectedIds: string[]
  /** Ids whose process is being started / stopped by a bulk action (for progress display). */
  bulkBusy: Record<string, 'start' | 'stop'>

  init: () => Promise<void>
  applyEvent: (e: SessionEvent) => void
  selectSession: (id: string | undefined) => Promise<void>
  ensureHistory: (id: string) => Promise<void>
  send: (id: string, text: string, images?: { mediaType: string; data: string; name?: string }[]) => Promise<void>
  /** Stop the current turn and put the prompts of that turn back into the composer. */
  interruptSession: (id: string) => Promise<void>
  answerPermission: (id: string, requestId: string, decision: PermissionDecision) => Promise<void>
  setDialog: (d: DialogKind) => void
  openSettings: (tab?: SettingsTab) => void
  setUpdate: (u: UpdateState) => void
  /** Re-read records and live states from the main process (after the session host was replaced). */
  reloadSessions: () => Promise<void>
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  setSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** Settings pushed from the main process (menu changes etc.). */
  receiveSettings: (s: AppSettings) => void
  setTheme: (t: ThemeInfo) => void
  setUsage: (u: UsageSnapshot) => void
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
  focusSearch: () => void
  setWidths: (patch: { sidebarWidth?: number; filesWidth?: number }) => void
  setSelectedIds: (ids: string[]) => void
  /** Start the Claude process of several sessions, one after the other (staggered). */
  startSessions: (ids: string[]) => Promise<void>
  /** Stop the Claude process (and background tasks) of several sessions. */
  stopSessions: (ids: string[]) => Promise<void>
}

let toastSeq = 0

function upsertMessage(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id)
  if (idx >= 0) {
    const next = list.slice()
    next[idx] = msg
    return next
  }
  return [...list, msg]
}

export const defaultFiles = (): FilesState => ({ open: [], expanded: [], tab: 'files' })
const defaultGit = (): GitState => ({ loading: false })

export const useStore = create<State>((set, get) => ({
  ready: false,
  theme: { systemDark: localStorage.getItem('theme-dark') !== '0', accent: '#007aff' },
  usage: { fetchedAt: 0, source: 'none', windows: [] },
  update: { status: 'idle', currentVersion: '', log: [], autoRestart: true },
  records: {},
  live: {},
  groups: [],
  messages: {},
  sentQueue: {},
  composerRestore: {},
  historyLoaded: {},
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
  searchFocusNonce: 0,
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

  reloadSessions: async () => {
    const list = await window.api.sessions.list()
    const records: Record<string, SessionRecord> = {}
    const live: Record<string, SessionLiveState> = {}
    for (const r of list.records) records[r.id] = r
    for (const l of list.live) live[l.id] = l
    set({ records, live, groups: list.groups ?? [], messages: {}, historyLoaded: {} })
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
          const patch: Partial<State> = { live: { ...s.live, [e.state.id]: e.state } }
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
      case 'message':
        set((s) => ({ messages: { ...s.messages, [e.sessionId]: upsertMessage(s.messages[e.sessionId] ?? [], e.message) } }))
        break
      case 'message-removed':
        set((s) => ({ messages: { ...s.messages, [e.sessionId]: (s.messages[e.sessionId] ?? []).filter((m) => m.id !== e.messageId) } }))
        break
      case 'messages-reset':
        set((s) => ({ messages: { ...s.messages, [e.sessionId]: e.messages }, historyLoaded: { ...s.historyLoaded, [e.sessionId]: true } }))
        break
      case 'focus':
        void get().selectSession(e.sessionId)
        break
    }
  },

  selectSession: async (id) => {
    set((s) => ({ activeId: id, filesOpen: id ? (s.files[id]?.panelOpen ?? true) : s.filesOpen }))
    if (id) localStorage.setItem('activeId', id)
    await window.api.sessions.setActive(id)
    if (id) {
      if (!get().files[id]) set((s) => ({ files: { ...s.files, [id]: defaultFiles() } }))
      await get().ensureHistory(id)
    }
  },

  ensureHistory: async (id) => {
    if (get().historyLoaded[id]) return
    try {
      const msgs = await window.api.sessions.history(id)
      set((s) => {
        // Live messages may have arrived while loading; merge by id.
        const existing = s.messages[id] ?? []
        const byId = new Map(msgs.map((m) => [m.id, m]))
        for (const m of existing) if (!byId.has(m.id)) byId.set(m.id, m)
        return { messages: { ...s.messages, [id]: [...byId.values()] }, historyLoaded: { ...s.historyLoaded, [id]: true } }
      })
    } catch (err) {
      get().toast(`Failed to load history: ${(err as Error).message}`, 'error')
    }
  },

  send: async (id, text, images) => {
    set((s) => ({ sentQueue: { ...s.sentQueue, [id]: [...(s.sentQueue[id] ?? []), { text, images: images ?? [] }] } }))
    try {
      await window.api.sessions.send(id, text, images)
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

  answerPermission: async (id, requestId, decision) => {
    try {
      await window.api.sessions.answerPermission(id, requestId, decision)
    } catch (err) {
      get().toast(`Failed: ${(err as Error).message}`, 'error')
    }
  },

  setDialog: (dialog) => set({ dialog, settingsTab: dialog === 'settings' ? get().settingsTab : null }),
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
  focusSearch: () => set((s) => ({ searchFocusNonce: s.searchFocusNonce + 1, sidebarOpen: true })),
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
