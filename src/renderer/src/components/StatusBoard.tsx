import React, { useMemo, useState } from 'react'
import { Bot, TerminalSquare } from 'lucide-react'
import type { SessionRecord } from '@shared/types'
import { sidebarSections, useStore } from '@/store'
import { ContextMenu, type MenuItem } from './common/ContextMenu'
import { formatDateTime, shortenPath, timeAgo } from '@/lib/format'
import { VISUAL_LEGEND, visualState, type VisualKey } from '@/lib/sessionState'
import { sessionMenuItems } from '@/lib/sessionMenu'

const ORDER: VisualKey[] = ['attention', 'working', 'idle-tasks', 'idle', 'starting', 'error', 'stopped']

/** Overview strip above the chat: one chip per session with its colour-coded state and task counts. */
export function StatusBoard() {
  const records = useStore((s) => s.records)
  const live = useStore((s) => s.live)
  const groups = useStore((s) => s.groups)
  const showArchived = useStore((s) => s.showArchived)
  const activeId = useStore((s) => s.activeId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const selectSession = useStore((s) => s.selectSession)
  const toast = useStore((s) => s.toast)
  const appInfo = useStore((s) => s.appInfo)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const sections = useMemo(() => sidebarSections(records, groups, showArchived), [records, groups, showArchived])
  const all = sections.flatMap((s) => s.sessions)
  const counts = new Map<VisualKey, number>()
  for (const r of all) {
    const k = visualState(live[r.id]).key
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const legend = VISUAL_LEGEND.map((l) => `● ${l.label}: ${l.description}`).join('\n')

  const chip = (r: SessionRecord) => {
    const l = live[r.id]
    const vs = visualState(l)
    const last = l?.lastActivityAt ?? r.lastActiveAt
    const tip = [r.title, `${vs.label} — ${vs.description}`, shortenPath(r.cwd, appInfo?.homeDir), `last activity ${formatDateTime(last)} (${timeAgo(last)})`, l?.model ? `model ${l.model}` : ''].filter(Boolean).join('\n')
    return (
      <button
        key={r.id}
        className={`board-chip vs-${vs.key} ${r.id === activeId ? 'active' : ''}`}
        onClick={() => void selectSession(r.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, items: sessionMenuItems(r, l, { groups, toast }) })
        }}
        data-tip={tip}
      >
        <span className={`dot vs-${vs.key}`} />
        <span className="name">{r.title}</span>
        <span className="state">{vs.label}</span>
        {vs.background > 0 && (
          <span className="chip bg">
            <TerminalSquare size={11} /> {vs.background}
          </span>
        )}
        {vs.subagents > 0 && (
          <span className="chip agent">
            <Bot size={11} /> {vs.subagents}
          </span>
        )}
        {l?.unread ? <span className="badge">{l.unread}</span> : null}
      </button>
    )
  }

  return (
    <div className="status-board drag" style={{ paddingLeft: sidebarOpen ? 10 : 84 }}>
      <div className="board-summary no-drag" data-tip={`All sessions at a glance.\n${legend}`}>
        {ORDER.filter((k) => counts.get(k)).map((k) => {
          const l = VISUAL_LEGEND.find((x) => x.key === k)
          return (
            <span key={k} className={`board-count vs-${k}`}>
              <span className={`dot vs-${k}`} /> {counts.get(k)} {l?.label ?? k}
            </span>
          )
        })}
        {all.length === 0 && <span className="faint">no sessions</span>}
      </div>
      <div className="board-chips no-drag">
        {sections.map((sec) =>
          sec.sessions.length === 0 ? null : (
            <React.Fragment key={sec.group?.id ?? '__none'}>
              {(sec.group || groups.length > 0) && <span className="board-group">{sec.group ? sec.group.name : 'ungrouped'}</span>}
              {sec.sessions.map(chip)}
            </React.Fragment>
          )
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
