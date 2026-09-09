import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Bot, CheckSquare, ChevronDown, ChevronRight, Clock, Cpu, Download, FolderPlus, LayoutList, Pin, PinOff, Play, Plus, Settings, SlidersHorizontal, Square, TerminalSquare, X } from 'lucide-react'
import type { SessionGroup, SessionLiveState, SessionRecord } from '@shared/types'
import { groupColorFor } from '@shared/colors'
import { lastPromptOf } from '@shared/util'
import { sidebarSections, useStore, type SidebarSection } from '@/store'
import { ContextMenu, type MenuItem } from './common/ContextMenu'
import { GroupColorPicker } from './common/GroupColorPicker'
import { basename, formatDateTime, sessionModelName, shortenPath, timeAgo } from '@/lib/format'
import { CONTEXT_COLOUR_RULE, contextLevel, contextPercent } from '@/lib/tasks'
import { StateMark } from './common/StateMark'
import { visualState } from '@/lib/sessionState'
import { sessionMenuItems } from '@/lib/sessionMenu'
import { isDarkTheme } from '@/lib/theme'
import { isComposing } from '@/lib/keys'

// ---------------------------------------------------------------------------------------------
// Drag & drop (pointer events: no HTML5 drag ghost, no "fly back" animation, no flicker)
// ---------------------------------------------------------------------------------------------

type DragItem = { kind: 'session'; id: string; title: string } | { kind: 'group'; id: string; name: string }

type DropTarget =
  /** manual order: insert before/after a row */
  | { kind: 'row'; groupId: string | undefined; overId: string; beforeId: string | undefined; pos: 'before' | 'after' }
  /** drop into a group (header or section area; position irrelevant in "last prompt" order) */
  | { kind: 'group'; groupId: string | undefined; label: string }
  /** recent view: pin / unpin by dropping into the section */
  | { kind: 'pin'; pinned: boolean }
  /** reorder groups */
  | { kind: 'group-order'; beforeGroupId: string | undefined; overGroupId: string; pos: 'before' | 'after' }

interface DragState {
  item: DragItem
  x: number
  y: number
  target: DropTarget | null
}

const DRAG_THRESHOLD = 6

/** Background-task / subagent / context chips of a session row. */
export function Indicators({ live, large }: { live: SessionLiveState | undefined; large?: boolean }) {
  const showCtx = useStore((s) => s.settings?.showContextInSidebar ?? true)
  const showTasks = useStore((s) => s.settings?.showTaskCountsInSidebar ?? true)
  if (!live) return null
  const pct = contextPercent(live)
  const vs = visualState(live)
  const size = large ? 12 : 11
  return (
    <span className={`indicators ${large ? 'large' : ''}`}>
      {showTasks && vs.background > 0 && (
        <span className="chip bg" data-tip={`${vs.background} background shell${vs.background === 1 ? '' : 's'} / monitor${vs.background === 1 ? '' : 's'} running for this session (Tasks tab shows them)`}>
          <TerminalSquare size={size} /> {vs.background}
        </span>
      )}
      {showTasks && vs.subagents > 0 && (
        <span className="chip agent" data-tip={`${vs.subagents} subagent${vs.subagents === 1 ? '' : 's'} working for this session`}>
          <Bot size={size} /> {vs.subagents}
        </span>
      )}
      {showCtx && pct != null && (
        <span className={`ind ctx ${contextLevel(live)}`} data-tip={`Context window ${pct}% used${pct >= 85 ? ' — consider /compact' : ''}\n${CONTEXT_COLOUR_RULE}`}>
          <Cpu size={10} /> {pct}%
        </span>
      )}
    </span>
  )
}

