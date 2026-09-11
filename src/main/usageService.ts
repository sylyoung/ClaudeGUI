import { spawn } from 'child_process'
import type { AuthState, SdkUsage, UsageSeverity, UsageSnapshot, UsageWindow } from '@shared/types'
import { readStoredLogin } from './claudeLogin'

/**
 * Tracks the claude.ai plan rate-limit windows (5-hour session, weekly, per-model, monthly credits).
 *
 * Primary source: the same usage endpoint the CLI's /usage command reads, called with the OAuth
 * token Claude Code stored at login (macOS Keychain or ~/.claude/.credentials.json). Requests go
 * through `curl` so the proxy variables from the user's shell apply. Fallbacks: the structured
 * usage of an already running session, and the rate-limit events every API response carries.
 */

export interface UsageDeps {
  getEnv(): Promise<Record<string, string>>
  getSettings(): { usageRefreshMinutes: number; usageWarnPercent: number }
  /** Plan limits through an already-running Claude session, or null when none is alive. */
  sessionUsage(): Promise<SdkUsage | null>
  /** Whether Claude Code is signed in, to say truthfully why no plan limits can be read. */
  checkAuth(): Promise<AuthState>
  emit(snapshot: UsageSnapshot): void
  log(...args: unknown[]): void
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** Do not hammer the endpoint when many turns finish at once. */
const MIN_INTERVAL_MS = 20_000

export class UsageService {
  snapshot: UsageSnapshot = { fetchedAt: 0, source: 'none', windows: [] }
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<UsageSnapshot> | null = null

  constructor(private deps: UsageDeps) {}

  start(): void {
    void this.refresh('startup')
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Re-arm the periodic timer (after a settings change). */
  reschedule(): void {
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const minutes = Math.max(1, Number(this.deps.getSettings().usageRefreshMinutes) || 5)
    const ms = minutes * 60_000
    this.snapshot = { ...this.snapshot, nextCheckAt: Date.now() + ms }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh('timer')
    }, ms)
    this.timer.unref?.()
  }

  /** Refresh unless a check happened very recently (called after every finished turn). */
  refreshSoon(reason: string): void {
    if (Date.now() - this.snapshot.fetchedAt < MIN_INTERVAL_MS) return
    void this.refresh(reason)
  }

