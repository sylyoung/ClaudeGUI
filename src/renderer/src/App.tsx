import React, { useEffect, useRef } from 'react'
import { currentOrder, useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/chat/ChatView'
import { FilePanel } from './components/files/FilePanel'
import { NewSessionDialog } from './components/dialogs/NewSessionDialog'
import { ImportSessionDialog } from './components/dialogs/ImportSessionDialog'
import { SettingsDialog } from './components/dialogs/SettingsDialog'
import { ShortcutsDialog } from './components/dialogs/ShortcutsDialog'
import { UsageStatus } from './components/status/UsageStatus'
import { StatusBoard } from './components/StatusBoard'
import { TooltipLayer } from './components/common/Tooltip'

function Resizer({ onDrag, onEnd }: { onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = React.useState(false)
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    let last = e.clientX
    const move = (ev: MouseEvent) => {
      onDrag(ev.clientX - last)
      last = ev.clientX
    }
    const up = () => {
      setDragging(false)
      onEnd()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className={`resizer ${dragging ? 'dragging' : ''}`} onMouseDown={onDown} />
}

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const applyEvent = useStore((s) => s.applyEvent)
  const activeId = useStore((s) => s.activeId)
  const record = useStore((s) => (s.activeId ? s.records[s.activeId] : undefined))
  const live = useStore((s) => (s.activeId ? s.live[s.activeId] : undefined))
  const dialog = useStore((s) => s.dialog)
  const setDialog = useStore((s) => s.setDialog)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const filesOpen = useStore((s) => s.filesOpen)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const filesWidth = useStore((s) => s.filesWidth)
  const setWidths = useStore((s) => s.setWidths)
  const toasts = useStore((s) => s.toasts)
  const showBoard = useStore((s) => s.settings?.showStatusBoard ?? true)
  const widthRef = useRef({ sidebarWidth, filesWidth })
  widthRef.current = { sidebarWidth, filesWidth }

  useEffect(() => {
    void init()
    const offs = [
      window.api.events.onSessionEvent(applyEvent),
      window.api.events.onUsage((u) => useStore.getState().setUsage(u)),
      window.api.events.onTheme((t) => useStore.getState().setTheme(t)),
      window.api.events.onSettingsChanged((s) => useStore.getState().receiveSettings(s)),
      window.api.events.onUpdate((u) => useStore.getState().setUpdate(u)),
      window.api.events.onSessionsReload(() => void useStore.getState().reloadSessions())
    ]
    return () => offs.forEach((off) => off())
  }, [init, applyEvent])

  // keyboard shortcuts + menu commands
  useEffect(() => {
    const cycle = (dir: 1 | -1) => {
      const s = useStore.getState()
      const list = currentOrder(s)
      if (!list.length) return
      const idx = list.findIndex((r) => r.id === s.activeId)
      const next = list[(idx + dir + list.length) % list.length]
      void s.selectSession(next.id)
    }
    const offMenu = window.api.events.onMenu((cmd) => {
      const s = useStore.getState()
      switch (cmd) {
        case 'menu:settings': setDialog('settings'); break
        case 'menu:new-session': setDialog('new-session'); break
        case 'menu:import-session': setDialog('import-session'); break
        case 'menu:next-session': cycle(1); break
        case 'menu:prev-session': cycle(-1); break
        case 'menu:focus-composer': s.focusComposer(); break
        case 'menu:toggle-sidebar': s.toggleSidebar(); break
        case 'menu:toggle-files': s.toggleFiles(); break
        case 'menu:toggle-git': s.showPanelTab('git'); break
        case 'menu:search': s.focusSearch(); break
        case 'menu:interrupt': if (s.activeId) void s.interruptSession(s.activeId); break
        case 'menu:shortcuts': s.setDialog('shortcuts'); break
        case 'menu:toggle-board': void s.setSettings({ showStatusBoard: !(s.settings?.showStatusBoard ?? true) }); break
        case 'menu:toggle-view': void s.setSettings({ sidebarView: (s.settings?.sidebarView ?? 'groups') === 'groups' ? 'recent' : 'groups' }); break
        case 'menu:select-all': s.setSelectedIds(currentOrder(s).map((r) => r.id)); break
        case 'menu:start-all': void s.startSessions(currentOrder(s).filter((r) => !s.live[r.id]?.processAlive).map((r) => r.id)); break
        case 'menu:check-updates':
          s.openSettings('about')
          window.api.update.check().catch((err) => s.toast(`Update check failed: ${(err as Error).message}`, 'error'))
          break
      }
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const s = useStore.getState()
        const list = currentOrder(s)
        const target = list[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          void s.selectSession(target.id)
        }
      }
      if (e.key === 'Escape') {
        const s = useStore.getState()
        if (s.dialog) setDialog(null)
        else if (s.selectedIds.length) s.setSelectedIds([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offMenu()
      window.removeEventListener('keydown', onKey)
    }
  }, [setDialog])

  if (!ready) return <div className="empty-state">Loading…</div>

  return (
    <div className="app">
      {sidebarOpen && (
        <>
          <div style={{ width: sidebarWidth, flexShrink: 0, minWidth: 0, display: 'flex' }}>
            <Sidebar />
          </div>
          <Resizer onDrag={(dx) => setWidths({ sidebarWidth: Math.min(480, Math.max(200, widthRef.current.sidebarWidth + dx)) })} onEnd={() => undefined} />
        </>
      )}
      <div className="main">
        {showBoard && <StatusBoard />}
        <div className="main-row">
          {record ? (
            <ChatView key={record.id} record={record} live={live} />
          ) : (
            <div className="chat">
              <div className="chat-header drag" style={{ paddingLeft: sidebarOpen || showBoard ? 12 : 84 }}>
                <span className="title faint">No session selected</span>
                <span className="spacer" />
                <UsageStatus compact />
              </div>
              <div className="empty-state">
                <h2>No session selected</h2>
                <div className="hint">
                  Create a new session with <span className="kbd">⌘N</span>, or import your existing Claude Code terminal sessions with <span className="kbd">⌘⇧I</span>. Switch sessions with <span className="kbd">⌘1</span>…<span className="kbd">⌘9</span> or <span className="kbd">⌘⇧[</span> / <span className="kbd">⌘⇧]</span>.
                </div>
                <div className="row" style={{ display: 'flex', gap: 8 }}>
                  <button className="btn primary" onClick={() => setDialog('new-session')}>New session</button>
                  <button className="btn" onClick={() => setDialog('import-session')}>Import CLI session</button>
                </div>
              </div>
            </div>
          )}
          {record && filesOpen && (
            <>
              <Resizer onDrag={(dx) => setWidths({ filesWidth: Math.min(1100, Math.max(260, widthRef.current.filesWidth - dx)) })} onEnd={() => undefined} />
              <div style={{ width: filesWidth, flexShrink: 0, minWidth: 0, display: 'flex' }}>
                <FilePanel record={record} live={live} />
              </div>
            </>
          )}
        </div>
      </div>
      <TooltipLayer />
      {dialog === 'new-session' && <NewSessionDialog onClose={() => setDialog(null)} />}
      {dialog === 'import-session' && <ImportSessionDialog onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => useStore.getState().dismissToast(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
      {activeId && !record && null}
    </div>
  )
}
