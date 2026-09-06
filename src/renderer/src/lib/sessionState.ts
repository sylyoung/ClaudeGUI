import type { SessionLiveState } from '@shared/types'
import { taskCounts } from './tasks'

/**
 * One visual state per session, used consistently by the sidebar, the status board and the chat
 * header (colour + wording). Seven states plus a transient "starting":
 *   working     – Claude is generating or running tools                        (blue "...")
 *   permission  – a tool needs your approval before it can run                 (amber "!")
 *   option      – Claude asked you a question and waits for your choice        (red "Q")
 *   unread      – the last turn finished and you have not read it yet          (pink "N")
 *   idle-tasks  – nothing to read, but background shells/monitors/subagents run (teal "↻")
 *   idle        – process alive, nothing running, nothing new                  (grey "·")
 *   stopped     – no process (starts again with the next message)              (grey "○")
 *   error       – the process failed (see the message in the chat)             (red "×")
 * A session in several situations at once is shown by the first match in that order.
 */
export type VisualKey = 'working' | 'permission' | 'option' | 'unread' | 'idle-tasks' | 'idle' | 'stopped' | 'error' | 'starting'

export interface VisualState {
  key: VisualKey
  /** Short label ("working", "permission"…). */
  label: string
  /** One-line explanation for tooltips. */
  description: string
  background: number
  subagents: number
}

/**
 * Short, obvious marker printed instead of a coloured dot, so a state is readable at a glance:
 *   working "..." (animated) · permission "!" · option "Q" (question) · unread "N" (new) ·
 *   idle with tasks "↻" · idle "·" · not running "○" · error "×"
 */
export const STATE_MARKER: Record<VisualKey, string> = {
  working: '...',
  starting: '...',
  permission: '!',
  option: 'Q',
  unread: 'N',
  'idle-tasks': '↻',
  idle: '·',
  stopped: '○',
  error: '×'
}

/** Tools that ask you to pick one of several presented options rather than to approve a command. */
const QUESTION_TOOLS = ['AskUserQuestion']

export const VISUAL_LEGEND: { key: VisualKey; label: string; description: string }[] = [
  { key: 'working', label: 'working', description: 'Claude is generating or running tools' },
  { key: 'permission', label: 'permission', description: 'A tool needs your approval before it can run' },
  { key: 'option', label: 'option', description: 'Claude asked you a question and is waiting for you to choose an option' },
  { key: 'unread', label: 'unread', description: 'The last turn finished and you have not read it yet' },
  { key: 'idle-tasks', label: 'idle · tasks', description: 'Claude is idle but background shells, monitors or subagents are still running' },
  { key: 'idle', label: 'idle', description: 'Process alive, nothing running, nothing new to read' },
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
    case 'requires_action': {
      const pending = live.pendingPermissions ?? []
      const question = pending.length > 0 && pending.every((p) => QUESTION_TOOLS.includes(p.toolName))
      const first = pending[0]
      if (question) return { key: 'option', label: 'option', description: first?.title || 'Claude asked you a question; choose one of the options', ...base }
      const what = first ? `${first.displayName || first.toolName} needs your approval` : 'A tool needs your approval'
      return { key: 'permission', label: 'permission', description: what, ...base }
    }
    case 'starting':
      return { key: 'starting', label: 'starting', description: 'The Claude process is starting', ...base }
    case 'running': {
      const what = live.activity === 'compacting' ? 'compacting the context' : live.activeTools.length ? `running ${live.activeTools[live.activeTools.length - 1].toolName}` : 'generating'
      return { key: 'working', label: 'working', description: `Claude is ${what}`, ...base }
    }
    case 'idle': {
      if (live.unread > 0) {
        const n = live.unread
        return { key: 'unread', label: 'unread', description: `${n} finished turn${n === 1 ? '' : 's'} you have not read yet`, ...base }
      }
      const n = counts.background + counts.subagents
      if (n > 0) {
        const parts: string[] = []
        if (counts.background) parts.push(`${counts.background} background task${counts.background === 1 ? '' : 's'}`)
        if (counts.subagents) parts.push(`${counts.subagents} subagent${counts.subagents === 1 ? '' : 's'}`)
        return { key: 'idle-tasks', label: 'idle · tasks', description: `Claude is idle; still running: ${parts.join(', ')}`, ...base }
      }
      return { key: 'idle', label: 'idle', description: 'Process alive, nothing running, nothing new to read', ...base }
    }
    default:
      return { key: 'stopped', label: 'not running', description: 'No Claude process; sending a message starts one', ...base }
  }
}
