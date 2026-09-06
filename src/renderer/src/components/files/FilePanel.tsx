import React, { useRef, useState } from 'react'
import { Files, GitBranch, ListTodo } from 'lucide-react'
import type { SessionLiveState, SessionRecord } from '@shared/types'
import { useStore, type PanelTab } from '@/store'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { TasksPanel } from './TasksPanel'
import { GitPanel } from '../git/GitPanel'
import { UsageStatus } from '../status/UsageStatus'
import { useGitAutoRefresh } from '../git/useGitAutoRefresh'
import { taskCounts } from '@/lib/tasks'

export function FilePanel({ record, live }: { record: SessionRecord; live: SessionLiveState | undefined }) {
  const tab = useStore((s) => s.files[record.id]?.tab ?? 'files')
  const hasOpen = useStore((s) => (s.files[record.id]?.open.length ?? 0) > 0)
  const setFilesTab = useStore((s) => s.setFilesTab)
  const gitEnabled = useStore((s) => s.settings?.gitEnabled ?? true)
  const gitChanges = useStore((s) => {
    const st = s.git[record.id]?.status
    if (!st?.info.isRepo) return 0
    return st.files.filter((f) => f.worktree !== 'ignored' && (f.index || f.worktree)).length
  })
  const [treeHeight, setTreeHeight] = useState<number>(Number(localStorage.getItem('treeHeight') || 300))
  const dragging = useRef(false)
  useGitAutoRefresh(record.id, record.cwd, gitEnabled)

  const onDown = (e: React.MouseEvent) => {
    dragging.current = true
    const startY = e.clientY
    const startH = treeHeight
    let h = startH
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return
      h = Math.max(80, startH + (ev.clientY - startY))
      setTreeHeight(h)
    }
    const up = () => {
      dragging.current = false
      localStorage.setItem('treeHeight', String(h))
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const counts = taskCounts(live)
  const tasksN = counts.background + counts.subagents
  const effective: PanelTab = tab === 'git' && !gitEnabled ? 'files' : tab
  const tabBtn = (id: PanelTab, icon: React.ReactNode, label: string, count?: number, title?: string) => (
    <button className={`tab no-drag ${effective === id ? 'active' : ''}`} onClick={() => setFilesTab(record.id, id)} title={title ?? label}>
      {icon}
      <span className="tab-label">{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
  )
  return (
    <div className="files">
      <div className="files-top drag">
        {tabBtn('files', <Files size={13} />, 'Files')}
        {tabBtn('tasks', <ListTodo size={13} />, 'Tasks', tasksN, tasksN ? `${counts.background} background task(s), ${counts.subagents} subagent(s)` : 'Tasks')}
        {gitEnabled && tabBtn('git', <GitBranch size={13} />, 'Git', gitChanges, gitChanges ? `${gitChanges} changed file(s)` : 'Git')}
        <span className="spacer" />
        <UsageStatus compact />
      </div>
      <div className="files-body">
        {effective === 'tasks' ? (
          <TasksPanel live={live} sessionId={record.id} />
        ) : effective === 'git' ? (
          <GitPanel key={record.id} record={record} />
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
