/**
 * ClaudeGUI session host.
 *
 * A detached Node process (the app's own Electron binary started with ELECTRON_RUN_AS_NODE) that
 * owns every Claude Code process. The app window connects to it over a Unix socket; when the app
 * restarts — for example to apply an update — the host, the Claude processes and everything they
 * started (background shells, monitors, watchers) keep running and the new window simply
 * reattaches.
 *
 * Arguments: --data <userData dir> --log <file> --version <app version> [--socket <path>]
 * Environment: CLAUDEGUI_HOST_TOKEN (shared secret the client must present in `hello`).
 */
import { randomUUID } from 'crypto'
import fs from 'fs'
import { createRequire } from 'module'
import net from 'net'
import os from 'os'
import path from 'path'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { SessionsStore, SettingsStore } from '../main/store'
import { getLoginShellEnv, getSpawnEnv, parseExtraEnv, resetLoginShellEnvCache } from '../main/env'
import { SessionManager } from './sessions/SessionManager'
import { setToolResultMaxChars } from './sessions/transcript'
import { HOST_PROTOCOL, LineParser, writeFrame, type Frame, type HostEvent, type HostFile, type RequestFrame } from './protocol'

const require = createRequire(import.meta.url)

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i += 1
      } else out[key] = '1'
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dataDir = args.data || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeGUI')
const logFile = args.log || path.join(os.homedir(), 'Library', 'Logs', 'ClaudeGUI', 'session-host.log')
const version = args.version || 'unknown'
const socketPath = args.socket || path.join(dataDir, 'session-host.sock')
const hostFilePath = path.join(dataDir, 'session-host.json')
const token = process.env.CLAUDEGUI_HOST_TOKEN || randomUUID()
const startedAt = Date.now()
delete process.env.CLAUDEGUI_HOST_TOKEN

process.title = 'ClaudeGUI Session Host'
fs.mkdirSync(path.dirname(logFile), { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })

function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
  fs.appendFile(logFile, line + '\n', () => undefined)
}

function sdkVersion(): string {
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'))
    return String(pkg.version)
  } catch {
    return 'unknown'
  }
}

// ------------------------------------------------------------------ state

let settings: AppSettings = { ...DEFAULT_SETTINGS, ...new SettingsStore(dataDir).get() }
let executable: string | undefined
let focused = false
let client: net.Socket | null = null
let stopping = false
let exitTimer: NodeJS.Timeout | null = null
const store = new SessionsStore(dataDir)

function emit(ev: HostEvent): void {
  if (!client) {
    if (ev.e === 'notify') log(`[notify while detached] ${ev.d.title}: ${ev.d.body}`)
    return
  }
  writeFrame(client, { k: 'ev', ...ev })
}

const manager = new SessionManager(store, {
  getEnv: () => getSpawnEnv(parseExtraEnv(settings.extraEnv)),
  getExecutable: () => executable,
  getSettings: () => settings,
  appVersion: version,
  broadcast: (e) => emit({ e: 'session', d: e }),
  notify: (o) => emit({ e: 'notify', d: o }),
  isWindowFocused: () => focused && client !== null,
  updateBadge: (count) => emit({ e: 'badge', d: { count } }),
  onRateLimit: (info, ts) => emit({ e: 'rateLimit', d: { info, ts } }),
  onTurnFinished: () => emit({ e: 'turnFinished', d: {} }),
  log
})

function applySettings(next: AppSettings | undefined, exe: string | undefined): void {
  if (next && typeof next === 'object') settings = { ...DEFAULT_SETTINGS, ...next }
  executable = exe && typeof exe === 'string' ? exe : executable
  setToolResultMaxChars(settings.toolResultMaxChars)
}

// ------------------------------------------------------------------ RPC

