import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Pin, Plus, Settings } from 'lucide-react'
import type { SessionLiveState, SessionRecord } from '@shared/types'
import { orderedSessions, useStore } from '@/store'
import { ContextMenu, type MenuItem } from './common/ContextMenu'
import { basename, shortenPath, timeAgo } from '@/lib/format'

function statusText(live: SessionLiveState | undefined): React.ReactNode {
  if (!live) return 'not running'
  switch (live.status) {
    case 'running': return live.activity === 'compacting' ? 'compacting…' : live.activeTools.length ? `${live.activeTools[live.activeTools.length - 1].toolName}…` : 'working…'
    case 'requires_action': return <b>needs input</b>
    case 'starting': return 'starting…'
    case 'idle': return live.lastPreview || 'idle'
    case 'error': return 'error'
    default: return live.lastPreview || 'not running'
  }
}

export function Sidebar() {
  const records = useStore((s) => s.records)
  const live = useStore((s) => s.live)
  const activeId = useStore((s) => s.activeId)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const showArchived = useStore((s) => s.showArchived)
  const setShowArchived = useStore((s) => s.setShowArchived)
  const selectSession = useStore((s) => s.selectSession)
  const setDialog = useStore((s) => s.setDialog)
  const appInfo = useStore((s) => s.appInfo)
  const searchNonce = useStore((s) => s.searchFocusNonce)
  const searchRef = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  useEffect(() => {
    if (searchNonce) searchRef.current?.focus()
  }, [searchNonce])

  const sessions = useMemo(() => {
    const list = orderedSessions(records, live, showArchived)
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter((r) => r.title.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q) || (live[r.id]?.lastPreview ?? '').toLowerCase().includes(q))
  }, [records, live, showArchived, search])

  const groups = useMemo(() => {
    const map = new Map<string, SessionRecord[]>()
    for (const r of sessions) {
      const list = map.get(r.cwd) ?? []
      list.push(r)
      map.set(r.cwd, list)
    }
    return [...map.entries()]
  }, [sessions])

  const attention = Object.values(live).filter((l) => l.status === 'requires_action').length

  const itemMenu = (e: React.MouseEvent, r: SessionRecord) => {
    e.preventDefault()
    const l = live[r.id]
    const items: MenuItem[] = [
      { label: r.pinned ? 'Unpin' : 'Pin to top', onClick: () => window.api.sessions.setPinned(r.id, !r.pinned) },
      { label: r.archived ? 'Unarchive' : 'Archive', onClick: () => window.api.sessions.setArchived(r.id, !r.archived) },
      { label: 'Open folder in Terminal', onClick: () => window.api.shell.openTerminal(r.cwd) },
      { label: '', onClick: () => undefined, separator: true },
      { label: l?.processAlive ? 'Stop process' : 'Start process', onClick: () => (l?.processAlive ? window.api.sessions.stop(r.id) : window.api.sessions.start(r.id)) },
      { label: 'Delete from ClaudeGUI', danger: true, onClick: () => { if (confirm(`Remove "${r.title}" from ClaudeGUI? (transcript on disk is kept)`)) void window.api.sessions.remove(r.id, false) } }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  let hotkey = 0
  return (
    <div className="sidebar">
      <div className="sidebar-top drag">
        <span className="title">ClaudeGUI{attention ? ` · ${attention} waiting` : ''}</span>
        <button className="btn ghost icon no-drag" title="Settings (⌘,)" onClick={() => setDialog('settings')}>
          <Settings size={15} />
        </button>
      </div>
      <div className="sidebar-search">
        <input ref={searchRef} placeholder="Search sessions (⌘K)" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
      </div>
      <div className="sidebar-list">
        {groups.length === 0 && <div className="faint" style={{ padding: 16, textAlign: 'center', fontSize: 12.5 }}>No sessions yet. Create one with ⌘N or import your CLI sessions.</div>}
        {groups.map(([cwd, list]) => {
          const isCollapsed = collapsed[cwd]
          return (
            <div key={cwd}>
              <div className="group-header" onClick={() => setCollapsed((c) => ({ ...c, [cwd]: !c[cwd] }))} title={cwd}>
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="ellipsis">{basename(cwd)}</span>
                <span className="count">{list.length}</span>
              </div>
              {!isCollapsed &&
                list.map((r) => {
                  const l = live[r.id]
                  hotkey += 1
                  const hk = hotkey <= 9 ? hotkey : undefined
                  return (
                    <div key={r.id} className={`session-item ${r.id === activeId ? 'active' : ''}`} onClick={() => selectSession(r.id)} onContextMenu={(e) => itemMenu(e, r)} title={`${r.title}\n${shortenPath(r.cwd, appInfo?.homeDir)}`}>
                      <span className={`dot ${l?.status ?? 'stopped'}`} />
                      <span className="name">{r.title}</span>
                      <span className="right">
                        {r.pinned && <Pin size={11} className="pin" />}
                        {l?.unread ? <span className="badge">{l.unread}</span> : null}
                        {hk && <span className="hotkey-hint">⌘{hk}</span>}
                        <span>{timeAgo(l?.lastActivityAt ?? r.lastActiveAt)}</span>
                      </span>
                      <span className="meta">{statusText(l)}</span>
                    </div>
                  )
                })}
            </div>
          )
        })}
        <div style={{ padding: '10px 8px' }}>
          <label className="faint" style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived
          </label>
        </div>
      </div>
      <div className="sidebar-footer">
        <button className="btn primary" onClick={() => setDialog('new-session')} title="New session (⌘N)">
          <Plus size={14} /> New
        </button>
        <button className="btn" onClick={() => setDialog('import-session')} title="Import an existing Claude Code CLI session">
          <Download size={14} /> Import
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
