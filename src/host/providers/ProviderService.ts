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
}

interface Deps {
  getSettings(): AppSettings
  log(...args: unknown[]): void
}

/** How long a model list and a launcher's environment are reused before being read again. */
const CACHE_MS = 10 * 60_000
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
    let capture: LauncherCapture
    try {
      capture = await this.capture(p.launcher, refresh)
    } catch (err) {
      return { ...base, reason: (err as Error).message }
    }
    const defaultModel = capture.env.ANTHROPIC_MODEL || undefined
    const listed = await this.modelsFor(p, capture, refresh)
    const models = [...listed.models]
    if (defaultModel && !models.some((m) => m.value === defaultModel)) {
      models.unshift({ value: defaultModel, label: `${defaultModel} (what ${p.launcher} uses by itself)` })
    }
    return { ...base, available: true, reason: listed.error, models, defaultModel }
  }

  /** Run the launcher (or reuse a recent run) and check that it really points Claude Code elsewhere. */
  private async capture(launcher: string, refresh: boolean): Promise<LauncherCapture> {
    const cached = this.captures.get(launcher)
    if (cached && !refresh && Date.now() - cached.at < CACHE_MS) return cached.capture
    const capture = await captureLauncher(launcher)
    const name = launcher.split(/\s+/)[0]
    if (!capture.env.ANTHROPIC_BASE_URL) {
      const err = lastLine(capture.stderr)
      if (/command not found|not found/i.test(err)) throw new Error(`"${name}" is not defined in your shell (looked for it in the login shell, where ~/.zshrc is read).`)
      throw new Error(err ? `${name} did not start: ${err}` : `${name} ran but did not set ANTHROPIC_BASE_URL, so it would not point Claude Code at another provider.`)
    }
    this.captures.set(launcher, { at: Date.now(), capture })
    return capture
  }

  /** The provider's own model list, cached; on failure the last list or none, with the error. */
  private async modelsFor(p: ModelProviderSetting, capture: LauncherCapture, refresh: boolean): Promise<{ models: ProviderModelView[]; error?: string }> {
    const cached = this.models.get(p.id)
    if (cached && !refresh && Date.now() - cached.at < CACHE_MS) return cached
    const url = p.modelsUrl.trim() || `${capture.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')}/v1/models`
    const suffix = /\[1m\]$/.test(capture.env.ANTHROPIC_MODEL ?? '') ? '[1m]' : ''
    let entry: { at: number; models: ProviderModelView[]; error?: string }
    try {
      const ids = await fetchModelIds(url, capture.env)
      const models = p.id === 'codex' ? codexModels(ids, suffix, this.deps.log) : ids.map((m) => ({ value: m.id + suffix, label: m.label ?? m.id }))
      entry = { at: Date.now(), models }
    } catch (err) {
      entry = { at: Date.now(), models: cached?.models ?? [], error: `Model list not read from ${url}: ${(err as Error).message}` }
      this.deps.log(`[providers] ${p.id}: ${entry.error}`)
    }
    this.models.set(p.id, entry)
    return entry
  }

  /** Environment and options for a chat on this provider, from a fresh run of its launcher. */
  async launch(providerId: string, model?: string): Promise<ProviderLaunch> {
    const p = this.setting(providerId)
    if (!p) throw new Error(`Provider "${providerId}" is not in Settings (Claude tab, other model providers).`)
    if (!p.enabled) throw new Error(`Provider "${p.name}" is switched off in Settings (Claude tab).`)
    // Always run the launcher: it is what starts the bridge and checks the route, as in the terminal.
    const capture = await this.capture(p.launcher, true)
    const chosen = model || capture.env.ANTHROPIC_MODEL || ''
    if (!chosen) throw new Error(`${p.launcher} sets no model and the chat has none.`)
    const env = mergeSpawnEnv(capture.env, parseExtraEnv(this.deps.getSettings().extraEnv))
    env.ANTHROPIC_MODEL = chosen
    const launch: ProviderLaunch = { env, model: chosen, disallowedTools: [], extraArgs: {} }
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

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
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
 * so a bridge that needs updating is visible rather than silently missing models.
 */
function codexModels(bridge: { id: string; label?: string }[], suffix: string, log: (...a: unknown[]) => void): ProviderModelView[] {
  const known = new Set(bridge.map((m) => m.id))
  const out: ProviderModelView[] = []
  const seen = new Set<string>()
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
  for (const m of current) {
    const efforts = m.supported_reasoning_levels?.map((l) => l.effort).filter((e): e is EffortLevel => EFFORTS.includes(e as EffortLevel))
    const name = m.display_name ?? m.slug
    for (const [id, label] of [[m.slug, name], [`${m.slug}-fast`, `${name} (fast)`]] as const) {
      if (id.endsWith('-fast') && !known.has(id)) continue
      seen.add(id)
      out.push({
        value: id + suffix,
        label,
        supportedEffortLevels: efforts?.length ? efforts : undefined,
        unavailable: known.has(id) ? undefined : 'Your Codex subscription offers this model, but the bridge (claude-code-proxy) does not know it yet; update the bridge to use it.'
      })
    }
  }
  for (const m of bridge) {
    if (seen.has(m.id) || !/^gpt-/.test(m.id)) continue
    out.push({ value: m.id + suffix, label: m.label?.replace(/ \(codex\)$/, '') ?? m.id })
  }
  return out
}
