import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppSettings, EffortLevel, ModelProviderSetting, ProviderModelView, ProviderView } from '@shared/types'
import { captureLauncher, mergeSpawnEnv, parseExtraEnv, type LauncherCapture } from '../../main/env'

/** Everything a Claude process needs to run on another provider. */
export interface ProviderLaunch {
  env: Record<string, string>
  /** Model id to pass to the CLI (the chat's choice, or the launcher's own default). */
  model: string
  /** Effort the launcher would set ("--effort xhigh"); used when the chat has none of its own. */
  effort?: EffortLevel
  /** Tools the launcher removes ("--disallowed-tools=EnterPlanMode"). */
  disallowedTools: string[]
  /** Other CLI flags the launcher passes that the SDK has no option for ("--settings ..."). */
  extraArgs: Record<string, string | null>
  /** Set when the launcher refused now and the last working environment is used instead. */
  warning?: string
}

interface Deps {
  getSettings(): AppSettings
  log(...args: unknown[]): void
  /** File that keeps the last working launcher environment per launcher (tokens included, mode 600). */
  stateFile?: string
}

/** How long a model list and a launcher's environment are reused before being read again. */
const CACHE_MS = 10 * 60_000
/** A launcher environment that worked once is kept this long as a fallback. */
const FALLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Model ids that DeepSeek retired while existing ClaudeGUI sessions could still remember them. */
const RETIRED_MODEL_ALIASES: Record<string, Record<string, string>> = {
  deepseek: { 'deepseek-v4-flash': 'deepseek-flash' }
}

function currentModelId(providerId: string, model: string | undefined): string {
  if (!model) return ''
  return RETIRED_MODEL_ALIASES[providerId]?.[model] ?? model
}

/** What the state file holds: the last environment each launcher handed to the CLI. */
interface SavedCapture {
  at: number
  env: Record<string, string>
  argv: string[]
}

interface CaptureResult {
  capture: LauncherCapture
  /** Set when the launcher refused now and this older capture is used instead. */
  stale?: { at: number; error: string }
}

/**
 * Model providers other than Anthropic (see ModelProviderSetting). Each one is a launcher command
 * from the user's shell; the service runs it to learn the environment it gives Claude Code, asks
 * the provider which models it offers, and prepares the environment a chat on that provider starts
 * with. Nothing here ever logs a token.
 */
export class ProviderService {
  private captures = new Map<string, { at: number; capture: LauncherCapture }>()
  private models = new Map<string, { at: number; models: ProviderModelView[]; error?: string }>()
  private inflight = new Map<string, Promise<ProviderView>>()

  /** The last environment each launcher handed to the CLI, kept across restarts. */
  private saved: Record<string, SavedCapture> | null = null

  constructor(private deps: Deps) {}

  /** Forget everything read from the shell and the providers (Settings: reload). */
  reset(): void {
    this.captures.clear()
    this.models.clear()
  }

  private setting(id: string): ModelProviderSetting | undefined {
    return (this.deps.getSettings().providers ?? []).find((p) => p.id === id)
  }

  /** Every enabled provider with its models; providers are checked in parallel. */
  async list(refresh = false): Promise<ProviderView[]> {
    const enabled = (this.deps.getSettings().providers ?? []).filter((p) => p.enabled && p.launcher.trim())
    return Promise.all(enabled.map((p) => this.view(p, refresh)))
  }

  private view(p: ModelProviderSetting, refresh: boolean): Promise<ProviderView> {
    const key = `${p.id} ${p.launcher}`
    const running = this.inflight.get(key)
    if (running) return running
    const task = this.buildView(p, refresh).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }

  private async buildView(p: ModelProviderSetting, refresh: boolean): Promise<ProviderView> {
    const base: ProviderView = { id: p.id, name: p.name, launcher: p.launcher, available: false, models: [], checkedAt: Date.now() }
    let result: CaptureResult
    let probe: { id: string; label?: string }[] | undefined
    try {
      // The provider answers the model request itself, so a launcher that refuses now only costs
      // the reading of the list from its older environment.
      result = await this.captureOrFallback(p, refresh, (ids) => {
        probe = ids
      })
    } catch (err) {
      return { ...base, reason: (err as Error).message }
    }
    const capture = result.capture
    const defaultModel = currentModelId(p.id, capture.env.ANTHROPIC_MODEL) || undefined
    const listed = await this.modelsFor(p, capture, refresh, probe)
    const models = [...listed.models]
    if (defaultModel && !models.some((m) => m.value === defaultModel)) {
      models.unshift({ value: defaultModel, label: `${defaultModel} (what ${p.launcher} uses by itself)` })
    }
    const reason = [result.stale && staleWarning(p.launcher, result.stale), listed.error].filter(Boolean).join(' ') || undefined
    return { ...base, available: true, reason, models, defaultModel, staleEnv: result.stale ? { at: result.stale.at } : undefined }
  }