async function call(m: string, p: unknown[]): Promise<unknown> {
  const a = p as never[]
  switch (m) {
    case 'ping':
      return 'pong'
    case 'info':
      return { pid: process.pid, version, protocol: HOST_PROTOCOL, startedAt, aliveSessions: manager.aliveCount(), sdkVersion: sdkVersion(), logFile, socketPath }
    case 'list':
      return manager.list()
    case 'history':
      return manager.history(a[0])
    case 'create':
      return manager.create(a[0])
    case 'importCli':
      return manager.importCli(a[0], a[1], a[2])
    case 'listCli':
      return manager.listCli(a[0])
    case 'send':
      return manager.send(a[0], a[1], a[2])
    case 'start':
      return manager.start(a[0])
    case 'stop':
      return manager.stop(a[0])
    case 'interrupt':
      return manager.interrupt(a[0])
    case 'answerPermission':
      return manager.answerPermission(a[0], a[1], a[2])
    case 'setModel':
      return manager.get(a[0]).setModel(a[1])
    case 'setPermissionMode':
      return manager.get(a[0]).setPermissionMode(a[1])
    case 'setEffort':
      return manager.get(a[0]).setEffort(a[1])
    case 'rename':
      return manager.rename(a[0], a[1])
    case 'setPinned':
      return manager.setPinned(a[0], a[1])
    case 'setArchived':
      return manager.setArchived(a[0], a[1])
    case 'remove':
      return manager.remove(a[0], a[1])
    case 'setActive':
      return manager.setActive(a[0] ?? undefined)
    case 'stopTask':
      return manager.get(a[0]).stopTask(a[1])
    case 'backgroundTasks':
      return manager.get(a[0]).backgroundTasks(a[1])
    case 'commands':
      return manager.get(a[0]).getCommands()
    case 'models':
      return manager.get(a[0]).getModels()
    case 'contextUsage':
      return manager.get(a[0]).refreshContextUsage(a[1] ? 'full' : 'summary')
    case 'groups':
      return manager.list().groups
    case 'createGroup':
      return manager.createGroup(a[0], a[1] ?? undefined)
    case 'setGroupColor':
      return manager.setGroupColor(a[0], a[1])
    case 'renameGroup':
      return manager.renameGroup(a[0], a[1])
    case 'deleteGroup':
      return manager.deleteGroup(a[0])
    case 'setGroupCollapsed':
      return manager.setGroupCollapsed(a[0], a[1])
    case 'moveGroup':
      return manager.moveGroup(a[0], a[1] ?? undefined)
    case 'moveSession':
      return manager.moveSession(a[0], a[1] ?? {})
    case 'relocate':
      return manager.relocate(a[0], a[1])
    case 'planUsage':
      return manager.planUsageFromAnySession()
    case 'resumeOnLaunch':
      return manager.resumeOnLaunch()
    case 'aliveCount':
      return manager.aliveCount()
    case 'refreshBadge':
      return manager.refreshBadge()
    case 'setSettings':
      applySettings(a[0], a[1])
      return null
    case 'setFocus':
      focused = Boolean(a[0])
      if (focused) manager.setActive(manager.activeSessionId)
      return null
    case 'reloadEnv': {
      resetLoginShellEnvCache()
      const e = await getLoginShellEnv()
      return Object.keys(e).length
    }
    case 'shutdown':
      setTimeout(() => void shutdown('client request'), 10)
      return null
    default:
      throw new Error(`Unknown host method: ${m}`)
  }
}

async function dispatch(sock: net.Socket, f: RequestFrame): Promise<void> {
  try {
    const v = await call(f.m, Array.isArray(f.p) ? f.p : [])
    writeFrame(sock, { k: 'res', id: f.id, ok: true, v: v === undefined ? null : v })
  } catch (err) {
    writeFrame(sock, { k: 'res', id: f.id, ok: false, e: (err as Error)?.message ?? String(err) })
  }
}

