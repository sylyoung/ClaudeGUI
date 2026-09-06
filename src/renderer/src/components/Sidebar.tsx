import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Cpu, Download, FolderPlus, Pin, Plus, Settings, TerminalSquare, X } from 'lucide-react'
import type { SessionGroup, SessionLiveState, SessionRecord } from '@shared/types'
import { sidebarSections, useStore, type SidebarSection } from '@/store'
import { ContextMenu, type MenuItem } from './common/ContextMenu'
import { basename, formatDateTime, shortenPath, timeAgo } from '@/lib/format'
import { contextLevel, contextPercent } from '@/lib/tasks'
import { visualState } from '@/lib/sessionState'
import { sessionMenuItems } from '@/lib/sessionMenu'

const DND_SESSION = 'application/x-claudegui-session'
const DND_GROUP = 'application/x-claudegui-group'

type DropTarget = { kind: 'session'; groupId?: string; beforeId?: string; overId: string; pos: 'before' | 'after' } | { kind: 'group'; groupId?: string } | { kind: 'group-order'; beforeGroupId?: string }

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
        <span className={`ind ctx ${contextLevel(pct)}`} data-tip={`Context window ${pct}% used${pct >= 85 ? ' — consider /compact' : ''}`}>
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
  const groupByFolder = useStore((s) => s.settings?.groupSessionsByFolder ?? false)
  const searchNonce = useStore((s) => s.searchFocusNonce)
  const searchRef = useRef<HTMLInputElement>(null)
  const [folderCollapsed, setFolderCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const newGroupRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchNonce) searchRef.current?.focus()
  }, [searchNonce])
  useEffect(() => {
    if (newGroup !== null) newGroupRef.current?.focus()
  }, [newGroup])

  const q = search.trim().toLowerCase()
  const sections = useMemo<SidebarSection[]>(() => {
    const secs = sidebarSections(records, groups, showArchived)
    if (!q) return secs
    return secs
      .map((sec) => ({ ...sec, sessions: sec.sessions.filter((r) => r.title.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q) || (live[r.id]?.lastPreview ?? '').toLowerCase().includes(q)) }))
      .filter((sec) => sec.sessions.length > 0)
  }, [records, groups, showArchived, q, live])

  const hotkeys = useMemo(() => {
    const map = new Map<string, number>()
    let n = 0
    for (const sec of sidebarSections(records, groups, showArchived)) for (const r of sec.sessions) if (n < 9) map.set(r.id, ++n)
    return map
  }, [records, groups, showArchived])

  const fail = (err: unknown) => toast((err as Error).message, 'error')
  const pick = (id: string) => {
    void selectSession(id)
    if (search) setSearch('')
  }
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

  const itemMenu = (e: React.MouseEvent, r: SessionRecord) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items: sessionMenuItems(r, live[r.id], { groups, toast, onNewGroup: startNewGroup }) })
  }
  const groupMenu = (e: React.MouseEvent, g: SessionGroup) => {
    e.preventDefault()
    e.stopPropagation()
    const ordered = [...groups].sort((a, b) => a.order - b.order)
    const idx = ordered.findIndex((x) => x.id === g.id)
    const items: MenuItem[] = [
      { label: 'Rename group…', onClick: () => setRenaming({ id: g.id, name: g.name }) },
      { label: 'New group…', onClick: startNewGroup },
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

  // ---------------------------------------------------------------- drag & drop
  const onDragStart = (e: React.DragEvent, r: SessionRecord) => {
    e.dataTransfer.setData(DND_SESSION, r.id)
    e.dataTransfer.effectAllowed = 'move'
    setDragId(r.id)
  }
  const onDragOverRow = (e: React.DragEvent, r: SessionRecord, groupId: string | undefined, nextId: string | undefined) => {
    if (!e.dataTransfer.types.includes(DND_SESSION)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    const next: DropTarget = { kind: 'session', groupId, beforeId: before ? r.id : nextId, overId: r.id, pos: before ? 'before' : 'after' }
    if (!drop || drop.kind !== 'session' || drop.overId !== next.overId || drop.pos !== next.pos) setDrop(next)
  }
  const onDragOverGroup = (e: React.DragEvent, g: SessionGroup | null) => {
    if (e.dataTransfer.types.includes(DND_GROUP)) {
      e.preventDefault()
      setDrop({ kind: 'group-order', beforeGroupId: g?.id })
      return
    }
    if (!e.dataTransfer.types.includes(DND_SESSION)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!drop || drop.kind !== 'group' || drop.groupId !== g?.id) setDrop({ kind: 'group', groupId: g?.id })
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const sid = e.dataTransfer.getData(DND_SESSION)
    const gid = e.dataTransfer.getData(DND_GROUP)
    const target = drop
    setDrop(null)
    setDragId(null)
    if (!target) return
    if (gid && target.kind === 'group-order') {
      if (gid !== target.beforeGroupId) void window.api.sessions.moveGroup(gid, target.beforeGroupId).catch(fail)
      return
    }
    if (!sid) return
    if (target.kind === 'session') {
      if (target.beforeId === sid) return
      void window.api.sessions.moveSession(sid, { groupId: target.groupId, beforeId: target.beforeId }).catch(fail)
    } else if (target.kind === 'group') void window.api.sessions.moveSession(sid, { groupId: target.groupId }).catch(fail)
  }
  const onDragEnd = () => {
    setDrop(null)
    setDragId(null)
  }

  // ---------------------------------------------------------------- rendering
  const renderRow = (r: SessionRecord, groupId: string | undefined, nextId: string | undefined) => {
    const l = live[r.id]
    const vs = visualState(l)
    const hk = hotkeys.get(r.id)
    const dropCls = drop?.kind === 'session' && drop.overId === r.id ? `drop-${drop.pos}` : ''
    const last = l?.lastActivityAt ?? r.lastActiveAt
    const tip = [r.title, `${vs.label}: ${vs.description}`, shortenPath(r.cwd, appInfo?.homeDir), `last activity ${formatDateTime(last)}`, hk ? `⌘${hk} selects it · drag to reorder or move to a group` : 'drag to reorder or move to a group'].join('\n')
    return (
      <div
        key={r.id}
        className={`session-item vs-${vs.key} ${r.id === activeId ? 'active' : ''} ${dragId === r.id ? 'dragging' : ''} ${dropCls}`}
        onClick={() => pick(r.id)}
        onContextMenu={(e) => itemMenu(e, r)}
        draggable
        onDragStart={(e) => onDragStart(e, r)}
        onDragOver={(e) => onDragOverRow(e, r, groupId, nextId)}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        data-tip={tip}
      >
        <span className={`dot vs-${vs.key}`} />
        <span className="name">{r.title}</span>
        <span className="right">
          {r.pinned && <Pin size={11} className="pin" />}
          {l?.unread ? <span className="badge" data-tip={`${l.unread} finished turn${l.unread === 1 ? '' : 's'} you have not looked at`}>{l.unread}</span> : null}
          {hk && <span className="hotkey-hint">⌘{hk}</span>}
          <span>{timeAgo(last)}</span>
        </span>
        <span className="meta">
          {!groupByFolder && <span className="faint">{basename(r.cwd)} · </span>}
          <span className={`state-text vs-${vs.key}`}>{vs.key === 'idle' && l?.lastPreview ? l.lastPreview : vs.label}</span>
        </span>
        <Indicators live={l} />
      </div>
    )
  }

  const renderSessions = (list: SessionRecord[], groupId: string | undefined) => {
    if (!groupByFolder) return list.map((r, i) => renderRow(r, groupId, list[i + 1]?.id))
    const byFolder = new Map<string, SessionRecord[]>()
    for (const r of list) byFolder.set(r.cwd, [...(byFolder.get(r.cwd) ?? []), r])
    return [...byFolder.entries()].map(([cwd, rows]) => {
      const key = `${groupId ?? ''}:${cwd}`
      const collapsed = folderCollapsed[key]
      return (
        <div key={key}>
          <div className="folder-header" onClick={() => setFolderCollapsed((c) => ({ ...c, [key]: !c[key] }))} data-tip={cwd}>
            {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            <span className="ellipsis">{basename(cwd)}</span>
            <span className="count">{rows.length}</span>
          </div>
          {!collapsed && rows.map((r, i) => renderRow(r, groupId, rows[i + 1]?.id ?? list[list.indexOf(rows[rows.length - 1]) + 1]?.id))}
        </div>
      )
    })
  }

  const hasGroups = groups.length > 0
  const total = Object.values(records).filter((r) => showArchived || !r.archived).length

  return (
    <div className="sidebar">
      <div className="sidebar-top drag">
        <span className="title" data-tip={`${total} session${total === 1 ? '' : 's'}. Right-click a session or a group for actions; drag sessions to reorder them or move them between groups.`}>
          ClaudeGUI
        </span>
        <button className="btn ghost icon no-drag" data-tip="New group (categories such as Papers, Utilities, Tasks…)" onClick={startNewGroup}>
          <FolderPlus size={15} />
        </button>
        <button className="btn ghost icon no-drag" data-tip="Settings (⌘,)" onClick={() => setDialog('settings')}>
          <Settings size={15} />
        </button>
      </div>
      <div className="sidebar-search">
        <input ref={searchRef} placeholder="Search sessions (⌘K)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} data-tip="Filter by title, folder or last message. Picking a result clears the search." />
        {search && (
          <button className="clear no-drag" onClick={() => setSearch('')} data-tip="Clear search">
            <X size={12} />
          </button>
        )}
      </div>
      <div className="sidebar-list" onDragOver={(e) => e.dataTransfer.types.includes(DND_SESSION) && e.preventDefault()} onDrop={onDrop}>
        {total === 0 && <div className="faint" style={{ padding: 16, textAlign: 'center', fontSize: 12.5 }}>No sessions yet. Create one with ⌘N or import your CLI sessions.</div>}
        {sections.map((sec) => {
          const g = sec.group
          const id = g?.id
          const collapsed = Boolean(g?.collapsed) && !q
          const headerDrop = (drop?.kind === 'group' && drop.groupId === id) || (drop?.kind === 'group-order' && drop.beforeGroupId === id)
          const working = sec.sessions.filter((r) => live[r.id]?.status === 'running').length
          const waiting = sec.sessions.filter((r) => live[r.id]?.status === 'requires_action').length
          return (
            <div key={id ?? '__ungrouped'} className="sidebar-section">
              {(g || hasGroups) && (
                <div
                  className={`group-header ${headerDrop ? 'drop-target' : ''} ${g ? '' : 'ungrouped'}`}
                  onClick={() => g && window.api.sessions.setGroupCollapsed(g.id, !g.collapsed).catch(fail)}
                  onContextMenu={(e) => g && groupMenu(e, g)}
                  draggable={Boolean(g)}
                  onDragStart={(e) => {
                    if (!g) return
                    e.dataTransfer.setData(DND_GROUP, g.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => onDragOverGroup(e, g)}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                  data-tip={g ? `Group "${g.name}" · ${sec.sessions.length} session${sec.sessions.length === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}${waiting ? ` · ${waiting} waiting for you` : ''}\nClick to collapse, right-click to rename or delete, drag sessions here to move them in.` : 'Sessions that are not in any group. Drag sessions here to remove them from a group.'}
                >
                  {g ? collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} /> : <span style={{ width: 12 }} />}
                  {renaming && g && renaming.id === g.id ? (
                    <input
                      className="inline-edit"
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: g.id, name: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename()
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                    />
                  ) : (
                    <span className="ellipsis" onDoubleClick={() => g && setRenaming({ id: g.id, name: g.name })}>
                      {g ? g.name : 'Ungrouped'}
                    </span>
                  )}
                  {waiting > 0 && <span className="dot vs-attention" style={{ width: 7, height: 7 }} />}
                  {working > 0 && <span className="dot vs-working" style={{ width: 7, height: 7 }} />}
                  <span className="count">{sec.sessions.length}</span>
                </div>
              )}
              {!collapsed && renderSessions(sec.sessions, id)}
              {!collapsed && sec.sessions.length === 0 && g && <div className="faint group-empty">Drag sessions here or use "Move to group"</div>}
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
                if (e.key === 'Enter') void commitNewGroup()
                if (e.key === 'Escape') setNewGroup(null)
              }}
            />
          </div>
        )}
        <div style={{ padding: '10px 8px' }}>
          <label className="faint" style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} data-tip="Archived sessions are hidden from the list and the status board">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived
          </label>
        </div>
      </div>
      <div className="sidebar-footer">
        <button className="btn primary" onClick={() => setDialog('new-session')} data-tip="New session (⌘N): a new Claude Code conversation in a folder of your choice">
          <Plus size={14} /> New
        </button>
        <button className="btn" onClick={() => setDialog('import-session')} data-tip="Import an existing Claude Code terminal session (⌘⇧I)">
          <Download size={14} /> Import
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
