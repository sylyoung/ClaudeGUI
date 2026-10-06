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

/** Tokens in the context, as far as the session has reported them. */
export function contextTokens(live: SessionLiveState | undefined): number | undefined {
  return live?.contextUsage?.totalTokens ?? live?.contextTokens
}

/** Colour cut-offs of the terminal status line (~/.claude/statusline-command.sh). */
export const CTX_GREEN_MAX_TOKENS = 200_000
export const CTX_YELLOW_MAX_TOKENS = 500_000
export const CTX_FULL_PERCENT = 85

/**
 * Colour of the context indicators, following the same rule as the Claude Code status line in the
 * terminal: green up to 200k input tokens, yellow up to 500k, red above that. A window smaller
 * than 200k tokens would never leave green with that rule alone, so a context at least 85 % full
 * is red as well.
 */
export function contextLevel(live: SessionLiveState | undefined): 'ok' | 'warn' | 'high' | 'none' {
  const percent = contextPercent(live)
  if (percent == null) return 'none'
  const tokens = contextTokens(live) ?? 0
  if (tokens > CTX_YELLOW_MAX_TOKENS || percent >= CTX_FULL_PERCENT) return 'high'
  if (tokens > CTX_GREEN_MAX_TOKENS) return 'warn'
  return 'ok'
}

/** Wording of the rule above, for tooltips. */
export const CONTEXT_COLOUR_RULE =
  'Colours follow your terminal status line: green up to 200k tokens, yellow up to 500k, red above — and red as well from 85% of the window.'

/** Bars in the context breakdown are scaled to the largest occupied category (free space is capped). */
export function barScale(categories: { name: string; tokens: number; kind?: string }[]): number {
  let max = 1
  for (const c of categories) if (!/free/i.test(c.name) && c.kind !== 'free' && c.tokens > max) max = c.tokens
  return max
}