  /** Run the launcher (or reuse a recent run) and check that it really points Claude Code elsewhere. */
  private async capture(launcher: string, refresh: boolean): Promise<LauncherCapture> {
    const cached = this.captures.get(launcher)
    if (cached && !refresh && Date.now() - cached.at < CACHE_MS) return cached.capture
    const capture = await captureLauncher(launcher)
    const name = launcher.split(/\s+/)[0]
    if (!capture.env.ANTHROPIC_BASE_URL) {
      const err = launcherMessage(capture.stderr, name)
      if (/command not found|not found/i.test(err)) throw new Error(`"${name}" is not defined in your shell (looked for it in the login shell, where ~/.zshrc is read).`)
      throw new Error(err ? `${name} did not start: ${err}` : `${name} ran but did not set ANTHROPIC_BASE_URL, so it would not point Claude Code at another provider.`)
    }
    this.captures.set(launcher, { at: Date.now(), capture })
    this.remember(launcher, capture)
    return capture
  }

  /**
   * The launcher's environment, or the one it gave on an earlier day when it refuses to start now.
   * A launcher starts its bridge and checks its network route every time it runs, so a broken route
   * (or an expired login) stops the launcher while the bridge it already started keeps answering.
   * In that case the last environment that worked is used, provided the provider still answers with
   * it; the caller is told, so the reason stays visible instead of the provider simply failing.
   */
  private async captureOrFallback(p: ModelProviderSetting, refresh: boolean, onProbe?: (ids: { id: string; label?: string }[]) => void): Promise<CaptureResult> {
    try {
      return { capture: await this.capture(p.launcher, refresh) }
    } catch (err) {
      const message = (err as Error).message
      const saved = this.lastSaved(p.launcher)
      if (!saved) throw err
      const url = modelsUrlFor(p, saved.env)
      let ids: { id: string; label?: string }[]
      try {
        ids = await fetchModelIds(url, saved.env)
      } catch (probeErr) {
        this.deps.log(`[providers] ${p.id}: launcher refused and its settings from ${new Date(saved.at).toISOString()} do not work either (${(probeErr as Error).message})`)
        throw err
      }
      this.deps.log(`[providers] ${p.id}: launcher refused (${message}); using the environment from ${new Date(saved.at).toISOString()} — ${url} answers with it`)
      onProbe?.(ids)
      return { capture: { env: saved.env, argv: saved.argv, stderr: '', exitCode: null }, stale: { at: saved.at, error: message } }
    }
  }

  /** The provider's own model list, cached; on failure the last list or none, with the error. */
  private async modelsFor(p: ModelProviderSetting, capture: LauncherCapture, refresh: boolean, ids?: { id: string; label?: string }[]): Promise<{ models: ProviderModelView[]; error?: string }> {
    const cached = this.models.get(p.id)
    if (cached && !refresh && Date.now() - cached.at < CACHE_MS) return cached
    const url = modelsUrlFor(p, capture.env)
    const suffix = /\[1m\]$/.test(capture.env.ANTHROPIC_MODEL ?? '') ? '[1m]' : ''
    let entry: { at: number; models: ProviderModelView[]; error?: string }
    try {
      const list = ids ?? (await fetchModelIds(url, capture.env))
      const models = isCodexList(p, url, list) ? codexModels(list, suffix, this.deps.log) : list.map((m) => ({ value: m.id + suffix, label: m.label ?? m.id }))
      entry = { at: Date.now(), models }
    } catch (err) {
      entry = { at: Date.now(), models: cached?.models ?? [], error: `Model list not read from ${url}: ${(err as Error).message}` }
      this.deps.log(`[providers] ${p.id}: ${entry.error}`)
    }
    this.models.set(p.id, entry)
    return entry
  }

  /** The last environment that worked for this launcher, if it is not too old. */
  private lastSaved(launcher: string): SavedCapture | undefined {
    const state = this.loadState()
    const entry = state[launcher]
    if (!entry || !entry.env?.ANTHROPIC_BASE_URL) return undefined
    if (Date.now() - entry.at > FALLBACK_MAX_AGE_MS) return undefined
    return entry
  }

