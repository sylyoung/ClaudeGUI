import React, { useRef, useState } from 'react'
import { Files, ListTodo } from 'lucide-react'
import type { SessionLiveState, SessionRecord } from '@shared/types'
import { useStore } from '@/store'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { TasksPanel } from './TasksPanel'

export function FilePanel({ record, live }: { record: SessionRecord; live: SessionLiveState | undefined }) {
  const tab = useStore((s) => s.files[record.id]?.tab ?? 'files')
  const hasOpen = useStore((s) => (s.files[record.id]?.open.length ?? 0) > 0)
  const setFilesTab = useStore((s) => s.setFilesTab)
  const [treeHeight, setTreeHeight] = useState<number>(Number(localStorage.getItem('treeHeight') || 300))
  const dragging = useRef(false)

  const onDown = (e: React.MouseEvent) => {
    dragging.current = true
    const startY = e.clientY
    const startH = treeHeight
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return
      const h = Math.max(80, startH + (ev.clientY - startY))
      setTreeHeight(h)
    }
    const up = () => {
      dragging.current = false
      localStorage.setItem('treeHeight', String(treeHeight))
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const attention = live?.backgroundTasks.filter((t) => !t.ambient).length ?? 0
  return (
    <div className="files">
      <div className="files-top drag">
        <button className={`tab no-drag ${tab === 'files' ? 'active' : ''}`} onClick={() => setFilesTab(record.id, 'files')}>
          <Files size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Files
        </button>
        <button className={`tab no-drag ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setFilesTab(record.id, 'tasks')}>
          <ListTodo size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Tasks{attention ? ` (${attention})` : ''}
        </button>
        <span className="spacer" />
      </div>
      <div className="files-body">
        {tab === 'tasks' ? (
          <TasksPanel live={live} sessionId={record.id} />
        ) : (
          <>
            <div style={{ height: hasOpen ? treeHeight : undefined, flex: hasOpen ? undefined : 1, display: 'flex', flexDirection: 'column', minHeight: 60 }}>
              <FileTree sessionId={record.id} root={record.cwd} />
            </div>
            {hasOpen && <div className="split-h" onMouseDown={onDown} />}
            <FileViewer sessionId={record.id} />
          </>
        )}
      </div>
    </div>
  )
}