function handleConnection(sock: net.Socket): void {
  let authed = false
  const helloTimer = setTimeout(() => {
    if (!authed) sock.destroy()
  }, 5000)
  const parser = new LineParser(
    (f: Frame) => {
      if (!authed) {
        if (f.k !== 'hello' || f.token !== token) {
          writeFrame(sock, { k: 'error', e: 'unauthorized' })
          sock.destroy()
          return
        }
        authed = true
        clearTimeout(helloTimer)
        if (client && client !== sock) {
          writeFrame(client, { k: 'ev', e: 'replaced', d: {} })
          client.destroy()
        }
        client = sock
        cancelExit()
        applySettings(f.settings, undefined)
        focused = Boolean(f.focused)
        log(`client connected (app ${f.appVersion}, protocol ${f.protocol}); ${manager.aliveCount()} live session(s)`)
        writeFrame(sock, { k: 'welcome', protocol: HOST_PROTOCOL, pid: process.pid, version, startedAt, aliveSessions: manager.aliveCount(), sdkVersion: sdkVersion() })
        return
      }
      if (f.k === 'req') void dispatch(sock, f)
    },
    (line, err) => log(`bad frame (${err.message}): ${line.slice(0, 200)}`)
  )
  sock.setNoDelay(true)
  sock.on('data', (c) => parser.feed(c))
  sock.on('error', (err) => log(`socket error: ${err.message}`))
  sock.on('close', () => {
    clearTimeout(helloTimer)
    if (client === sock) {
      client = null
      focused = false
      const alive = manager.aliveCount()
      log(`client disconnected; ${alive} live session(s)`)
      scheduleExitIfIdle()
    }
  })
}

// ------------------------------------------------------------- lifecycle

function cancelExit(): void {
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
}

/** With no client and no live sessions there is nothing to keep alive. */
function scheduleExitIfIdle(): void {
  cancelExit()
  if (client || manager.aliveCount() > 0) return
  exitTimer = setTimeout(() => {
    if (!client && manager.aliveCount() === 0) void shutdown('idle without client')
  }, 5000)
}

function writeHostFile(): void {
  const data: HostFile = { pid: process.pid, socketPath, token, version, protocol: HOST_PROTOCOL, startedAt, logFile }
  const tmp = hostFilePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, hostFilePath)
}

function cleanupFiles(): void {
  try {
    const cur = JSON.parse(fs.readFileSync(hostFilePath, 'utf8')) as HostFile
    if (cur.pid === process.pid) fs.unlinkSync(hostFilePath)
  } catch {
    /* not ours or already gone */
  }
  try {
    fs.unlinkSync(socketPath)
  } catch {
    /* gone */
  }
}

async function shutdown(reason: string): Promise<void> {
  if (stopping) return
  stopping = true
  log(`shutting down (${reason}); stopping ${manager.aliveCount()} session(s)`)
  emit({ e: 'exiting', d: { reason } })
  try {
    await Promise.race([manager.stopAll(), new Promise((r) => setTimeout(r, 8000))])
  } catch (err) {
    log(`stopAll failed: ${(err as Error).message}`)
  }
  store.flush()
  cleanupFiles()
  server.close()
  client?.destroy()
  log('exited')
  setTimeout(() => process.exit(0), 50)
}

const server = net.createServer(handleConnection)
server.on('error', (err) => {
  log(`server error: ${err.message}`)
  if (!stopping) process.exit(1)
})
try {
  fs.unlinkSync(socketPath)
} catch {
  /* no stale socket */
}
server.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600)
  } catch {
    /* best effort */
  }
  writeHostFile()
  log(`session host ${version} started pid=${process.pid} sdk=${sdkVersion()} data=${dataDir} socket=${socketPath} sessions=${store.listSessions().length}`)
  scheduleExitIfIdle()
})

// Sessions may finish while no client is attached: exit once nothing is left to keep alive.
setInterval(() => {
  if (!client && manager.aliveCount() === 0 && !exitTimer) scheduleExitIfIdle()
}, 10_000).unref()

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => void shutdown(sig))
}
process.on('uncaughtException', (err) => log(`uncaught exception: ${err.stack || err.message}`))
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${(reason as Error)?.stack || String(reason)}`))