export function Sidebar() {
  const records = useStore((s) => s.records)
  const live = useStore((s) => s.live)
  const groups = useStore((s) => s.groups)
  const activeId = useStore((s) => s.activeId)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const showArchived = useStore((s) => s.showArchived)
  const setShowArchived = useStore((s) => s.setShowArchived)
  const selectSession = useStore((s) => s.selectSession)
  const setDialog = useStore((s) => s.setDialog)
  const toast = useStore((s) => s.toast)
  const appInfo = useStore((s) => s.appInfo)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const theme = useStore((s) => s.theme)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const selectedIds = useStore((s) => s.selectedIds)
  const setSelectedIds = useStore((s) => s.setSelectedIds)
  const startSessions = useStore((s) => s.startSessions)
  const stopSessions = useStore((s) => s.stopSessions)
  const bulkBusy = useStore((s) => s.bulkBusy)
  const files = useStore((s) => s.files)
  const searchNonce = useStore((s) => s.searchFocusNonce)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [folderCollapsed, setFolderCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [colorPick, setColorPick] = useState<{ x: number; y: number; group: SessionGroup } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [renamingSession, setRenamingSession] = useState<{ id: string; name: string } | null>(null)
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const newGroupRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef<string | null>(null)

  const view = settings?.sidebarView ?? 'groups'
  const sort = settings?.sidebarSort ?? 'lastPrompt'
  const groupByFolder = settings?.groupSessionsByFolder ?? false
  const dark = isDarkTheme(settings?.theme ?? 'system', theme.systemDark)
  const compact = sidebarWidth < 330

  useEffect(() => {
    if (searchNonce) searchRef.current?.focus()
  }, [searchNonce])
  useEffect(() => {
    if (newGroup !== null) newGroupRef.current?.focus()
  }, [newGroup])

  const q = search.trim().toLowerCase()
  const allSections = useMemo<SidebarSection[]>(() => sidebarSections(records, groups, showArchived, view, sort), [records, groups, showArchived, view, sort])
  const sections = useMemo<SidebarSection[]>(() => {
    if (!q) return allSections
    return allSections
      .map((sec) => ({ ...sec, sessions: sec.sessions.filter((r) => r.title.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q) || (live[r.id]?.lastPreview ?? '').toLowerCase().includes(q)) }))
      .filter((sec) => sec.sessions.length > 0)
  }, [allSections, q, live])
  const flat = useMemo(() => allSections.flatMap((s) => s.sessions), [allSections])
  const hotkeys = useMemo(() => {
    const map = new Map<string, number>()
    flat.slice(0, 9).forEach((r, i) => map.set(r.id, i + 1))
    return map
  }, [flat])
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  const fail = (err: unknown) => toast((err as Error).message, 'error')

  // ---------------------------------------------------------------- selection
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const pick = (e: React.MouseEvent, id: string) => {
    const cur = useStore.getState().selectedIds // current value even for clicks in quick succession
    if (e.metaKey || e.ctrlKey) {
      const has = cur.includes(id)
      if (!has) anchorRef.current = id
      setSelectedIds(has ? cur.filter((x) => x !== id) : [...cur, id])
      return
    }
    if (e.shiftKey) {
      const from = anchorRef.current ?? activeId ?? id
      const a = flat.findIndex((r) => r.id === from)
      const b = flat.findIndex((r) => r.id === id)
      if (a >= 0 && b >= 0) {
        const range = flat.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id)
        setSelectedIds([...cur, ...range])
        return
      }
    }
    anchorRef.current = id
    if (cur.length) setSelectedIds([])
    void selectSession(id)
    if (search) setSearch('')
  }
  const selectAll = () => setSelectedIds(flat.map((r) => r.id))
  const clearSelection = () => setSelectedIds([])
  const selectedRecords = selectedIds.map((id) => records[id]).filter(Boolean)
  const bulk = (label: string, fn: (r: SessionRecord) => Promise<unknown>) =>
    Promise.all(selectedRecords.map((r) => fn(r).catch((err) => toast(`${r.title}: ${(err as Error).message}`, 'error')))).then(() => toast(`${label}: ${selectedRecords.length} session${selectedRecords.length === 1 ? '' : 's'}`, 'success'))

  // ---------------------------------------------------------------- groups
  const startNewGroup = () => setNewGroup('')
  const commitNewGroup = async () => {
    const name = (newGroup ?? '').trim()
    setNewGroup(null)
    if (!name) return
    await window.api.sessions.createGroup(name).catch(fail)
  }
  const commitRename = async () => {
    if (!renaming) return
    const { id, name } = renaming
    setRenaming(null)
    if (name.trim()) await window.api.sessions.renameGroup(id, name.trim()).catch(fail)
  }

  const commitSessionRename = async () => {
    if (!renamingSession) return
    const { id, name } = renamingSession
    setRenamingSession(null)
    const title = name.trim()
    const rec = flat.find((r) => r.id === id)
    if (title && title !== rec?.title) await window.api.sessions.rename(id, title).catch(fail)
  }

  const itemMenu = (e: React.MouseEvent, r: SessionRecord) => {
    e.preventDefault()
    if (selected.size > 1 && selected.has(r.id)) {
      setMenu({ x: e.clientX, y: e.clientY, items: selectionMenuItems() })
      return
    }
    setMenu({ x: e.clientX, y: e.clientY, items: sessionMenuItems(r, live[r.id], { groups, toast, onNewGroup: startNewGroup, onRename: () => setRenamingSession({ id: r.id, name: r.title }) }) })
  }
  const selectionMenuItems = (): MenuItem[] => {
    const n = selectedRecords.length
    const groupItems: MenuItem[] = [
      ...[...groups].sort((a, b) => a.order - b.order).map((g) => ({ label: g.name, onClick: () => void bulk(`Moved to ${g.name}`, (r) => window.api.sessions.moveSession(r.id, { groupId: g.id })) })),
      { label: '', onClick: () => undefined, separator: true },
      { label: 'No group', onClick: () => void bulk('Ungrouped', (r) => window.api.sessions.moveSession(r.id, {})) }
    ]
    return [
      { label: `${n} sessions selected`, disabled: true, onClick: () => undefined },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Start processes', tip: 'Start the Claude process of every selected session that is not running (one after the other)', onClick: () => void startSessions(selectedIds) },
      { label: 'Stop processes', tip: 'Stop the Claude process and background tasks of every selected session (history is kept)', onClick: () => void stopSessions(selectedIds) },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Pin', onClick: () => void bulk('Pinned', (r) => window.api.sessions.setPinned(r.id, true)) },
      { label: 'Unpin', onClick: () => void bulk('Unpinned', (r) => window.api.sessions.setPinned(r.id, false)) },
      { label: 'Archive', onClick: () => void bulk('Archived', (r) => window.api.sessions.setArchived(r.id, true)) },
      { label: 'Unarchive', onClick: () => void bulk('Unarchived', (r) => window.api.sessions.setArchived(r.id, false)) },
      { label: 'Move to group', children: groupItems, onClick: () => undefined },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Select all', onClick: selectAll },
      { label: 'Clear selection', onClick: clearSelection }
    ]
  }
  const groupMenu = (e: React.MouseEvent, g: SessionGroup) => {
    e.preventDefault()
    e.stopPropagation()
    const ordered = [...groups].sort((a, b) => a.order - b.order)
    const idx = ordered.findIndex((x) => x.id === g.id)
    const members = flat.filter((r) => r.groupId === g.id)
    const items: MenuItem[] = [
      { label: 'Rename group…', onClick: () => setRenaming({ id: g.id, name: g.name }) },
      { label: 'Change colour…', tip: 'The colour marks the group header, its rows and the group tag in the chat', onClick: () => setColorPick({ x: e.clientX, y: e.clientY, group: g }) },
      { label: 'New group…', onClick: startNewGroup },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Start all processes in this group', disabled: !members.some((r) => !live[r.id]?.processAlive), onClick: () => void startSessions(members.map((r) => r.id)) },
      { label: 'Stop all processes in this group', disabled: !members.some((r) => live[r.id]?.processAlive), onClick: () => void stopSessions(members.map((r) => r.id)) },
      { label: 'Select all sessions in this group', onClick: () => setSelectedIds(members.map((r) => r.id)) },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Move up', disabled: idx <= 0, onClick: () => window.api.sessions.moveGroup(g.id, ordered[idx - 1]?.id).catch(fail) },
      { label: 'Move down', disabled: idx < 0 || idx >= ordered.length - 1, onClick: () => window.api.sessions.moveGroup(g.id, ordered[idx + 2]?.id).catch(fail) },
      { label: g.collapsed ? 'Expand' : 'Collapse', onClick: () => window.api.sessions.setGroupCollapsed(g.id, !g.collapsed).catch(fail) },
      { label: '', onClick: () => undefined, separator: true },
      {
        label: 'Delete group',
        danger: true,
        tip: 'Sessions in it are kept and become ungrouped',
        onClick: () => {
          if (confirm(`Delete group "${g.name}"? Its sessions are kept (they become ungrouped).`)) void window.api.sessions.deleteGroup(g.id).catch(fail)
        }
      }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const viewMenu = (e: React.MouseEvent) => {
    const notRunning = flat.filter((r) => !live[r.id]?.processAlive)
    const running = flat.filter((r) => live[r.id]?.processAlive)
    const items: MenuItem[] = [
      { label: 'Order by last prompt (newest first)', checked: sort === 'lastPrompt', tip: 'Sessions move up when you send a prompt, never when Claude answers', onClick: () => void setSettings({ sidebarSort: 'lastPrompt' }) },
      { label: 'Manual order (drag to reorder)', checked: sort === 'manual', tip: 'Positions only change when you drag a session', onClick: () => void setSettings({ sidebarSort: 'manual' }) },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Show archived sessions', checked: showArchived, onClick: () => setShowArchived(!showArchived) },
      { label: 'Folder header rows inside groups', checked: groupByFolder, onClick: () => void setSettings({ groupSessionsByFolder: !groupByFolder }) },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'New group…', onClick: startNewGroup },
      { label: 'Expand all groups', disabled: view !== 'groups', onClick: () => groups.forEach((g) => g.collapsed && window.api.sessions.setGroupCollapsed(g.id, false).catch(fail)) },
      { label: 'Collapse all groups', disabled: view !== 'groups', onClick: () => groups.forEach((g) => !g.collapsed && window.api.sessions.setGroupCollapsed(g.id, true).catch(fail)) },
      { label: '', onClick: () => undefined, separator: true },
      { label: `Start all processes (${notRunning.length} not running)`, disabled: notRunning.length === 0, tip: 'Starts one process after the other; each one needs a few seconds', onClick: () => void startSessions(notRunning.map((r) => r.id)) },
      {
        label: `Stop all processes (${running.length} running)`,
        disabled: running.length === 0,
        tip: 'Ends every Claude process and its background tasks; history is kept',
        onClick: () => {
          if (confirm(`Stop ${running.length} running session${running.length === 1 ? '' : 's'}? Background shells, monitors and subagents of these sessions end too.`)) void stopSessions(running.map((r) => r.id))
        }
      },
      { label: 'Select all sessions', onClick: selectAll }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // ---------------------------------------------------------------- drag & drop
  const dragRef = useRef<{ item: DragItem; startX: number; startY: number; active: boolean; pointerId: number; el: HTMLElement } | null>(null)
  const posRef = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)

  const hitTest = useCallback(
    (x: number, y: number, item: DragItem): DropTarget | null => {
      const els = document.elementsFromPoint(x, y)
      if (item.kind === 'group') {
        for (const el of els) {
          const sec = (el as HTMLElement).closest?.('[data-section-group]') as HTMLElement | null
          if (!sec) continue
          const gid = sec.dataset.sectionGroup || undefined
          if (!gid || gid === item.id) return null
          const rect = sec.getBoundingClientRect()
          const before = y < rect.top + rect.height / 2
          const ordered = [...groups].sort((a, b) => a.order - b.order)
          const idx = ordered.findIndex((g) => g.id === gid)
          const beforeGroupId = before ? gid : ordered[idx + 1]?.id
          return { kind: 'group-order', beforeGroupId, overGroupId: gid, pos: before ? 'before' : 'after' }
        }
        return null
      }
      for (const el of els) {
        const h = el as HTMLElement
        if (!h.dataset) continue
        if (h.dataset.dropRow !== undefined) {
          const id = h.dataset.dropRow
          if (id === item.id) return null
          const groupId = h.dataset.rowGroup || undefined
          if (view === 'recent') {
            const pinned = h.dataset.rowSection === 'pinned'
            return { kind: 'pin', pinned }
          }
          if (sort !== 'manual') return { kind: 'group', groupId, label: groupId ? groupById.get(groupId)?.name ?? 'group' : 'Ungrouped' }
          const rect = h.getBoundingClientRect()
          const before = y < rect.top + rect.height / 2
          const next = h.dataset.rowNext || undefined
          return { kind: 'row', groupId, overId: id, beforeId: before ? id : next, pos: before ? 'before' : 'after' }
        }
        if (h.dataset.dropSection !== undefined) {
          if (view === 'recent') return { kind: 'pin', pinned: h.dataset.dropSection === 'pinned' }
          const groupId = h.dataset.dropSection || undefined
          return { kind: 'group', groupId, label: groupId ? groupById.get(groupId)?.name ?? 'group' : 'Ungrouped' }
        }
      }
      return null
    },
    [groups, groupById, sort, view]
  )

  const onPointerDown = (e: React.PointerEvent, item: DragItem) => {
    if (e.button !== 0) return
    const t = e.target as HTMLElement
    if (t.closest('button, input, [contenteditable="true"]')) return
    dragRef.current = { item, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId, el: e.currentTarget as HTMLElement }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    posRef.current = { x: e.clientX, y: e.clientY }
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return
      d.active = true
      try {
        d.el.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      document.body.classList.add('is-dragging')
    }
    e.preventDefault()
    setDrag({ item: d.item, x: e.clientX, y: e.clientY, target: hitTest(e.clientX, e.clientY, d.item) })
  }
  const finishDrag = (commit: boolean) => {
    const d = dragRef.current
    dragRef.current = null
    document.body.classList.remove('is-dragging')
    if (!d?.active) return
    suppressClick.current = true
    setTimeout(() => (suppressClick.current = false), 0)
    try {
      d.el.releasePointerCapture(d.pointerId)
    } catch {
      /* ignore */
    }
    setDrag((cur) => {
      const target = cur?.target
      if (commit && target) {
        if (d.item.kind === 'group') {
          if (target.kind === 'group-order' && target.beforeGroupId !== d.item.id) void window.api.sessions.moveGroup(d.item.id, target.beforeGroupId).catch(fail)
        } else if (target.kind === 'row') {
          if (target.beforeId !== d.item.id) void window.api.sessions.moveSession(d.item.id, { groupId: target.groupId, beforeId: target.beforeId }).catch(fail)
        } else if (target.kind === 'group') {
          const rec = records[d.item.id]
          if (rec && (rec.groupId || undefined) !== target.groupId) void window.api.sessions.moveSession(d.item.id, { groupId: target.groupId }).catch(fail)
          else if (rec) toast(`Already in ${target.label}`, 'info')
        } else if (target.kind === 'pin') {
          const rec = records[d.item.id]
          if (rec && Boolean(rec.pinned) !== target.pinned) void window.api.sessions.setPinned(d.item.id, target.pinned).catch(fail)
        }
      }
      return null
    })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    finishDrag(true)
  }
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finishDrag(false)
    }
    // Auto-scroll the list while the pointer rests near its top or bottom edge.
    const timer = setInterval(() => {
      const list = listRef.current
      if (!list) return
      const rect = list.getBoundingClientRect()
      const { y } = posRef.current
      if (y < rect.top + 28) list.scrollTop -= 10
      else if (y > rect.bottom - 28) list.scrollTop += 10
    }, 40)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearInterval(timer)
    }
  }, [drag !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- rendering
  const renderRow = (r: SessionRecord, sec: SidebarSection, nextId: string | undefined) => {
    const l = live[r.id]
    const vs = visualState(l)
    const hk = hotkeys.get(r.id)
    const lastPrompt = lastPromptOf(r)
    const lastAct = l?.lastActivityAt ?? r.lastActiveAt
    const t = drag?.target
    const dropCls = t?.kind === 'row' && t.overId === r.id ? `drop-${t.pos}` : ''
    const g = r.groupId ? groupById.get(r.groupId) : undefined
    const gColor = groupColorFor(g, dark)
    const busy = bulkBusy[r.id]
    const modelName = sessionModelName(r, l, settings?.defaultModel)
    const showDir = groupByFolder ? false : (files[r.id]?.panelOpen ?? true)
    const tip = [
      r.title,
      `${vs.label}: ${vs.description}`,
      `model ${modelName}${l?.model ? ` (${l.model})` : r.model ? ` (${r.model})` : ''}`,
      shortenPath(r.cwd, appInfo?.homeDir),
      g ? `group ${g.name}` : 'no group',
      `your last prompt ${formatDateTime(lastPrompt)} (${timeAgo(lastPrompt)})`,
      `last activity ${formatDateTime(lastAct)} (${timeAgo(lastAct)})`,
      `${hk ? `⌘${hk} selects it · ` : ''}⌘-click / ⇧-click selects several · drag to ${sort === 'manual' ? 'reorder or ' : ''}move to a group${view === 'recent' ? ' / pin' : ''}`
    ].join('\n')
    return (
      <div
        key={r.id}
        className={`session-item vs-${vs.key} ${r.id === activeId ? 'active' : ''} ${selected.has(r.id) ? 'selected' : ''} ${drag?.item.kind === 'session' && drag.item.id === r.id ? 'dragging' : ''} ${dropCls}`}
        data-drop-row={r.id}
        data-row-group={sec.group?.id ?? ''}
        data-row-next={nextId ?? ''}
        data-row-section={sec.kind}
        onClick={(e) => {
          if (suppressClick.current) return
          pick(e, r.id)
        }}
        onContextMenu={(e) => itemMenu(e, r)}
        onPointerDown={(e) => renamingSession?.id !== r.id && onPointerDown(e, { kind: 'session', id: r.id, title: r.title })}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => finishDrag(false)}
        data-tip={tip}
      >
        <StateMark state={vs.key} />
        {renamingSession?.id === r.id ? (
          <input
            className="inline-edit"
            autoFocus
            value={renamingSession.name}
            onChange={(e) => setRenamingSession({ id: r.id, name: e.target.value })}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={() => void commitSessionRename()}
            onKeyDown={(e) => {
              if (isComposing(e)) return
              if (e.key === 'Enter') void commitSessionRename()
              if (e.key === 'Escape') setRenamingSession(null)
            }}
          />
        ) : (
          <span
            className="name"
            /* In the recent view the groups are not visible as sections, so the group's colour is
               carried by the chat name itself instead of a group tag on the second line. */
            style={view === 'recent' && gColor ? { color: gColor, opacity: vs.key === 'stopped' ? 0.7 : undefined } : undefined}
            onDoubleClick={() => setRenamingSession({ id: r.id, name: r.title })}
          >
            {r.title}
          </span>
        )}
        <span className="right">
          {r.pinned && <Pin size={11} className="pin" />}
          {l?.unread ? <span className="badge" data-tip={`${l.unread} finished turn${l.unread === 1 ? '' : 's'} you have not looked at`}>{l.unread}</span> : null}
          {hk && <span className="hotkey-hint">⌘{hk}</span>}
          <span data-tip={`Your last prompt: ${formatDateTime(lastPrompt)}`}>{timeAgo(lastPrompt)}</span>
        </span>
        <span className="meta">
          <span className="model">{modelName}</span>
          <span className="faint"> · </span>
          <span className={`state-text vs-${vs.key}`}>{busy ? (busy === 'start' ? 'starting…' : 'stopping…') : vs.key === 'idle' && l?.lastPreview ? l.lastPreview : vs.label}</span>
          {!busy && vs.key === 'unread' && l?.lastPreview && <span className="faint"> · {l.lastPreview}</span>}
          {showDir && <span className="faint"> · {basename(r.cwd)}</span>}
        </span>
        <Indicators live={l} />
      </div>
    )
  }

  const renderSessions = (sec: SidebarSection) => {
    const list = sec.sessions
    if (!groupByFolder || view === 'recent') return list.map((r, i) => renderRow(r, sec, list[i + 1]?.id))
    const byFolder = new Map<string, SessionRecord[]>()
    for (const r of list) byFolder.set(r.cwd, [...(byFolder.get(r.cwd) ?? []), r])
    return [...byFolder.entries()].map(([cwd, rows]) => {
      const key = `${sec.group?.id ?? ''}:${cwd}`
      const collapsed = folderCollapsed[key]
      return (
        <div key={key}>
          <div className="folder-header" onClick={() => setFolderCollapsed((c) => ({ ...c, [key]: !c[key] }))} data-tip={cwd}>
            {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            <span className="ellipsis">{basename(cwd)}</span>
            <span className="count">{rows.length}</span>
          </div>
          {!collapsed && rows.map((r, i) => renderRow(r, sec, rows[i + 1]?.id ?? list[list.indexOf(rows[rows.length - 1]) + 1]?.id))}
        </div>
      )
    })
  }

  const hasGroups = groups.length > 0
  const total = flat.length
  const t = drag?.target
  const ghostText = (() => {
    if (!drag) return ''
    if (!t) return drag.item.kind === 'group' ? `Move group "${drag.item.name}"` : 'Drop on a group or a row'
    switch (t.kind) {
      case 'row': return `Place ${t.pos} this row`
      case 'group': return `Move to ${t.label}`
      case 'pin': return t.pinned ? 'Pin' : 'Unpin'
      case 'group-order': return `Place group ${t.pos} "${groupById.get(t.overGroupId)?.name ?? ''}"`
    }
  })()

  return (
    <div className={`sidebar ${drag ? 'dragging' : ''}`}>
      <div className="sidebar-top drag">
        <div className="seg sm no-drag" data-tip="Sidebar layout">
          <button className={view === 'groups' ? 'active' : ''} onClick={() => void setSettings({ sidebarView: 'groups' })} data-tip="Groups view: sessions under your groups (Papers, Utils, Tasks…), each ordered by your last prompt">
            <LayoutList size={13} />
            {!compact && <span>Groups</span>}
          </button>
          <button className={view === 'recent' ? 'active' : ''} onClick={() => void setSettings({ sidebarView: 'recent' })} data-tip="Recent view: pinned sessions, then every other session, ordered by your last prompt">
            <Clock size={13} />
            {!compact && <span>Recent</span>}
          </button>
        </div>
        <span className="spacer" />
        <button className="btn ghost icon no-drag" data-tip="View options: order, archived sessions, groups, start / stop all, select all" onClick={viewMenu}>
          <SlidersHorizontal size={15} />
        </button>
        <button className="btn ghost icon no-drag" data-tip="Settings (⌘,)" onClick={() => setDialog('settings')}>
          <Settings size={15} />
        </button>
      </div>
      <div className="sidebar-search">
        <input ref={searchRef} placeholder="Search sessions (⌘K)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && !isComposing(e) && setSearch('')} data-tip="Filter by title, folder or last message. Picking a result clears the search." />
        {search && (
          <button className="clear no-drag" onClick={() => setSearch('')} data-tip="Clear search">
            <X size={12} />
          </button>
        )}
      </div>
      {selectedIds.length > 0 && (
        <div className="sel-bar">
          <span className="sel-count" data-tip="⌘-click toggles a session, ⇧-click selects a range. Right-click a selected row for more actions.">
            <CheckSquare size={12} /> {selectedIds.length}
          </span>
          <button className="btn ghost icon sm" data-tip="Start the Claude process of the selected sessions that are not running (one after the other)" onClick={() => void startSessions(selectedIds)}>
            <Play size={13} />
          </button>
          <button className="btn ghost icon sm" data-tip="Stop the Claude process and background tasks of the selected sessions (history is kept)" onClick={() => void stopSessions(selectedIds)}>
            <Square size={13} />
          </button>
          <button className="btn ghost icon sm" data-tip="Pin the selected sessions" onClick={() => void bulk('Pinned', (r) => window.api.sessions.setPinned(r.id, true))}>
            <Pin size={13} />
          </button>
          <button className="btn ghost icon sm" data-tip="Unpin the selected sessions" onClick={() => void bulk('Unpinned', (r) => window.api.sessions.setPinned(r.id, false))}>
            <PinOff size={13} />
          </button>
          <button className="btn ghost icon sm" data-tip="Archive the selected sessions (hidden unless 'show archived' is on)" onClick={() => void bulk('Archived', (r) => window.api.sessions.setArchived(r.id, true))}>
            <Archive size={13} />
          </button>
          <button className="btn ghost icon sm" data-tip="Move the selected sessions to a group" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: selectionMenuItems() })}>
            <FolderPlus size={13} />
          </button>
          <span className="spacer" />
          <button className="btn ghost sm" data-tip="Select every visible session" onClick={selectAll}>all</button>
          <button className="btn ghost icon sm" data-tip="Clear the selection" onClick={clearSelection}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className="sidebar-list" ref={listRef}>
        {total === 0 && <div className="faint" style={{ padding: 16, textAlign: 'center', fontSize: 12.5 }}>No sessions yet. Create one with ⌘N or import your CLI sessions.</div>}
        {sections.map((sec) => {
          const g = sec.group
          const id = g?.id
          const collapsed = Boolean(g?.collapsed) && !q
          const isGroupTarget = (t?.kind === 'group' && t.groupId === id && sec.kind !== 'pinned' && sec.kind !== 'recent') || (t?.kind === 'pin' && ((sec.kind === 'pinned' && t.pinned) || (sec.kind === 'recent' && !t.pinned)))
          const groupOrderCls = t?.kind === 'group-order' && g && t.overGroupId === g.id ? `drop-${t.pos}` : ''
          const keys = sec.sessions.map((r) => visualState(live[r.id]).key)
          const working = keys.filter((k) => k === 'working' || k === 'starting').length
          const permission = keys.filter((k) => k === 'permission').length
          const option = keys.filter((k) => k === 'option').length
          const unread = keys.filter((k) => k === 'unread').length
          const waiting = permission + option
          const color = groupColorFor(g, dark)
          const showHeader = sec.kind === 'group' || sec.kind === 'pinned' || sec.kind === 'recent' || (sec.kind === 'ungrouped' && hasGroups)
          if (sec.kind === 'pinned' && sec.sessions.length === 0 && !q) return null
          const headerTip =
            sec.kind === 'group' && g
              ? `Group "${g.name}" · ${sec.sessions.length} session${sec.sessions.length === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}${waiting ? ` · ${waiting} waiting for you` : ''}\nClick to collapse, right-click for colour / rename / start all, drag the header to reorder groups, drop sessions here to move them in.`
              : sec.kind === 'pinned'
                ? 'Pinned sessions, ordered by your last prompt. Drop a session here to pin it.'
                : sec.kind === 'recent'
                  ? 'Every other session, the one you prompted most recently first. Drop a pinned session here to unpin it.'
                  : 'Sessions that are not in any group. Drop sessions here to remove them from a group.'
          return (
            <div
              key={id ?? sec.kind}
              className={`sidebar-section kind-${sec.kind} ${color ? 'colored' : ''} ${isGroupTarget ? 'drop-target' : ''} ${groupOrderCls} ${drag?.item.kind === 'group' && drag.item.id === id ? 'dragging' : ''}`}
              style={color ? ({ '--group-color': color } as React.CSSProperties) : undefined}
              data-drop-section={sec.kind === 'pinned' ? 'pinned' : sec.kind === 'recent' ? 'recent' : (id ?? '')}
              data-section-group={id ?? ''}
            >
              {showHeader && (
                <div
                  className={`group-header ${g ? '' : 'plain'}`}
                  onClick={() => g && window.api.sessions.setGroupCollapsed(g.id, !g.collapsed).catch(fail)}
                  onContextMenu={(e) => g && groupMenu(e, g)}
                  onPointerDown={(e) => g && view === 'groups' && onPointerDown(e, { kind: 'group', id: g.id, name: g.name })}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => finishDrag(false)}
                  data-tip={headerTip}
                >
                  {g ? collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} /> : sec.kind === 'pinned' ? <Pin size={11} /> : sec.kind === 'recent' ? <Clock size={11} /> : <span style={{ width: 12 }} />}
                  {g && (
                    <button className="gdot" style={{ background: color }} data-tip="Change the group colour" onClick={(e) => { e.stopPropagation(); setColorPick({ x: e.clientX, y: e.clientY, group: g }) }} />
                  )}
                  {renaming && g && renaming.id === g.id ? (
                    <input
                      className="inline-edit"
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: g.id, name: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        if (isComposing(e)) return
                        if (e.key === 'Enter') void commitRename()
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                    />
                  ) : (
                    <span className="ellipsis gname" onDoubleClick={() => g && setRenaming({ id: g.id, name: g.name })}>
                      {sec.title}
                    </span>
                  )}
                  {permission > 0 && <StateMark state="permission" small />}
                  {option > 0 && <StateMark state="option" small />}
                  {unread > 0 && <StateMark state="unread" small />}
                  {working > 0 && <StateMark state="working" small />}
                  <span className="count">{sec.sessions.length}</span>
                </div>
              )}
              {!collapsed && renderSessions(sec)}
              {!collapsed && sec.sessions.length === 0 && (g || sec.kind === 'recent') && <div className="faint group-empty">{g ? 'Drag sessions here or use "Move to group"' : 'Nothing here'}</div>}
            </div>
          )
        })}
        {newGroup !== null && (
          <div className="group-header">
            <FolderPlus size={12} />
            <input
              ref={newGroupRef}
              className="inline-edit"
              placeholder="Group name (e.g. Papers)"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onBlur={() => void commitNewGroup()}
              onKeyDown={(e) => {
                if (isComposing(e)) return
                if (e.key === 'Enter') void commitNewGroup()
                if (e.key === 'Escape') setNewGroup(null)
              }}
            />
          </div>
        )}
        {view === 'groups' && (
          <button className="add-group-row" onClick={startNewGroup} data-tip="New group (Papers, Utilities, Tasks…). Groups get a colour automatically; right-click a group to change it.">
            <FolderPlus size={12} /> New group
          </button>
        )}
      </div>
      <div className="sidebar-footer">
        <button className="btn primary" onClick={() => setDialog('new-session')} data-tip="New session (⌘N): a new Claude Code conversation in a folder of your choice">
          <Plus size={14} /> New
        </button>
        <button className="btn" onClick={() => setDialog('import-session')} data-tip="Import an existing Claude Code terminal session (⌘⇧I)">
          <Download size={14} /> Import
        </button>
      </div>
      {drag && (
        <div className={`drag-ghost ${t ? 'valid' : ''}`} style={{ left: drag.x + 14, top: drag.y + 10 }}>
          <span className="dg-title">{drag.item.kind === 'session' ? drag.item.title : drag.item.name}</span>
          <span className="dg-hint">{ghostText}</span>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {colorPick && (
        <GroupColorPicker
          x={colorPick.x}
          y={colorPick.y}
          color={colorPick.group.color}
          title={`Colour of "${colorPick.group.name}"`}
          onPick={(c) => window.api.sessions.setGroupColor(colorPick.group.id, c).catch(fail)}
          onClose={() => setColorPick(null)}
        />
      )}
    </div>
  )
}
