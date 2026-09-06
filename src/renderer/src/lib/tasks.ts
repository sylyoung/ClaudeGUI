import type { BackgroundTaskView, SessionLiveState } from '@shared/types'

export function isAgentTask(t: BackgroundTaskView): boolean {
  return /agent|teammate/i.test(t.taskType)
}

export function isTaskActive(t: BackgroundTaskView): boolean {
  return !t.status || t.status === 'running' || t.status === 'pending' || t.status === 'paused'
}

/** Live counts of background shells/monitors and subagents for a session. */
export function taskCounts(live: SessionLiveState | undefined): { background: number; subagents: number } {
  if (!live) return { background: 0, subagents: 0 }
  const tasks = live.backgroundTasks.filter((t) => !t.ambient && isTaskActive(t))
  const taskToolIds = new Set(tasks.map((t) => t.toolUseId).filter(Boolean))
  const foregroundAgents = live.activeTools.filter((t) => (t.toolName === 'Agent' || t.toolName === 'Task') && !taskToolIds.has(t.toolUseId)).length
  return {
    background: tasks.filter((t) => !isAgentTask(t)).length,
    subagents: tasks.filter(isAgentTask).length + foregroundAgents
  }
}

export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Percentage of the context window in use (0-100+), or undefined when nothing is known yet. */
export function contextPercent(live: SessionLiveState | undefined): number | undefined {
  if (!live) return undefined
  if (live.contextUsage) return live.contextUsage.percentage
  if (live.contextTokens && live.contextWindow) return Math.round((live.contextTokens / live.contextWindow) * 100)
  if (live.contextTokens) return Math.round((live.contextTokens / DEFAULT_CONTEXT_WINDOW) * 100)
  return undefined
}

export function contextWindowOf(live: SessionLiveState | undefined): number {
  return live?.contextUsage?.maxTokens || live?.contextWindow || DEFAULT_CONTEXT_WINDOW
}

export function contextLevel(percent: number | undefined): 'ok' | 'warn' | 'high' | 'none' {
  if (percent == null) return 'none'
  if (percent >= 85) return 'high'
  if (percent >= 60) return 'warn'
  return 'ok'
}

/** Bars in the context breakdown are scaled to the largest occupied category (free space is capped). */
export function barScale(categories: { name: string; tokens: number; kind?: string }[]): number {
  let max = 1
  for (const c of categories) if (!/free/i.test(c.name) && c.kind !== 'free' && c.tokens > max) max = c.tokens
  return max
}
