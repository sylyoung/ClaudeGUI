import type { SessionLiveState } from '@shared/types'
import { taskCounts } from './tasks'

/**
 * One visual state per session, used consistently by the sidebar, the status board and the chat
 * header (colour + wording):
 *   working     – Claude is generating or running tools
 *   attention   – waiting for your answer (permission prompt / question)
 *   idle-tasks  – Claude is idle but background shells, monitors or subagents are still running
 *   idle        – process alive, nothing running
 *   stopped     – no process (starts again with the next message)
 *   error       – the process failed (see the message in the chat)
 *   starting    – process is starting
 */
export type VisualKey = 'working' | 'attention' | 'idle-tasks' | 'idle' | 'stopped' | 'error' | 'starting'

export interface VisualState {
  key: VisualKey
  /** Short label ("working", "needs input"…). */
  label: string
  /** One-line explanation for tooltips. */
  description: string
  background: number
  subagents: number
}

export const VISUAL_LEGEND: { key: VisualKey; label: string; description: string }[] = [
  { key: 'working', label: 'working', description: 'Claude is generating or running tools' },
  { key: 'attention', label: 'needs input', description: 'Waiting for you: a permission prompt or a question' },
  { key: 'idle-tasks', label: 'idle, tasks running', description: 'Claude is idle but background shells, monitors or subagents are still running' },
  { key: 'idle', label: 'idle', description: 'Process alive, nothing running' },
  { key: 'stopped', label: 'not running', description: 'No Claude process; sending a message starts one' },
  { key: 'error', label: 'error', description: 'The process failed; open the chat for details' }
]

export function visualState(live: SessionLiveState | undefined): VisualState {
  const counts = taskCounts(live)
  const base = { background: counts.background, subagents: counts.subagents }
  if (!live) return { key: 'stopped', label: 'not running', description: 'No Claude process; sending a message starts one', ...base }
  switch (live.status) {
    case 'error':
      return { key: 'error', label: 'error', description: live.error || 'The process failed', ...base }
    case 'requires_action':
      return { key: 'attention', label: 'needs input', description: 'Waiting for you: a permission prompt or a question', ...base }
    case 'starting':
      return { key: 'starting', label: 'starting', description: 'The Claude process is starting', ...base }
    case 'running': {
      const what = live.activity === 'compacting' ? 'compacting the context' : live.activeTools.length ? `running ${live.activeTools[live.activeTools.length - 1].toolName}` : 'generating'
      return { key: 'working', label: 'working', description: `Claude is ${what}`, ...base }
    }
    case 'idle': {
      const n = counts.background + counts.subagents
      if (n > 0) {
        const parts: string[] = []
        if (counts.background) parts.push(`${counts.background} background task${counts.background === 1 ? '' : 's'}`)
        if (counts.subagents) parts.push(`${counts.subagents} subagent${counts.subagents === 1 ? '' : 's'}`)
        return { key: 'idle-tasks', label: 'idle · tasks', description: `Claude is idle; still running: ${parts.join(', ')}`, ...base }
      }
      return { key: 'idle', label: 'idle', description: 'Process alive, nothing running', ...base }
    }
    default:
      return { key: 'stopped', label: 'not running', description: 'No Claude process; sending a message starts one', ...base }
  }
}
