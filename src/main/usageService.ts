import { spawn } from 'child_process'
import type { AuthState, ChatGptLoginState, SdkUsage, UsageProviderId, UsageSeverity, UsageSnapshot, UsageState, UsageWindow } from '@shared/types'
import { emptyUsageSnapshot } from '@shared/defaults'
import { readStoredLogin } from './claudeLogin'
import { codexAuthFile, readCodexLogin, renewCodexLogin, type CodexLogin } from './codexLogin'
import { readBridgeLogin, signInBridge } from './gptBridge'
import { proxyOf } from './gptRoute'

/**
 * Tracks the plan rate-limit windows of both subscriptions the app can use.
 *
 * Claude: the same usage endpoint the CLI's /usage command reads, called with the OAuth token Claude
 * Code stored at login (macOS Keychain or ~/.claude/.credentials.json). Fallbacks: the structured
 * usage of an already running session, and the rate-limit events every API response carries.
 *
 * ChatGPT: the usage endpoint the Codex CLI itself reads, called with the token Codex keeps in
 * ~/.codex/auth.json. GPT traffic leaves through the bridge's upstream proxy, not through the
 * shell's own one — those are different proxies (the desktop app versus the Docker container) and
 * they fail separately — so this request is given the Codex launcher's environment (see gptRoute).
 *
 * Requests go through `curl` so the proxy variables of the environment they are given apply. Both
 * subscriptions are read on every check, so the switch between them costs nothing.
 */

export interface UsageDeps {
  getEnv(): Promise<Record<string, string>>
  /** The route the GPT chats take (the Codex launcher's environment), or null while unknown. */
  gptRoute(): Record<string, string> | null
  /**
   * Run the Codex launcher once to learn the current GPT route; null when it refuses to start.
   * Only for an explicit check: it runs the user's own launcher, which starts its bridge.
   */
  refreshGptRoute(): Promise<Record<string, string> | null>
  getSettings(): { usageRefreshMinutes: number; usageWarnPercent: number }
  /** Plan limits through an already-running Claude session, or null when none is alive. */
  sessionUsage(): Promise<SdkUsage | null>
  /** Whether Claude Code is signed in, to say truthfully why no plan limits can be read. */
  checkAuth(): Promise<AuthState>
  emit(state: UsageState): void
  log(...args: unknown[]): void
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
/**
 * How early the Codex login is renewed. Its token lives ten days and the app is often the only
 * thing that touches it, so renewing a day ahead is what keeps it from lapsing between two uses.
 */
const RENEW_BEFORE_MS = 24 * 60 * 60_000
/** The bridge's own login is read by running it, so not on every check. */
const BRIDGE_CHECK_MS = 10 * 60_000
/** Do not hammer the endpoint when many turns finish at once. */
const MIN_INTERVAL_MS = 20_000

export class UsageService {
  private snapshots: Record<UsageProviderId, UsageSnapshot> = { claude: emptyUsageSnapshot(), codex: emptyUsageSnapshot() }
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<UsageState> | null = null
  /** The two logins the GPT chats depend on, as last read. */
  private chatgpt: ChatGptLoginState = { codex: { present: false }, bridge: {} }
  private bridgeReadAt = 0
  private renewing: Promise<CodexLogin | null> | null = null

  constructor(private deps: UsageDeps) {}

  /** Both subscriptions, for the top-right pills and the details popover. */
  state(): UsageState {
    return {
      providers: [
        { id: 'claude', label: 'Claude', snapshot: this.snapshots.claude },
        { id: 'codex', label: 'ChatGPT', snapshot: this.snapshots.codex }
      ],
      chatgpt: this.chatgpt
    }
  }

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

  private emitState(): void {
    this.deps.emit(this.state())
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const minutes = Math.max(1, Number(this.deps.getSettings().usageRefreshMinutes) || 5)
    const ms = minutes * 60_000
    const nextCheckAt = Date.now() + ms
    this.snapshots = {
      claude: { ...this.snapshots.claude, nextCheckAt },
      codex: { ...this.snapshots.codex, nextCheckAt }
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh('timer')
    }, ms)
    this.timer.unref?.()
  }