  refresh(reason: string): Promise<UsageSnapshot> {
    if (this.inflight) return this.inflight
    this.inflight = this.doRefresh(reason).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(reason: string): Promise<UsageSnapshot> {
    this.snapshot = { ...this.snapshot, checking: true }
    this.deps.emit(this.snapshot)
    const warn = Number(this.deps.getSettings().usageWarnPercent) || 50
    let next: UsageSnapshot | null = null
    let error: string | undefined
    try {
      const env = await this.deps.getEnv()
      const login = await readStoredLogin()
      if (login) {
        const res = await curlJson(USAGE_URL, [`Authorization: Bearer ${login.accessToken}`, 'anthropic-beta: oauth-2025-04-20', 'Accept: application/json', 'User-Agent: ClaudeGUI'], env)
        if (res.status === 200 && res.json) {
          next = { fetchedAt: Date.now(), source: 'endpoint', windows: normalizeEndpoint(res.json as Record<string, unknown>, warn), subscription: login.subscription ?? this.snapshot.subscription }
        } else if (res.status === 401 || res.status === 403) {
          // An expired access token is normal between messages: Claude Code renews it when a chat
          // next talks to Claude. Anything else means the login itself was not accepted.
          error =
            login.accessExpiresAt && login.accessExpiresAt < Date.now()
              ? 'The stored login token has expired and Claude Code has not renewed it yet; it does so with the next message a chat sends.'
              : `claude.ai did not accept the stored login (HTTP ${res.status}). If chats fail as well, sign in again.`
        } else error = `usage endpoint returned HTTP ${res.status}`
      } else {
        // No stored login can mean signed out (the login expired and Claude Code removed it) or a
        // different way of signing in; `claude auth status` tells them apart.
        const auth = await this.deps.checkAuth().catch(() => null)
        error =
          auth?.status === 'api-key'
            ? 'Claude Code signs in with an API key here, so there are no plan limits to show.'
            : auth?.status === 'signed-in'
              ? 'Claude Code is signed in, but its login could not be read here, so the plan limits come from the chats instead.'
              : 'Claude Code is signed out: its login has expired, so chats cannot run and plan limits cannot be read. Sign in again from the notice at the top of the window.'
      }
      if (!next) {
        const viaSession = await this.deps.sessionUsage().catch(() => null)
        if (viaSession?.rate_limits) {
          next = { fetchedAt: Date.now(), source: 'session', windows: normalizeSdk(viaSession.rate_limits, warn), subscription: viaSession.subscription_type ?? this.snapshot.subscription }
          error = undefined
        }
      }
    } catch (err) {
      error = (err as Error).message
    }
    if (error) this.deps.log(`[usage] refresh (${reason}) failed: ${error}`)
    else this.deps.log(`[usage] refreshed (${reason}) via ${next?.source}: ${next?.windows.map((w) => `${w.label}=${w.percent ?? '?'}%`).join(', ')}`)
    this.snapshot = next ? { ...next, checking: false, error: undefined } : { ...this.snapshot, checking: false, error }
    this.schedule()
    this.deps.emit(this.snapshot)
    return this.snapshot
  }

  /** Merge a rate_limit_event that a session received with its API response. */
  applyRateLimitEvent(info: { rateLimitType?: string; utilization?: number; resetsAt?: number; status?: string }, ts: number): void {
    const key = eventKey(info.rateLimitType)
    if (!key || info.utilization == null) return
    const warn = Number(this.deps.getSettings().usageWarnPercent) || 50
    const percent = info.utilization <= 1 ? Math.round(info.utilization * 100) : Math.round(info.utilization)
    const windows = this.snapshot.windows.slice()
    const idx = windows.findIndex((w) => w.key === key)
    const base: UsageWindow = idx >= 0 ? windows[idx] : { key, label: labelFor(key), group: groupFor(key), percent: null, severity: 'unknown', updatedAt: 0 }
    const severity: UsageSeverity = info.status === 'rejected' ? 'critical' : info.status === 'allowed_warning' ? 'warning' : severityFor(percent, warn)
    const w: UsageWindow = { ...base, percent, severity, resetsAt: info.resetsAt ? info.resetsAt * 1000 : base.resetsAt, updatedAt: ts }
    if (idx >= 0) windows[idx] = w
    else windows.push(w)
    this.snapshot = { ...this.snapshot, windows: sortWindows(windows), source: this.snapshot.source === 'none' ? 'event' : this.snapshot.source }
    this.deps.emit(this.snapshot)
  }
}

// ---------------------------------------------------------------- endpoint

/** GET a JSON document with curl (honours the proxy variables of the captured shell environment). */
function curlJson(url: string, headers: string[], env: Record<string, string>): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    // The token travels in a config document on stdin so it never appears in the process list.
    const config = headers.map((h) => `header = ${JSON.stringify(h)}`).join('\n') + `\nurl = ${JSON.stringify(url)}\n`
    const child = spawn('curl', ['-sS', '--max-time', '25', '-K', '-', '-o', '-', '-w', '\n%{http_code}'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) return reject(new Error(`curl failed (${code}): ${err.trim() || 'no output'}`))
      const nl = out.lastIndexOf('\n')
      const status = Number(out.slice(nl + 1).trim())
      const body = out.slice(0, nl)
      let json: unknown = null
      try {
        json = JSON.parse(body)
      } catch {
        /* not json */
      }
      resolve({ status: Number.isFinite(status) ? status : 0, json })
    })
    child.stdin.end(config)
  })
}

// ---------------------------------------------------------------- normalizing

const GROUP_ORDER: Record<UsageWindow['group'], number> = { session: 0, weekly: 1, model: 2, monthly: 3, other: 4 }

