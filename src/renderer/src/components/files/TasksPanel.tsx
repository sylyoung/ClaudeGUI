import React from 'react'
import { Loader2, Square } from 'lucide-react'
import type { SessionLiveState } from '@shared/types'
import { formatDuration, formatTokens, formatCost } from '@/lib/format'

export function TasksPanel({ live, sessionId }: { live: SessionLiveState | undefined; sessionId: string }) {
  if (!live) return <div className="tasks faint">Session is not running.</div>
  const tasks = live.backgroundTasks.filter((t) => !t.ambient)
  return (
    <div className="tasks">
      <div>
        <h4>Background tasks</h4>
        {tasks.length === 0 && <div className="faint">None running.</div>}
        {tasks.map((t) => (
          <div className="task-item" key={t.taskId}>
            <div className="t-title">
              {t.status === 'running' || !t.status ? <Loader2 size={12} className="spin" /> : null}
              <span className="ellipsis" style={{ flex: 1 }}>{t.description || t.taskType}</span>
              {(t.status === 'running' || !t.status) && (
                <button className="btn ghost icon" title="Stop this task" onClick={() => window.api.sessions.stopTask(sessionId, t.taskId)}>
                  <Square size={11} />
                </button>
              )}
            </div>
            <div className="t-sub">
              {t.taskType}
              {t.status ? ` · ${t.status}` : ''}
              {t.usage ? ` · ${formatTokens(t.usage.total_tokens)} tok · ${t.usage.tool_uses} tools · ${formatDuration(t.usage.duration_ms)}` : ''}
            </div>
            {t.summary && <div className="t-sub">{t.summary}</div>}
          </div>
        ))}
      </div>
      <div>
        <h4>Active tools</h4>
        {live.activeTools.length === 0 && <div className="faint">None.</div>}
        {live.activeTools.map((t) => (
          <div className="task-item" key={t.toolUseId}>
            <div className="t-title">
              <Loader2 size={12} className="spin" /> {t.toolName}
              <span className="faint" style={{ marginLeft: 'auto' }}>{formatDuration(t.elapsedSeconds * 1000)}</span>
            </div>
          </div>
        ))}
      </div>
      <div>
        <h4>Session</h4>
        <div className="kv">
          <span className="k">status</span><span className="v">{live.status}</span>
          <span className="k">process</span><span className="v">{live.processAlive ? 'alive' : 'stopped'}</span>
          <span className="k">model</span><span className="v">{live.model ?? '–'}</span>
          <span className="k">mode</span><span className="v">{live.permissionMode ?? '–'}</span>
          <span className="k">effort</span><span className="v">{live.effort ?? 'default'}</span>
          <span className="k">context</span><span className="v">{formatTokens(live.contextTokens)}</span>
          <span className="k">cost</span><span className="v">{formatCost(live.totalCostUsd)}</span>
          {live.lastTurn && (
            <>
              <span className="k">last turn</span>
              <span className="v">{formatDuration(live.lastTurn.durationMs)} · in {formatTokens(live.lastTurn.inputTokens)} · out {formatTokens(live.lastTurn.outputTokens)}</span>
            </>
          )}
          {live.rateLimit && (
            <>
              <span className="k">rate limit</span>
              <span className="v">{live.rateLimit.status}{live.rateLimit.utilization != null ? ` · ${Math.round(live.rateLimit.utilization * 100)}%` : ''}{live.rateLimit.resetsAt ? ` · resets ${new Date(live.rateLimit.resetsAt * 1000).toLocaleString()}` : ''}</span>
            </>
          )}
          {live.claudeVersion && (<><span className="k">claude</span><span className="v">v{live.claudeVersion}</span></>)}
        </div>
      </div>
    </div>
  )
}