  /** Refresh unless a check happened very recently (called after every finished turn). */
  refreshSoon(reason: string): void {
    if (Date.now() - this.snapshots.claude.fetchedAt < MIN_INTERVAL_MS) return
    void this.refresh(reason)
  }

  refresh(reason: string): Promise<UsageState> {
    if (this.inflight) return this.inflight
    this.inflight = this.doRefresh(reason).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doRefresh(reason: string): Promise<UsageState> {
    this.snapshots = {
      claude: { ...this.snapshots.claude, checking: true },
      codex: { ...this.snapshots.codex, checking: true }
    }
    this.emitState()
    const warn = Number(this.deps.getSettings().usageWarnPercent) || 50
    const [claude, codex] = await Promise.all([
      this.readClaude(warn).catch((err) => ({ ...this.snapshots.claude, error: (err as Error).message })),
      this.readCodex(warn, { refreshRoute: reason === 'manual' }).catch((err) => ({ ...this.snapshots.codex, error: (err as Error).message }))
    ])
    this.snapshots = { claude: { ...claude, checking: false }, codex: { ...codex, checking: false } }
    const describe = (s: UsageSnapshot): string =>
      s.error ? `error: ${s.error}` : `${s.source}: ${s.windows.map((w) => `${w.label}=${w.percent ?? '?'}%`).join(', ') || 'no windows'}`
    this.deps.log(`[usage] refreshed (${reason}) — Claude ${describe(this.snapshots.claude)} · ChatGPT ${describe(this.snapshots.codex)}`)
    this.schedule()
    this.emitState()
    return this.state()
  }

  // ------------------------------------------------------------- claude.ai

  private async readClaude(warn: number): Promise<UsageSnapshot> {
    const prev = this.snapshots.claude
    let next: UsageSnapshot | null = null
    let error: string | undefined
    const env = await this.deps.getEnv()
    const login = await readStoredLogin()
    if (login) {
      const res = await curlJson(USAGE_URL, [`Authorization: Bearer ${login.accessToken}`, 'anthropic-beta: oauth-2025-04-20', 'Accept: application/json', 'User-Agent: ClaudeGUI'], env)
      if (res.status === 200 && res.json) {
        next = { fetchedAt: Date.now(), source: 'endpoint', windows: normalizeEndpoint(res.json as Record<string, unknown>, warn), subscription: login.subscription ?? prev.subscription }
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
        next = { fetchedAt: Date.now(), source: 'session', windows: normalizeSdk(viaSession.rate_limits, warn), subscription: viaSession.subscription_type ?? prev.subscription }
        error = undefined
      }
    }
    if (error) this.deps.log(`[usage] claude check failed: ${error}`)
    return next ? { ...next, error: undefined } : { ...prev, error }
  }

  // --------------------------------------------------------------- chatgpt

  /** The GPT route (the launcher's proxy) laid over the shell environment, which is Claude's path. */
  private async codexEnv(): Promise<Record<string, string>> {
    const shell = await this.deps.getEnv()
    const via = this.deps.gptRoute()
    return via ? { ...shell, ...via } : shell
  }

  private async readCodex(warn: number, opts: { refreshRoute: boolean }): Promise<UsageSnapshot> {
    const prev = this.snapshots.codex
    let login = readCodexLogin()
    this.noteCodexLogin(login)
    if (!login) {
      return { ...prev, error: `The Codex CLI has no login stored here (${codexAuthFile()}), so the ChatGPT plan limits cannot be read. Run "codex login" to add one.` }
    }
    // Renewed before it can lapse, not after: the token lives ten days, and a day's margin means a
    // stretch without the CLI never ends in ChatGPT refusing it.
    if (login.expiresAt && login.expiresAt - Date.now() < RENEW_BEFORE_MS) login = (await this.renewCodexLogin('it expires soon')) ?? login
    // The launcher may have moved to another proxy since the host last ran it, so an explicit check
    // that fails at the network level runs it once and tries again with what it sets.
    const shell = await this.deps.getEnv()
    let via = this.deps.gptRoute()
    let env = via ? { ...shell, ...via } : shell
    let res = await this.askCodexUsage(login, env)
    if (res.status === 0 && opts.refreshRoute) {
      via = await this.deps.refreshGptRoute()
      if (via) {
        env = { ...shell, ...via }
        res = await this.askCodexUsage(login, env)
      }
    }
    // A refused token is renewed once and the question asked again, which is the whole point of
    // holding the refresh token: the user sees neither the refusal nor a sign-in prompt.
    if (res.status === 401 || res.status === 403) {
      const renewed = await this.renewCodexLogin(`ChatGPT refused it (HTTP ${res.status})`)
      if (renewed) {
        login = renewed
        res = await this.askCodexUsage(login, env)
      }
    }
    void this.readBridge(env)
    if (res.status === 200 && res.json) {
      const json = res.json as Record<string, unknown>
      return {
        fetchedAt: Date.now(),
        source: 'endpoint',
        windows: normalizeCodex(json, warn),
        subscription: typeof json.plan_type === 'string' ? json.plan_type : prev.subscription
      }
    }
    if (res.status === 401 || res.status === 403) {
      const why = this.chatgpt.codex.error
      return { ...prev, error: `ChatGPT did not accept the stored Codex login (HTTP ${res.status}) and renewing it did not help${why ? `: ${why}` : ''}. Run "codex login" again.` }
    }
    if (res.status === 0) {
      const proxy = proxyOf(env)
      return {
        ...prev,
        error: proxy
          ? `The ChatGPT usage endpoint could not be reached through ${proxy}, the route the GPT chats take. Check that this proxy is running.`
          : 'The ChatGPT usage endpoint could not be reached, and the GPT chats here take no proxy: the request went out directly, which ChatGPT refuses from this network.'
      }
    }
    return { ...prev, error: `ChatGPT's usage endpoint returned HTTP ${res.status}.` }
  }

  private askCodexUsage(login: CodexLogin, env: Record<string, string>): Promise<{ status: number; json: unknown }> {
    const headers = [
      `Authorization: Bearer ${login.accessToken}`,
      'Accept: application/json',
      'User-Agent: codex_cli_rs/0.1.0',
      'originator: codex_cli_rs'
    ]
    if (login.accountId) headers.push(`chatgpt-account-id: ${login.accountId}`)
    return curlJson(CODEX_USAGE_URL, headers, env, { forceProxy: true })
  }

  private noteCodexLogin(login: CodexLogin | null, patch: Partial<ChatGptLoginState['codex']> = {}): void {
    this.chatgpt = {
      ...this.chatgpt,
      codex: { present: !!login, expiresAt: login?.expiresAt, lastRefresh: login?.lastRefresh, ...patch }
    }
  }

  /**
   * Renew the stored Codex login. One at a time, and through the GPT route: auth.openai.com is
   * reached the same way chatgpt.com is. Returns null when it could not be done, with the reason
   * kept for the window.
   */
  private renewCodexLogin(why: string): Promise<CodexLogin | null> {
    if (this.renewing) return this.renewing
    this.noteCodexLogin(readCodexLogin(), { renewing: true })
    this.emitState()
    this.renewing = (async () => {
      const env = await this.codexEnv()
      try {
        const login = await renewCodexLogin((url, body) =>
          curlJson(url, ['Content-Type: application/json', 'Accept: application/json', 'User-Agent: codex_cli_rs/0.1.0'], env, { forceProxy: true, body })
        )
        this.noteCodexLogin(login, { renewing: false, error: undefined })
        this.deps.log(`[usage] chatgpt: the Codex login was renewed (${why}); it now runs to ${new Date(login.expiresAt ?? 0).toISOString()}`)
        return login
      } catch (err) {
        const message = (err as Error).message
        this.noteCodexLogin(readCodexLogin(), { renewing: false, error: message })
        this.deps.log(`[usage] chatgpt: the Codex login could not be renewed (${why}): ${message}`)
        return null
      } finally {
        this.renewing = null
        this.emitState()
      }
    })()
    return this.renewing
  }

  /** Read the bridge's own login now and then; it costs a process, so not on every check. */
  private async readBridge(env: Record<string, string>): Promise<void> {
    if (Date.now() - this.bridgeReadAt < BRIDGE_CHECK_MS) return
    this.bridgeReadAt = Date.now()
    const base = env.ANTHROPIC_BASE_URL
    const bridge = await readBridgeLogin(base, env).catch((err) => ({ error: (err as Error).message }))
    this.chatgpt = { ...this.chatgpt, bridge: { ...bridge, signingIn: this.chatgpt.bridge.signingIn } }
    this.emitState()
  }

  /** The button in the window: renew the Codex login now and read the limits again. */
  async renewChatGpt(): Promise<UsageState> {
    const login = await this.renewCodexLogin('you asked for it')
    if (!login) return this.state()
    return this.refresh('login renewed')
  }

  /** The other button: the bridge's own browser sign-in, for when it can no longer renew itself. */
  async signInGptBridge(): Promise<{ message: string }> {
    const env = await this.codexEnv()
    this.chatgpt = { ...this.chatgpt, bridge: { ...this.chatgpt.bridge, signingIn: true } }
    this.emitState()
    try {
      const { path: file, message } = await signInBridge(env.ANTHROPIC_BASE_URL, env)
      this.deps.log(`[usage] chatgpt: the bridge's own sign-in was started (${file})`)
      // Its answer arrives in the browser, so the expiry is worth reading again shortly after.
      this.bridgeReadAt = 0
      return { message }
    } finally {
      this.chatgpt = { ...this.chatgpt, bridge: { ...this.chatgpt.bridge, signingIn: false } }
      this.emitState()
    }
  }

  /** Merge a rate_limit_event that a Claude session received with its API response. */
  applyRateLimitEvent(info: { rateLimitType?: string; utilization?: number; resetsAt?: number; status?: string }, ts: number): void {
    const key = eventKey(info.rateLimitType)
    if (!key || info.utilization == null) return
    const warn = Number(this.deps.getSettings().usageWarnPercent) || 50
    const percent = info.utilization <= 1 ? Math.round(info.utilization * 100) : Math.round(info.utilization)
    const prev = this.snapshots.claude
    const windows = prev.windows.slice()
    const idx = windows.findIndex((w) => w.key === key)
    const base: UsageWindow = idx >= 0 ? windows[idx] : { key, label: labelFor(key), group: groupFor(key), percent: null, severity: 'unknown', updatedAt: 0 }
    const severity: UsageSeverity = info.status === 'rejected' ? 'critical' : info.status === 'allowed_warning' ? 'warning' : severityFor(percent, warn)
    const w: UsageWindow = { ...base, percent, severity, resetsAt: info.resetsAt ? info.resetsAt * 1000 : base.resetsAt, updatedAt: ts }
    if (idx >= 0) windows[idx] = w
    else windows.push(w)
    this.snapshots = { ...this.snapshots, claude: { ...prev, windows: sortWindows(windows), source: prev.source === 'none' ? 'event' : prev.source } }
    this.emitState()
  }
}

// ---------------------------------------------------------------- credentials

// ---------------------------------------------------------------- endpoint

/**
 * Fetch a JSON document with curl (honours the proxy variables of the captured shell environment).
 * With `body` the request is a POST carrying it, which is how a login is renewed.
 *
 * `forceProxy` is for the ChatGPT endpoints: curl lets NO_PROXY override a proxy, so an environment
 * carrying `NO_PROXY=*` would send the request out directly, and ChatGPT refuses a direct source.
 * When the environment does configure a proxy, this pins curl to it.
 */
function curlJson(
  url: string,
  headers: string[],
  env: Record<string, string>,
  opts: { forceProxy?: boolean; body?: string } = {}
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((k) => env[k])
    // The token travels in a config document on stdin so it never appears in the process list.
    let config = headers.map((h) => `header = ${JSON.stringify(h)}`).join('\n') + `\nurl = ${JSON.stringify(url)}\n`
    // Same reason the tokens go here: a refresh token would otherwise be visible in the arguments.
    if (opts.body) config += `data = ${JSON.stringify(opts.body)}\n`
    if (opts.forceProxy && hasProxy) config += 'noproxy = ""\n'
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

// ------------------------------------------------------------ chatgpt shape

/** A window as ChatGPT reports it: percentages 0-100 and either an absolute or a relative reset. */
interface CodexWindow {
  used_percent?: number | null
  limit_window_seconds?: number | null
  reset_after_seconds?: number | null
  reset_at?: number | null
}

interface CodexRateLimit {
  allowed?: boolean
  limit_reached?: boolean
  primary_window?: CodexWindow | null
  secondary_window?: CodexWindow | null
}

/**
 * Codex names its windows by length rather than by kind, so the length decides the name: 5 hours is
 * the session limit, a week is the weekly one. Anything else keeps its length in hours and is shown
 * only in the details, like the per-model extras ("GPT-5.3-Codex-Spark", "gpt-reserve").
 */
const WINDOW_NAMES: [seconds: number, label: string, group: UsageWindow['group']][] = [
  [5 * 3600, 'Session (5h)', 'session'],
  [7 * 86400, 'Weekly', 'weekly'],
  [30 * 86400, 'Monthly', 'monthly']
]

function windowName(seconds: number | null | undefined): { label: string; group: UsageWindow['group'] } {
  if (typeof seconds !== 'number' || seconds <= 0) return { label: 'Limit', group: 'other' }
  const hit = WINDOW_NAMES.find(([len]) => Math.abs(len - seconds) <= 60)
  if (hit) return { label: hit[1], group: hit[2] }
  return { label: `Window (${Math.round(seconds / 3600)}h)`, group: 'other' }
}

function codexWindow(
  key: string,
  label: string,
  group: UsageWindow['group'],
  w: CodexWindow,
  rl: CodexRateLimit,
  warn: number,
  now: number
): UsageWindow {
  const percent = typeof w.used_percent === 'number' ? Math.round(w.used_percent) : null
  const resetsAt =
    typeof w.reset_at === 'number' && w.reset_at > 0
      ? w.reset_at * 1000
      : typeof w.reset_after_seconds === 'number' && w.reset_after_seconds > 0
        ? now + w.reset_after_seconds * 1000
        : undefined
  const locked = rl.limit_reached === true || rl.allowed === false
  return { key, label, group, percent, severity: locked ? 'locked' : severityFor(percent, warn), resetsAt, updatedAt: now }
}

/** Shape of GET https://chatgpt.com/backend-api/wham/usage, the document the Codex CLI reads. */
export function normalizeCodex(json: Record<string, unknown>, warn: number): UsageWindow[] {
  const now = Date.now()
  const out: UsageWindow[] = []
  const main = json.rate_limit as CodexRateLimit | undefined
  if (main) {
    for (const [slot, w] of [['primary', main.primary_window], ['secondary', main.secondary_window]] as const) {
      if (!w) continue
      const name = windowName(w.limit_window_seconds)
      out.push(codexWindow(`codex:${slot}`, name.label, name.group, w, main, warn, now))
    }
  }
  const extras = json.additional_rate_limits as { limit_name?: string; metered_feature?: string; rate_limit?: CodexRateLimit }[] | undefined
  if (Array.isArray(extras)) {
    for (const e of extras) {
      if (!e.rate_limit) continue
      const name = e.limit_name || e.metered_feature || 'extra limit'
      for (const [slot, w] of [['primary', e.rate_limit.primary_window], ['secondary', e.rate_limit.secondary_window]] as const) {
        if (!w) continue
        const win = windowName(w.limit_window_seconds)
        out.push(codexWindow(`codex:${name}:${slot}`, `${name} · ${win.label}`, 'other', w, e.rate_limit, warn, now))
      }
    }
  }
  return sortWindows(out)
}
