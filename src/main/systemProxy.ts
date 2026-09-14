import { execFile } from 'child_process'
import net from 'net'
import tls from 'tls'

export interface UpdateRoute {
  /** Proxy the update tools should use; '' means a direct connection. */
  proxy: string
  /** True when this differs from the proxy the environment already carried. */
  changed: boolean
  /** Why this route was chosen, for the update log. */
  reason: string
}

/**
 * Which route the update tools should take, given the environment they would inherit.
 *
 * An environment proxy that carries traffic is kept as it is — that is the user's own choice. When
 * there is none, or it cannot carry a connection to GitHub, the macOS system proxy is used instead:
 * it is the route every browser on the machine already takes, and the only one that works where the
 * direct route is blocked. This applies to update child processes only; nothing here changes the
 * app's settings or the route a model provider uses.
 */
export async function chooseUpdateRoute(env: Record<string, string>): Promise<UpdateRoute> {
  const configured = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || ''
  if (configured && (await proxyReachesGitHub(configured))) return { proxy: configured, changed: false, reason: 'from the environment' }
  const system = await systemProxyUrl()
  if (system && system !== configured && (await proxyReachesGitHub(system))) {
    return {
      proxy: system,
      changed: true,
      reason: configured ? `${configured} cannot reach GitHub` : 'no proxy is configured'
    }
  }
  return {
    proxy: configured,
    changed: false,
    reason: configured
      ? `${configured} cannot reach GitHub and the macOS system proxy cannot either`
      : 'no proxy is configured and the macOS system proxy cannot reach GitHub'
  }
}

/**
 * Point the environment at the chosen proxy. `NO_PROXY` may cancel it — a value of "*" (used by some
 * launchers to force their own traffic direct) turns every proxy variable off, and git and curl both
 * honour it — so a "*" entry is dropped here, whatever else the list holds.
 */
export function applyUpdateRoute(env: Record<string, string>, route: UpdateRoute): Record<string, string> {
  if (!route.proxy) return env
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = route.proxy
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const kept = (env[key] ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry && entry !== '*')
    if (kept.length) env[key] = kept.join(',')
    else delete env[key]
  }
  return env
}

/** The macOS system proxy as a URL ("http://127.0.0.1:8118"), or null when none is set. */
export async function systemProxyUrl(): Promise<string | null> {
  const text = await new Promise<string>((resolve) => {
    execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 4000 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout ?? ''))
    })
  })
  return pickProxy(text)
}

/** Read the HTTPS (or HTTP) proxy out of `scutil --proxy` output; exported so it can be checked. */
export function pickProxy(scutilOutput: string): string | null {
  for (const kind of ['HTTPS', 'HTTP']) {
    if (!new RegExp(`${kind}Enable\\s*:\\s*1`).test(scutilOutput)) continue
    const host = field(scutilOutput, `${kind}Proxy`)
    const port = field(scutilOutput, `${kind}Port`)
    if (host && port) return `http://${host}:${port}`
  }
  return null
}

function field(text: string, name: string): string {
  const m = new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, 'm').exec(text)
  return m ? m[1] : ''
}

/**
 * Whether an HTTP proxy can actually carry a connection to GitHub.
 *
 * The tunnel is opened the way git opens it (CONNECT), and then a TLS handshake is completed through
 * it. The handshake is what makes the answer trustworthy: a proxy whose upstream node is gone — a
 * stale container, a stopped app — answers CONNECT with "200 Connection established" and then
 * carries nothing at all, which a check that stops at the CONNECT reply would call healthy.
 */
export function proxyReachesGitHub(proxyUrl: string, host = 'github.com', port = 443, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(proxyUrl)
    } catch {
      return resolve(false)
    }
    if (url.protocol !== 'http:') return resolve(false) // a SOCKS url is not probed here
    let settled = false
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 80) })
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      resolve(ok)
    }
    const deadline = setTimeout(() => finish(false), timeoutMs)
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`))
    let reply = ''
    const onReply = (chunk: Buffer) => {
      reply += chunk.toString('latin1')
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(reply)
      if (!status) return
      if (status[1] !== '200') return finish(false)
      if (!reply.includes('\r\n\r\n')) return
      socket.removeListener('data', onReply)
      const secure = tls.connect({ socket, servername: host }, () => finish(true))
      secure.once('error', () => finish(false))
    }
    socket.on('data', onReply)
  })
}