  /** Keep the environment of a launcher run that produced one, for the day the launcher refuses. */
  private remember(launcher: string, capture: LauncherCapture): void {
    if (!this.deps.stateFile) return
    try {
      const state = this.loadState()
      state[launcher] = { at: Date.now(), env: capture.env, argv: capture.argv }
      fs.writeFileSync(this.deps.stateFile, JSON.stringify({ captures: state }, null, 1), { mode: 0o600 })
      fs.chmodSync(this.deps.stateFile, 0o600)
    } catch (err) {
      this.deps.log(`[providers] could not keep ${launcher}'s environment: ${(err as Error).message}`)
    }
  }

  private loadState(): Record<string, SavedCapture> {
    if (this.saved) return this.saved
    this.saved = {}
    const file = this.deps.stateFile
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { captures?: Record<string, SavedCapture> }
        for (const [launcher, entry] of Object.entries(parsed.captures ?? {})) {
          if (entry && entry.env && typeof entry.at === 'number') this.saved[launcher] = entry
        }
      } catch (err) {
        this.deps.log(`[providers] ${file} not read: ${(err as Error).message}`)
      }
    }
    return this.saved
  }

  /** Environment and options for a chat on this provider, from a fresh run of its launcher. */
  async launch(providerId: string, model?: string): Promise<ProviderLaunch> {
    const p = this.setting(providerId)
    if (!p) throw new Error(`Provider "${providerId}" is not in Settings (Claude tab, other model providers).`)
    if (!p.enabled) throw new Error(`Provider "${p.name}" is switched off in Settings (Claude tab).`)
    // Always run the launcher: it is what starts the bridge and checks the route, as in the terminal.
    const { capture, stale } = await this.captureOrFallback(p, true)
    const requested = model || capture.env.ANTHROPIC_MODEL || ''
    const chosen = currentModelId(p.id, requested)
    if (!chosen) throw new Error(`${p.launcher} sets no model and the chat has none.`)
    if (chosen !== requested) this.deps.log(`[providers] ${p.id}: remapped retired model ${requested} -> ${chosen}`)
    const env = mergeSpawnEnv(capture.env, parseExtraEnv(this.deps.getSettings().extraEnv))
    env.ANTHROPIC_MODEL = chosen
    const launch: ProviderLaunch = { env, model: chosen, disallowedTools: [], extraArgs: {}, warning: stale ? staleWarning(p.launcher, stale) : undefined }
    const argv = capture.argv
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      const eq = a.indexOf('=')
      const flag = eq > 0 ? a.slice(0, eq) : a
      const value = eq > 0 ? a.slice(eq + 1) : argv[i + 1]
      const consumesNext = eq < 0
      switch (flag) {
        case '--effort':
          if (EFFORTS.includes(value as EffortLevel)) launch.effort = value as EffortLevel
          if (consumesNext) i++
          break
        case '--disallowed-tools':
          launch.disallowedTools.push(...String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean))
          if (consumesNext) i++
          break
        case '--permission-mode':
        case '--dangerously-skip-permissions':
          // The chat's own permission mode applies, as for every other chat.
          if (consumesNext && flag === '--permission-mode') i++
          break
        case '--settings':
          launch.extraArgs.settings = String(value ?? '')
          if (consumesNext) i++
          break
        default:
          this.deps.log(`[providers] ${p.id}: ignoring launcher argument ${a}`)
      }
    }
    return launch
  }
}

/** The launcher's own explanation from its stderr, which is its last line only when it says nothing else. */
function launcherMessage(stderr: string, name: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(\(eval\)|\/.*:\d+:)/.test(l) && !/^command not found/.test(l))
  const own = lines.filter((l) => l.startsWith(`${name}:`))
  const text = (own.length ? own : lines.slice(-2)).join(' ')
  return text.length > 400 ? `${text.slice(0, 397)}...` : text
}

/** What to tell the user when a provider runs on the environment of an earlier launcher run. */
function staleWarning(launcher: string, stale: { at: number; error: string }): string {
  const when = new Date(stale.at).toLocaleString()
  return `"${launcher}" refused just now (${stale.error}); this runs on the settings it produced on ${when}, and the provider answered with them.`
}

/** Where a provider's model list comes from: its own URL, or the endpoint of the launcher's base URL. */
function modelsUrlFor(p: ModelProviderSetting, env: Record<string, string>): string {
  return p.modelsUrl.trim() || `${(env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '')}/v1/models`
}

