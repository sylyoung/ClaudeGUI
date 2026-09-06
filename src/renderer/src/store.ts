import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  ChatMessage,
  PermissionDecision,
  SessionEvent,
  SessionLiveState,
  SessionRecord
} from '@shared/types'

export type DialogKind = null | 'new-session' | 'import-session' | 'settings'

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

export interface FilesState {
  open: FileTab[]
  active?: string
  /** set of expanded directories in the tree */
  expanded: string[]
  revealPath?: string
  tab: 'files' | 'tasks'
}

interface State {
  ready: boolean
  appInfo?: AppInfo
  settings?: AppSettings
  records: Record<string, SessionRecord>
  live: Record<string, SessionLiveState>
  messages: Record<string, ChatMessage[]>
  historyLoaded: Record<string, boolean>
  activeId?: string
  dialog: DialogKind
  sidebarOpen: boolean
  filesOpen: boolean
  sidebarWidth: number
  filesWidth: number
  search: string
  showArchived: boolean
  toasts: Toast[]
  files: Record<string, FilesState>
  composerFocusNonce: number
  searchFocusNonce: number

  init: () => Promise<void>
  applyEvent: (e: SessionEvent) => void
  selectSession: (id: string | undefined) => Promise<void>
  ensureHistory: (id: string) => Promise<void>
  send: (id: string, text: string, images?: { mediaType: string; data: string; name?: string }[]) => Promise<void>
  answerPermission: (id: string, requestId: string, decision: PermissionDecision) => Promise<void>
  setDialog: (d: DialogKind) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  setSettings: (patch: Partial<AppSettings>) => Promise<void>
  openFile: (sessionId: string, path: string, line?: number) => void
  closeFile: (sessionId: string, path: string) => void
  setActiveFile: (sessionId: string, path: string | undefined) => void
  toggleExpanded: (sessionId: string, dir: string, open?: boolean) => void
  setFilesTab: (sessionId: string, tab: FilesState['tab']) => void
  setRevealPath: (sessionId: string, p: string | undefined) => void
  bumpFileVersion: (path: string) => void
  toggleSidebar: () => void
  toggleFiles: () => void
  setSearch: (s: string) => void
  setShowArchived: (v: boolean) => void
  focusComposer: () => void
  focusSearch: () => void
  setWidths: (patch: { sidebarWidth?: number; filesWidth?: number }) => void
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

export const useStore = create<State>((set, get) => ({
  ready: false,
  records: {},
  live: {},
  messages: {},
  historyLoaded: {},
  dialog: null,
  sidebarOpen: true,
  filesOpen: true,
  sidebarWidth: Number(localStorage.getItem('sidebarWidth') || 270),
  filesWidth: Number(localStorage.getItem('filesWidth') || 340),
  search: '',
  showArchived: false,
  toasts: [],
  files: {},
  composerFocusNonce: 0,
  searchFocusNonce: 0,

  init: async () => {
    const [info, settings, list] = await Promise.all([window.api.app.info(), window.api.settings.get(), window.api.sessions.list()])
    const records: Record<string, SessionRecord> = {}
    const live: Record<string, SessionLiveState> = {}
    for (const r of list.records) records[r.id] = r
    for (const l of list.live) live[l.id] = l
    set({ appInfo: info, settings, records, live, ready: true })
    const last = localStorage.getItem('activeId')
    const initial = last && records[last] ? last : list.records[0]?.id
    if (initial) await get().selectSession(initial)
  },

  applyEvent: (e) => {
    switch (e.type) {
      case 'state':
        set((s) => ({ live: { ...s.live, [e.state.id]: e.state } }))
        break
      case 'record':
        set((s) => ({ records: { ...s.records, [e.record.id]: e.record } }))
        break
      case 'record-removed':
        set((s) => {
          const records = { ...s.records }
          const live = { ...s.live }
          const messages = { ...s.messages }
          delete records[e.id]
          delete live[e.id]
          delete messages[e.id]
          return { records, live, messages, activeId: s.activeId === e.id ? undefined : s.activeId }
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
    set({ activeId: id })
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
    try {
      await window.api.sessions.send(id, text, images)
    } catch (err) {
      get().toast(`Send failed: ${(err as Error).message}`, 'error')
    }
  },

  answerPermission: async (id, requestId, decision) => {
    try {
      await window.api.sessions.answerPermission(id, requestId, decision)
    } catch (err) {
      get().toast(`Failed: ${(err as Error).message}`, 'error')
    }
  },

  setDialog: (dialog) => set({ dialog }),

  toast: (text, kind = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setSettings: async (patch) => {
    const settings = await window.api.settings.set(patch)
    set({ settings })
  },

  openFile: (sessionId, path, line) => {
    set((s) => {
      const fs = s.files[sessionId] ?? defaultFiles()
      const exists = fs.open.find((t) => t.path === path)
      const open = exists ? fs.open.map((t) => (t.path === path ? { ...t, line, version: t.version + 1 } : t)) : [...fs.open, { path, line, version: 0 }]
      return { filesOpen: true, files: { ...s.files, [sessionId]: { ...fs, open, active: path, tab: 'files' } } }
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
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleFiles: () => set((s) => ({ filesOpen: !s.filesOpen })),
  setSearch: (search) => set({ search }),
  setShowArchived: (showArchived) => set({ showArchived }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
  focusSearch: () => set((s) => ({ searchFocusNonce: s.searchFocusNonce + 1, sidebarOpen: true })),
  setWidths: (patch) => {
    if (patch.sidebarWidth) localStorage.setItem('sidebarWidth', String(patch.sidebarWidth))
    if (patch.filesWidth) localStorage.setItem('filesWidth', String(patch.filesWidth))
    set(patch)
  }
}))

/** Sessions ordered: pinned first, then by last activity. */
export function orderedSessions(records: Record<string, SessionRecord>, live: Record<string, SessionLiveState>, showArchived: boolean): SessionRecord[] {
  return Object.values(records)
    .filter((r) => showArchived || !r.archived)
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
      const la = live[a.id]?.lastActivityAt ?? a.lastActiveAt
      const lb = live[b.id]?.lastActivityAt ?? b.lastActiveAt
      return lb - la
    })
}
