import React from 'react'
import { Bot, Cpu, Loader2, Square, TerminalSquare } from 'lucide-react'
import type { BackgroundTaskView, SessionLiveState } from '@shared/types'
import { formatDuration, formatTokens, formatCost, relativeTime } from '@/lib/format'
import { barScale, contextLevel, contextPercent, contextWindowOf, isAgentTask, isTaskActive, taskCounts } from '@/lib/tasks'

function typeLabel(t: BackgroundTaskView): string {
  if (isAgentTask(t)) return 'subagent'
  const s = t.taskType.replace(/^local_/, '').replace(/_/g, ' ')
  return s === 'bash' ? 'shell' : s
}

export function TasksPanel({ live, sessionId }: { live: SessionLiveState | undefined; sessionId: string }) {
  if (!live) return <div className="tasks faint">Session is not running.</div>
  const tasks = live.backgroundTasks.filter((t) => !t.ambient)
  const counts = taskCounts(live)
  const pct = contextPercent(live)
  const level = contextLevel(live)
  const cu = live.contextUsage
  const used = cu?.totalTokens ?? live.contextTokens
  const win = contextWindowOf(live)
  return (
    <div className="tasks">
      <div className="tasks-summary">
        <span className="pill" data-tip="Background shells, monitors and workflows"><TerminalSquare size={11} /> {counts.background} background</span>
        <span className="pill" data-tip="Subagents currently running"><Bot size={11} /> {counts.subagents} subagent{counts.subagents === 1 ? '' : 's'}</span>
        <span className={`pill ctx-${level}`} data-tip="Context window in use"><Cpu size={11} /> context {pct == null ? '–' : `${pct}%`}</span>
      </div>
      <div>
        <h4>Background tasks & subagents</h4>
        {tasks.length === 0 && <div className="faint">None running.</div>}
        {tasks.map((t) => (
          <div className="task-item" key={t.taskId}>
            <div className="t-title">
              {isTaskActive(t) ? <Loader2 size={12} className="spin" /> : null}
              {isAgentTask(t) ? <Bot size={12} /> : <TerminalSquare size={12} />}
              <span className="ellipsis" style={{ flex: 1 }}>{t.description || t.taskType}</span>
              {isTaskActive(t) && (
                <button className="btn ghost icon" data-tip="Stop this task" onClick={() => window.api.sessions.stopTask(sessionId, t.taskId)}>
                  <Square size={11} />
                </button>
              )}
            </div>
            <div className="t-sub">
              {typeLabel(t)}
              {t.status ? ` · ${t.status}` : ''}
              {t.startedAt ? ` · started ${relativeTime(t.startedAt)}` : ''}
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
              {t.parentToolUseId && <span className="pill">in subagent</span>}
              <span className="faint" style={{ marginLeft: 'auto' }}>{formatDuration(t.elapsedSeconds * 1000)}</span>
            </div>
          </div>
        ))}
      </div>
      <div>
        <h4>Context window</h4>
        <div className={`ctx-summary level-${level}`} style={{ marginBottom: 8 }}>
          <span className="big">{pct == null ? '–' : `${pct}%`}</span>
          <span>
            {formatTokens(used)} of {formatTokens(win)} tokens
            <br />
            <span className="faint">{cu ? `measured ${relativeTime(cu.checkedAt)}` : 'estimated from the last response'}</span>
          </span>
        </div>
        {cu?.categories?.filter((c) => c.tokens > 0).length ? (
          <div className="cat-list">
            {cu.categories
              .filter((c) => c.tokens > 0)
              .map((c) => (
                <div className="cat-row" key={c.name} data-tip={`${c.name}: ${c.tokens.toLocaleString()} tokens`}>
                  <span className="cat-name">{c.name}</span>
                  <span className="cat-track">
                    <span className="cat-fill" style={{ width: `${Math.min(100, (c.tokens / barScale(cu.categories)) * 100)}%`, background: c.color || 'var(--accent)' }} />
                  </span>
                  <span className="cat-val">{formatTokens(c.tokens)}</span>
                </div>
              ))}
          </div>
        ) : (
          <div className="faint">Breakdown appears once the process is running.</div>
        )}
      </div>
      <div>
        <h4>Session</h4>
        <div className="kv">
          <span className="k">status</span><span className="v">{live.status}</span>
          <span className="k">process</span><span className="v">{live.processAlive ? 'alive' : 'stopped'}</span>
          <span className="k">model</span><span className="v">{live.model ?? '–'}</span>
          <span className="k">mode</span><span className="v">{live.permissionMode ?? '–'}</span>
          <span className="k">effort</span><span className="v">{live.effort ?? 'default'}</span>
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
              <span className="v">{live.rateLimit.status}{live.rateLimit.utilization != null ? ` · ${Math.round(live.rateLimit.utilization <= 1 ? live.rateLimit.utilization * 100 : live.rateLimit.utilization)}%` : ''}{live.rateLimit.resetsAt ? ` · resets ${new Date(live.rateLimit.resetsAt * 1000).toLocaleString()}` : ''}</span>
            </>
          )}
          {live.claudeVersion && (<><span className="k">claude</span><span className="v">v{live.claudeVersion}</span></>)}
        </div>
      </div>
    </div>
  )
}