function sortWindows(list: UsageWindow[]): UsageWindow[] {
  return list.slice().sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.label.localeCompare(b.label))
}

/**
 * Same thresholds as the Claude Code status line in the terminal
 * (~/.claude/statusline-command.sh: green up to 50 %, yellow up to 90 %, red above).
 * `warn` is the amber cut-off from the settings; red starts at CRITICAL_PERCENT.
 */
const CRITICAL_PERCENT = 90

function severityFor(percent: number | null, warn: number): UsageSeverity {
  if (percent == null) return 'unknown'
  if (percent >= 100) return 'locked'
  if (percent >= CRITICAL_PERCENT) return 'critical'
  if (percent >= warn) return 'warning'
  return 'normal'
}

function mapSeverity(server: unknown, percent: number | null, warn: number, lockedReason?: unknown): UsageSeverity {
  if (lockedReason) return 'locked'
  const s = String(server ?? '').toLowerCase()
  if (s === 'locked' || s === 'exceeded') return 'locked'
  if (s === 'critical' || s === 'error') return 'critical'
  if (s === 'warning' || s === 'warn') return 'warning'
  const computed = severityFor(percent, warn)
  return s === 'normal' && computed === 'normal' ? 'normal' : computed
}

function parseTs(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function eventKey(type: string | undefined): string | null {
  switch (type) {
    case 'five_hour': return 'session'
    case 'seven_day': return 'weekly_all'
    case 'seven_day_opus': return 'model:Opus'
    case 'seven_day_sonnet': return 'model:Sonnet'
    case 'seven_day_overage_included': return 'other:overage_included'
    case 'overage': return 'credits'
    case undefined: return null
    default: return `other:${type}`
  }
}

function labelFor(key: string): string {
  if (key === 'session') return 'Session (5h)'
  if (key === 'weekly_all') return 'Weekly (all models)'
  if (key === 'credits') return 'Extra usage credits'
  if (key.startsWith('model:')) return `Weekly ${key.slice(6)}`
  return humanize(key.replace(/^other:/, ''))
}

function groupFor(key: string): UsageWindow['group'] {
  if (key === 'session') return 'session'
  if (key === 'weekly_all') return 'weekly'
  if (key === 'credits') return 'monthly'
  if (key.startsWith('model:')) return 'model'
  return 'other'
}

function money(m: unknown): string | undefined {
  const o = m as { amount_minor?: number; exponent?: number; currency?: string } | null
  if (!o || typeof o.amount_minor !== 'number') return undefined
  const exp = typeof o.exponent === 'number' ? o.exponent : 2
  return `${(o.amount_minor / Math.pow(10, exp)).toFixed(exp)} ${o.currency ?? ''}`.trim()
}

type Win = { utilization?: number | null; resets_at?: string | null; locked_reason?: unknown } | null | undefined

function fixedWindows(json: Record<string, unknown>, warn: number, now: number): UsageWindow[] {
  const out: UsageWindow[] = []
  const fixed: [string, string, string, UsageWindow['group']][] = [
    ['five_hour', 'session', 'Session (5h)', 'session'],
    ['seven_day', 'weekly_all', 'Weekly (all models)', 'weekly'],
    ['seven_day_opus', 'model:Opus', 'Weekly Opus', 'model'],
    ['seven_day_sonnet', 'model:Sonnet', 'Weekly Sonnet', 'model'],
    ['seven_day_oauth_apps', 'other:oauth_apps', 'Weekly (connected apps)', 'other']
  ]
  for (const [field, key, label, group] of fixed) {
    const v = json[field] as Win
    if (!v) continue
    const percent = typeof v.utilization === 'number' ? Math.round(v.utilization) : null
    out.push({ key, label, group, percent, severity: mapSeverity(undefined, percent, warn, v.locked_reason), resetsAt: parseTs(v.resets_at), updatedAt: now })
  }
  const scoped = json.model_scoped as { display_name?: string; utilization?: number | null; resets_at?: string | null }[] | undefined
  if (Array.isArray(scoped)) {
    for (const m of scoped) {
      const name = m.display_name || 'model'
      const percent = typeof m.utilization === 'number' ? Math.round(m.utilization) : null
      out.push({ key: `model:${name}`, label: `Weekly ${name}`, group: 'model', percent, severity: severityFor(percent, warn), resetsAt: parseTs(m.resets_at), updatedAt: now })
    }
  }
  return out
}

function creditsWindow(json: Record<string, unknown>, warn: number, now: number): UsageWindow | null {
  const spend = json.spend as { enabled?: boolean; percent?: number; used?: unknown; limit?: unknown; severity?: unknown } | undefined
  if (spend && spend.enabled) {
    const used = money(spend.used)
    const limit = money(spend.limit)
    const percent = typeof spend.percent === 'number' ? spend.percent : null
    return { key: 'credits', label: 'Extra usage credits', group: 'monthly', percent, severity: mapSeverity(spend.severity, percent, warn), detail: used && limit ? `${used} of ${limit}` : used, updatedAt: now }
  }
  const extra = json.extra_usage as { is_enabled?: boolean; monthly_limit?: number | null; used_credits?: number | null; utilization?: number | null; currency?: string | null } | undefined
  if (extra?.is_enabled) {
    const percent = typeof extra.utilization === 'number' ? Math.round(extra.utilization) : null
    const detail = extra.used_credits != null && extra.monthly_limit != null ? `${extra.used_credits} / ${extra.monthly_limit} ${extra.currency ?? ''}`.trim() : undefined
    return { key: 'credits', label: 'Extra usage (monthly)', group: 'monthly', percent, severity: severityFor(percent, warn), detail, updatedAt: now }
  }
  return null
}

/** Shape returned by the claude.ai usage endpoint (mirrors what the CLI's /usage dialog renders). */
export function normalizeEndpoint(json: Record<string, unknown>, warn: number): UsageWindow[] {
  const now = Date.now()
  let out: UsageWindow[] = []
  const limits = json.limits as { kind?: string; percent?: number; severity?: unknown; resets_at?: string; is_active?: boolean; scope?: { model?: { display_name?: string }; surface?: { display_name?: string } | string }; locked_reason?: unknown }[] | undefined
  if (Array.isArray(limits) && limits.length) {
    for (const l of limits) {
      const kind = String(l.kind ?? '')
      const scopeModel = l.scope?.model?.display_name
      const surface = typeof l.scope?.surface === 'string' ? l.scope.surface : l.scope?.surface?.display_name
      let key: string
      let label: string
      let group: UsageWindow['group']
      if (kind === 'session') {
        key = 'session'
        label = 'Session (5h)'
        group = 'session'
      } else if (kind === 'weekly_all') {
        key = 'weekly_all'
        label = 'Weekly (all models)'
        group = 'weekly'
      } else if (kind === 'weekly_scoped') {
        const name = scopeModel || surface || 'scoped'
        key = `model:${name}`
        label = `Weekly ${name}`
        group = scopeModel ? 'model' : 'other'
      } else {
        key = `other:${kind}${scopeModel ? ':' + scopeModel : ''}`
        label = humanize(kind) + (scopeModel ? ` ${scopeModel}` : '')
        group = 'other'
      }
      const percent = typeof l.percent === 'number' ? l.percent : null
      out.push({ key, label, group, percent, severity: mapSeverity(l.severity, percent, warn, l.locked_reason), resetsAt: parseTs(l.resets_at), isActive: Boolean(l.is_active), updatedAt: now })
    }
  } else out = fixedWindows(json, warn, now)
  const credits = creditsWindow(json, warn, now)
  if (credits) out.push(credits)
  return sortWindows(out)
}

/** Shape of `rate_limits` in the SDK's structured /usage response. */
export function normalizeSdk(rateLimits: Record<string, unknown>, warn: number): UsageWindow[] {
  const now = Date.now()
  const out = fixedWindows(rateLimits, warn, now)
  const credits = creditsWindow(rateLimits, warn, now)
  if (credits) out.push(credits)
  return sortWindows(out)
}
