import { createHash } from 'crypto'
import type { ConfigValues } from '@shared/claudeConfig'
import { IDLE_COMPACTION_MIN_TOKENS_ENV, configValueAt, isConfigObject, sameConfig } from '@shared/claudeConfig'
import type { IdleCompactionState } from '@shared/types'

export const IDLE_COMPACTION_POLL_MS = 30_000
export const IDLE_COMPACTION_AFTER_MS = 54 * 60_000
export const IDLE_COMPACTION_LATE_MS = 60_000
const CACHE_MS = 60 * 60_000
const DEFAULT_MIN_TOKENS = 200_000

export interface IdleCompactionCache {
  activityAt: number
  expiresAt: number
}

/** Read the CLI's own cache report. A configured TTL is not evidence of a warm cache. */
export function idleCompactionCache(text: string, now: number): IdleCompactionCache | null {
  const line = text.split('\n').find((s) => s.startsWith('Prompt cache (main):'))
  const match = line && /\bwarm \(1h TTL, last activity ([^)]+) ago\)\s*$/.exec(line)
  if (!match) return null
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }
  const parts = [...match[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)]
  if (!parts.length || match[1].replace(/\d+(?:\.\d+)?(?:ms|h|m|s)/g, '').trim()) return null
  const elapsed = parts.reduce((sum, p) => sum + Number(p[1]) * units[p[2]], 0)
  if (!Number.isFinite(elapsed) || elapsed >= CACHE_MS) return null
  // The CLI rounds its display to seconds. Use the older end of that interval, not extra cache life.
  const activityAt = now - elapsed - 1000
  return { activityAt, expiresAt: activityAt + CACHE_MS }
}

export function idleCompactionMinimum(settings: ConfigValues, env: Record<string, string | undefined>): number {
  const value = configValueAt(settings, ['env', IDLE_COMPACTION_MIN_TOKENS_ENV]) ?? env[IDLE_COMPACTION_MIN_TOKENS_ENV]
  const number = typeof value === 'string' && value.trim() ? Number(value) : undefined
  return number !== undefined && Number.isSafeInteger(number) && number > 0 ? Math.max(100_000, number) : DEFAULT_MIN_TOKENS
}

function requestSettings(values: ConfigValues): ConfigValues {
  const next = structuredClone(values)
  delete next.idleCompaction
  if (isConfigObject(next.env)) {
    delete next.env[IDLE_COMPACTION_MIN_TOKENS_ENV]
    if (!Object.keys(next.env).length) delete next.env
  }
  return next
}

export function idleCompactionRequestSettingsChanged(before: ConfigValues, after: ConfigValues): boolean {
  return !sameConfig(requestSettings(before), requestSettings(after))
}

/** Keep only a digest of observed effective settings, never a retained secret snapshot. */
export function idleCompactionRequestSettingsKey(values: ConfigValues): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : isConfigObject(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, sorted(v[key])])) : v
  return createHash('sha256').update(JSON.stringify(sorted(requestSettings(values)))).digest('hex')
}

export interface IdleCompactionContext {
  busy: boolean
  invalidated: boolean
  fastMode: boolean
  rateLimited: boolean
  lastInteractionAt: number
  contextTokens: number
}

/** The host only schedules; Claude Code's /compact still owns summarization and the transcript. */
export function idleCompactionPlan(
  settings: ConfigValues,
  env: Record<string, string | undefined>,
  cache: IdleCompactionCache | null,
  context: IdleCompactionContext,
  now: number
): IdleCompactionState {
  const minimumTokens = idleCompactionMinimum(settings, env)
  const state = (status: IdleCompactionState['status'], reason: string, nextAt?: number): IdleCompactionState => ({ status, reason, minimumTokens, nextAt })
  if (settings.idleCompaction !== true) return state('off', 'Idle compaction is off until explicitly enabled for this chat or in an inherited settings scope.')
  const disabled = (key: string) => [env[key], configValueAt(settings, ['env', key])].some((value) => /^(1|true|yes|on)$/i.test(String(value ?? '')))
  if (settings.autoCompactEnabled === false || disabled('DISABLE_COMPACT') || disabled('DISABLE_AUTO_COMPACT')) return state('waiting', 'Compaction is disabled by Claude Code settings or the process environment.')
  if (context.busy) return state('waiting', 'Waiting for the chat, its queue, permissions and background tasks to become idle.')
  if (context.fastMode) return state('waiting', 'Idle compaction does not start paid fast-mode requests. Turn fast mode off to allow it.')
  if (context.rateLimited) return state('waiting', 'Claude Code reports a usage warning or limit; no automatic compaction will be requested.')
  if (context.invalidated) return state('waiting', 'The conversation or its request settings changed. Waiting for a new model response before using its cache.')
  if (context.contextTokens < minimumTokens) return state('waiting', `Waiting for at least ${minimumTokens.toLocaleString('en-US')} context tokens.`)
  if (!cache || cache.expiresAt <= now) return state('waiting', 'Claude Code has not reported a warm one-hour prompt cache. Five-minute and expired caches are not compacted automatically.')
  const nextAt = cache.activityAt + IDLE_COMPACTION_AFTER_MS
  if (now < nextAt) return state('scheduled', 'Scheduled before the one-hour prompt cache expires; the conditions are checked again before starting.', nextAt)
  if (now - nextAt > IDLE_COMPACTION_LATE_MS) return state('skipped', 'The idle-compaction window was missed, for example while the computer slept. Waiting for a new model response.')
  if (now - context.lastInteractionAt < 60_000) return state('waiting', 'Recent activity in this chat; idle compaction will not start while you are interacting with it.')
  return state('ready', 'Ready to run Claude Code’s native /compact command while the chat is idle.')
}
