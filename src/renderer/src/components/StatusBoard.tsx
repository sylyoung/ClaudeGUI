import React, { useMemo } from 'react'
import { Bot, Play, TerminalSquare } from 'lucide-react'
import { currentOrder, useStore } from '@/store'
import { VISUAL_LEGEND, visualState, type VisualKey } from '@/lib/sessionState'
import { StateMark } from './common/StateMark'

const ORDER: VisualKey[] = ['working', 'permission', 'option', 'unread', 'idle-tasks', 'idle', 'stopped', 'error']

/**
 * One-line statistics bar above the chat: how many sessions are working, waiting for a permission
 * or an answer, unread, idle with tasks running, idle, not running, in error — plus the running
 * background tasks. Clicking a number jumps to the next session in that state.
 */
export function StatusBoard() {
  const records = useStore((s) => s.records)
  const live = useStore((s) => s.live)
  const groups = useStore((s) => s.groups)
  const showArchived = useStore((s) => s.showArchived)
  const settings = useStore((s) => s.settings)
  const activeId = useStore((s) => s.activeId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const selectSession = useStore((s) => s.selectSession)
  const startSessions = useStore((s) => s.startSessions)
  const bulkBusy = useStore((s) => s.bulkBusy)

  const all = useMemo(() => currentOrder({ records, groups, showArchived, settings }), [records, groups, showArchived, settings])
  const byState = new Map<VisualKey, typeof all>()
  let background = 0
  let subagents = 0
  for (const r of all) {
    const vs = visualState(live[r.id])
    byState.set(vs.key, [...(byState.get(vs.key) ?? []), r])
    background += vs.background
    subagents += vs.subagents
  }
  const starting = byState.get('starting')?.length ?? 0
  const jumpTo = (list: typeof all) => {
    if (!list.length) return
    const idx = list.findIndex((r) => r.id === activeId)
    void selectSession(list[(idx + 1) % list.length].id)
  }
  const names = (list: typeof all) => list.slice(0, 8).map((r) => `• ${r.title}`).join('\n') + (list.length > 8 ? `\n… and ${list.length - 8} more` : '')
  const notRunning = byState.get('stopped') ?? []
  const busyStarts = Object.values(bulkBusy).filter((v) => v === 'start').length

  return (
    <div className="stats-bar drag" style={{ paddingLeft: sidebarOpen ? 10 : 84 }}>
      <span className="stat total no-drag" data-tip={`${all.length} session${all.length === 1 ? '' : 's'} in the sidebar${showArchived ? ' (including archived)' : ' (archived ones hidden)'}.\nClick a number to jump to the next session in that state.`}>
        {all.length} sessions
      </span>
      {ORDER.map((k) => {
        const list = byState.get(k) ?? []
        const n = list.length + (k === 'working' ? starting : 0)
        const legend = VISUAL_LEGEND.find((x) => x.key === k)
        return (
          <button key={k} className={`stat vs-${k} no-drag ${n ? '' : 'zero'}`} onClick={() => jumpTo(k === 'working' ? [...list, ...(byState.get('starting') ?? [])] : list)} data-tip={`${legend?.label ?? k}: ${legend?.description ?? ''}${n ? `\n${names(k === 'working' ? [...list, ...(byState.get('starting') ?? [])] : list)}\nClick to jump to the next one` : ''}`}>
            <StateMark state={k} />
            <b>{n}</b>
            <span className="lbl">{legend?.label ?? k}</span>
          </button>
        )
      })}
      <span className="stat-sep" />
      <span className={`stat stat-tasks no-drag ${background + subagents ? '' : 'zero'}`} data-tip={`${background} background shell${background === 1 ? '' : 's'} / monitor${background === 1 ? '' : 's'} and ${subagents} subagent${subagents === 1 ? '' : 's'} running across all sessions`}>
        <TerminalSquare size={12} className="ic-bg" />
        <b>{background}</b>
        <Bot size={12} className="ic-agent" />
        <b>{subagents}</b>
      </span>
      <span className="spacer" />
      {notRunning.length > 0 && (
        <button className="stat action no-drag" disabled={busyStarts > 0} onClick={() => void startSessions(notRunning.map((r) => r.id))} data-tip={`Start the Claude process of every session that is not running (${notRunning.length}), one after the other. Stop all / select all: sidebar view options.`}>
          <Play size={12} />
          <span>{busyStarts > 0 ? `starting ${busyStarts}…` : `Start all (${notRunning.length})`}</span>
        </button>
      )}
    </div>
  )
}
