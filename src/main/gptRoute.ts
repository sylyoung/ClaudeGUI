import fs from 'fs'
import { captureLauncher } from './env'

/**
 * The network route the GPT chats take.
 *
 * A GPT chat reaches chatgpt.com through the local bridge, and the bridge sends its traffic through
 * the proxy its launcher (`cc-gpt`) started it with — 127.0.0.1:8118, the MonoCloud desktop app,
 * while the plain Claude wrapper uses 127.0.0.1:18118, the Docker container. The two are different
 * proxies that can fail independently, so a request meant for the ChatGPT subscription has to read
 * this route rather than the shell's environment: a check taken over the shell's proxy (the Claude
 * path) failed whenever the Docker container was down, even while the GPT chats were fine.
 *
 * The route is what the launcher exported the last time the session host ran it, which the host
 * keeps in provider-cache.json next to the settings. `refresh()` runs the launcher once to learn
 * the current route, for when it was changed after that run or the proxy it names has gone away.
 */
export interface GptRouteDeps {
  /** provider-cache.json, written by the session host every time a launcher runs. */
  stateFile: string
  /** The Codex provider's launcher ("cc-gpt"), or null when that setting is gone. */
  launcher(): string | null
  log(...args: unknown[]): void
}

export class GptRoute {
  constructor(private deps: GptRouteDeps) {}

  /** The environment of the launcher's last run, or null when there is none to use. */
  remembered(): Record<string, string> | null {
    const launcher = this.deps.launcher()
    if (!launcher) return null
    try {
      const doc = JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf8')) as {
        captures?: Record<string, { env?: Record<string, string> }>
      }
      const env = doc.captures?.[launcher]?.env
      // A saved capture without ANTHROPIC_BASE_URL is not a launcher run that got as far as
      // pointing Claude Code anywhere, so there is no route in it to trust.
      return env && env.ANTHROPIC_BASE_URL ? env : null
    } catch {
      return null
    }
  }

  /** Run the launcher now and return the route it gives; null when it refuses to start. */
  async refresh(): Promise<Record<string, string> | null> {
    const launcher = this.deps.launcher()
    if (!launcher) return null
    const capture = await captureLauncher(launcher).catch(() => null)
    const env = capture?.env
    if (!env?.ANTHROPIC_BASE_URL) {
      this.deps.log(`[usage] chatgpt: ${launcher} did not start, so its route could not be read`)
      return null
    }
    this.deps.log(`[usage] chatgpt: ${launcher} now routes through ${proxyOf(env) ?? 'no proxy (direct)'}`)
    return env
  }
}

/**
 * The proxy an environment names, for a log line or a message to the user. Only ever a local URL:
 * the launchers' secrets (tokens, keys) live in other variables and are never read here.
 */
export function proxyOf(env: Record<string, string>): string | null {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = env[key]
    if (value) return value
  }
  return null
}