/**
 * Whether this provider is the Codex bridge, whose list needs the subscription's own model list to
 * make sense: it answers with its claude-* aliases (Claude models it can forward) next to the gpt-*
 * ones, so a local endpoint that mixes both is a bridge, whatever the provider is called.
 */
function isCodexList(p: ModelProviderSetting, url: string, ids: { id: string }[]): boolean {
  if (p.id === 'codex') return true
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)
  return loopback && ids.some((m) => /^gpt-/.test(m.id)) && ids.some((m) => /^claude-/.test(m.id))
}

/** GET a models endpoint with the launcher's token, through the proxy the launcher set (none for loopback). */
function fetchModelIds(url: string, env: Record<string, string>): Promise<{ id: string; label?: string }[]> {
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || ''
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)
  const proxy = loopback ? '' : env.HTTPS_PROXY || env.https_proxy || ''
  const args = ['-sS', '-m', '20', '-w', '\n%{http_code}', '-H', `Authorization: Bearer ${token}`, '-H', `x-api-key: ${token}`, url]
  args.unshift(...(proxy ? ['-x', proxy] : ['--noproxy', '*']))
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout || '')
      const cut = out.lastIndexOf('\n')
      const code = cut >= 0 ? out.slice(cut + 1).trim() : ''
      const body = cut >= 0 ? out.slice(0, cut) : out
      if (err && !out) return reject(new Error(err.message.split('\n')[0]))
      if (!/^2\d\d$/.test(code)) return reject(new Error(`HTTP ${code || '000'}`))
      try {
        const parsed = JSON.parse(body) as { data?: unknown[]; models?: unknown[] } | unknown[]
        const list = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.models ?? []
        const ids: { id: string; label?: string }[] = []
        for (const m of list as Record<string, unknown>[]) {
          const id = String(m.id ?? m.slug ?? m.name ?? '')
          if (id) ids.push({ id, label: typeof m.display_name === 'string' ? m.display_name : undefined })
        }
        resolve(ids)
      } catch {
        reject(new Error('the answer was not a model list'))
      }
    })
  })
}

interface CodexCachedModel {
  slug: string
  display_name?: string
  visibility?: string
  supported_reasoning_levels?: { effort: string }[]
  priority?: number
}

/**
 * GPT models for the Codex bridge: what the subscription currently offers (the Codex CLI's own
 * model cache, `~/.codex/models_cache.json`, refreshed whenever Codex runs) matched against what
 * the bridge accepts. A current model the bridge does not know is listed but cannot be chosen,
 * so a bridge that needs updating is visible rather than silently missing models. The bridge also
 * carries older ids (gpt-5.2, gpt-5.3-codex, gpt-5.4...) that a ChatGPT account is refused with
 * ("not supported when using Codex with a ChatGPT account"); they are left out of the list
 * altogether, because a model that cannot be chosen is only something to read past.
 */
function codexModels(bridge: { id: string; label?: string }[], suffix: string, log: (...a: unknown[]) => void): ProviderModelView[] {
  const known = new Set(bridge.map((m) => m.id))
  const out: ProviderModelView[] = []
  let current: CodexCachedModel[] = []
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json')
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: CodexCachedModel[] }
      current = (parsed.models ?? []).filter((m) => m.slug && m.visibility !== 'hide').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    }
  } catch (err) {
    log(`[providers] codex model cache not read: ${(err as Error).message}`)
  }
  if (!current.length) {
    // No list from the subscription to go by: offer what the bridge knows and let the provider answer.
    log('[providers] codex: no model cache to compare with; listing the bridge\'s own models')
    for (const m of bridge) if (/^gpt-/.test(m.id)) out.push({ value: m.id + suffix, label: m.label?.replace(/ \(codex\)$/, '') ?? m.id })
    return out
  }
  for (const m of current) {
    const efforts = m.supported_reasoning_levels?.map((l) => l.effort).filter((e): e is EffortLevel => EFFORTS.includes(e as EffortLevel))
    const name = m.display_name ?? m.slug
    for (const [id, label] of [[m.slug, name], [`${m.slug}-fast`, `${name} (fast)`]] as const) {
      if (id.endsWith('-fast') && !known.has(id)) continue
      out.push({
        value: id + suffix,
        label,
        supportedEffortLevels: efforts?.length ? efforts : undefined,
        unavailable: known.has(id) ? undefined : 'Your Codex subscription offers this model, but the bridge (claude-code-proxy) does not know it yet; update the bridge to use it.'
      })
    }
  }
  return out
}
