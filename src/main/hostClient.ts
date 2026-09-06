/**
 * Client side of the session host: finds a running host (session-host.json in the data folder),
 * otherwise starts one as a detached process, and exposes the session manager's methods over
 * the socket. Events from the host are re-emitted as 'event'.
 */
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import fs from 'fs'
import net from 'net'
import path from 'path'
import type {
  AppSettings,
  ChatMessage,
  CliSessionSummary,
  EffortLevel,
  HostStatus,
  ImageAttachment,
  ModelInfoView,
  PermissionDecision,
  PermissionMode,
  SdkUsage,
  SessionGroup,
  SessionLiveState,
  SessionMove,
  SessionRecord,
  SlashCommandView,
  ContextUsageView
} from '@shared/types'
import { HOST_PROTOCOL, LineParser, writeFrame, type Frame, type HostEvent, type HostFile } from '../host/protocol'

export interface HostClientDeps {
  userDataPath: string
  logFile: string
  hostScript: string
  appVersion: string
  getSettings(): AppSettings
  getExecutable(): string | undefined
  isFocused(): boolean
  log(...args: unknown[]): void
}

export class HostProtocolMismatch extends Error {
  constructor(public hostVersion: string, public hostProtocol: number, public aliveSessions: number) {
    super(`Session host ${hostVersion} speaks protocol ${hostProtocol}, this app needs ${HOST_PROTOCOL}`)
  }
}

const CONNECT_TIMEOUT_MS = 5000
const SPAWN_TIMEOUT_MS = 20_000

export class HostClient extends EventEmitter {
  private sock: net.Socket | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; m: string }>()
  private seq = 0
  private connecting: Promise<void> | null = null
  private detached = false
  status: HostStatus = { connected: false, aliveSessions: 0, stale: false }
  activeSessionId: string | undefined
  private hostFile: HostFile | null = null

  constructor(private deps: HostClientDeps) {
    super()
  }

  get hostFilePath(): string {
    return path.join(this.deps.userDataPath, 'session-host.json')
  }

  get connected(): boolean {
    return this.sock !== null && !this.sock.destroyed
  }

  /** Attach to a running host or start a new one. Safe to call repeatedly. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private readHostFile(): HostFile | null {
    try {
      const hf = JSON.parse(fs.readFileSync(this.hostFilePath, 'utf8')) as HostFile
      if (hf && typeof hf.socketPath === 'string' && typeof hf.token === 'string') return hf
    } catch {
      /* none */
    }
    return null
  }

  private async doConnect(): Promise<void> {
    this.detached = false
    const existing = this.readHostFile()
    if (existing) {
      try {
        await this.attach(existing)
        this.status.origin = 'attached'
        this.deps.log(`[host] attached to session host pid=${existing.pid} version=${existing.version} (${this.status.aliveSessions} live)`)
        return
      } catch (err) {
        if (err instanceof HostProtocolMismatch) throw err
        this.deps.log(`[host] stale host file (${(err as Error).message}); starting a new host`)
      }
    }
    await this.spawnHost()
    this.status.origin = 'spawned'
  }

  private attach(hf: HostFile): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(hf.socketPath)
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        sock.destroy()
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error('timeout waiting for the session host')), CONNECT_TIMEOUT_MS)
      const parser = new LineParser(
        (f: Frame) => {
          if (!settled) {
            if (f.k === 'welcome') {
              if (f.protocol !== HOST_PROTOCOL) {
                clearTimeout(timer)
                settled = true
                sock.destroy()
                reject(new HostProtocolMismatch(f.version, f.protocol, f.aliveSessions))
                return
              }
              settled = true
              clearTimeout(timer)
              this.adopt(sock, parser, hf, f)
              resolve()
              return
            }
            if (f.k === 'error') return fail(new Error(f.e))
            return
          }
          this.onFrame(f)
        },
        (line, err) => this.deps.log(`[host] bad frame (${err.message}): ${line.slice(0, 200)}`)
      )
      sock.setNoDelay(true)
      sock.on('connect', () => {
        writeFrame(sock, {
          k: 'hello',
          token: hf.token,
          protocol: HOST_PROTOCOL,
          appVersion: this.deps.appVersion,
          settings: this.deps.getSettings(),
          focused: this.deps.isFocused()
        })
      })
      sock.on('data', (c) => parser.feed(c))
      sock.on('error', (err) => fail(err))
      sock.on('close', () => fail(new Error('connection closed')))
    })
  }

  private adopt(sock: net.Socket, parser: LineParser, hf: HostFile, welcome: Extract<Frame, { k: 'welcome' }>): void {
    this.sock = sock
    this.hostFile = hf
    this.status = {
      connected: true,
      pid: welcome.pid,
      version: welcome.version,
      protocol: welcome.protocol,
      startedAt: welcome.startedAt,
      socketPath: hf.socketPath,
      logFile: hf.logFile,
      aliveSessions: welcome.aliveSessions,
      stale: welcome.version !== this.deps.appVersion,
      origin: this.status.origin
    }
    sock.removeAllListeners('error')
    sock.removeAllListeners('close')
    sock.on('error', (err) => this.deps.log(`[host] socket error: ${err.message}`))
    sock.on('close', () => {
      if (this.sock !== sock) return
      this.sock = null
      this.status = { ...this.status, connected: false }
      const err = new Error('Session host disconnected')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.emit('disconnected', { detached: this.detached })
    })
    // Push the executable path right away (hello only carries settings).
    void this.call('setSettings', this.deps.getSettings(), this.deps.getExecutable()).catch(() => undefined)
  }

  private onFrame(f: Frame): void {
    if (f.k === 'res') {
      const p = this.pending.get(f.id)
      if (!p) return
      this.pending.delete(f.id)
      if (f.ok) p.resolve(f.v)
      else p.reject(new Error(f.e))
      return
    }
    if (f.k === 'ev') {
      const ev = f as unknown as HostEvent
      if (ev.e === 'replaced') this.deps.log('[host] another app instance took over the session host')
      if (ev.e === 'exiting') this.deps.log(`[host] host exiting: ${ev.d.reason}`)
      this.emit('event', ev)
    }
  }

  private spawnHost(): Promise<void> {
    const token = randomUUID()
    const socketPath = path.join(this.deps.userDataPath, 'session-host.sock')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    env.ELECTRON_RUN_AS_NODE = '1'
    env.CLAUDEGUI_HOST_TOKEN = token
    delete env.ELECTRON_NO_ASAR
    const args = [this.deps.hostScript, '--data', this.deps.userDataPath, '--log', this.deps.logFile, '--version', this.deps.appVersion, '--socket', socketPath]
    this.deps.log(`[host] starting session host: ${process.execPath} ${args.join(' ')}`)
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env, cwd: this.deps.userDataPath })
    let exited: string | null = null
    child.on('exit', (code, signal) => {
      exited = `exited early (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
    })
    child.on('error', (err) => {
      exited = `failed to start: ${err.message}`
    })
    child.unref()
    const pid = child.pid
    const deadline = Date.now() + SPAWN_TIMEOUT_MS
    return new Promise<void>((resolve, reject) => {
      const tick = async () => {
        if (exited) return reject(new Error(`Session host ${exited}. See ${this.deps.logFile}`))
        const hf = this.readHostFile()
        if (hf && hf.pid === pid && hf.token === token) {
          try {
            await this.attach(hf)
            this.deps.log(`[host] session host pid=${pid} ready`)
            return resolve()
          } catch (err) {
            if (Date.now() > deadline) return reject(err as Error)
          }
        }
        if (Date.now() > deadline) return reject(new Error(`Session host did not start within ${SPAWN_TIMEOUT_MS / 1000}s. See ${this.deps.logFile}`))
        setTimeout(() => void tick(), 150)
      }
      void tick()
    })
  }

  // ------------------------------------------------------------------ RPC

  async call<T = unknown>(m: string, ...p: unknown[]): Promise<T> {
    if (!this.connected) await this.connect()
    const sock = this.sock
    if (!sock) throw new Error('Session host is not connected')
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, m })
      if (!writeFrame(sock, { k: 'req', id, m, p })) {
        this.pending.delete(id)
        reject(new Error('Session host is not writable'))
      }
    })
  }

  /** Ask the host to stop every session and exit; resolves when the socket closes (or after a timeout). */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (!this.connected) return
    const closed = new Promise<void>((resolve) => this.sock?.once('close', () => resolve()))
    try {
      await this.call('shutdown')
    } catch {
      /* the host may close before answering */
    }
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, timeoutMs))])
  }

  /**
   * Stop a host whose protocol this app cannot use: `hello` + `shutdown` are the only frames
   * every host version understands. Resolves once its socket closes (or after a timeout).
   */
  async stopStaleHost(timeoutMs = 15_000): Promise<void> {
    const hf = this.readHostFile()
    if (!hf) return
    await new Promise<void>((resolve) => {
      const sock = net.createConnection(hf.socketPath)
      const done = () => {
        clearTimeout(timer)
        sock.destroy()
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      const parser = new LineParser(
        (f: Frame) => {
          if (f.k === 'welcome') writeFrame(sock, { k: 'req', id: 1, m: 'shutdown', p: [] })
        },
        () => undefined
      )
      sock.on('connect', () => {
        writeFrame(sock, { k: 'hello', token: hf.token, protocol: HOST_PROTOCOL, appVersion: this.deps.appVersion, settings: this.deps.getSettings(), focused: false })
      })
      sock.on('data', (c) => parser.feed(c))
      sock.on('error', done)
      sock.on('close', done)
    })
    try {
      const cur = this.readHostFile()
      if (cur && cur.pid === hf.pid) fs.unlinkSync(this.hostFilePath)
    } catch {
      /* already gone */
    }
  }

  /** Close the socket but leave the host (and its sessions) running. */
  detach(): void {
    this.detached = true
    const sock = this.sock
    this.sock = null
    sock?.end()
    sock?.destroy()
    this.status = { ...this.status, connected: false }
  }

  // ---------------------------------------------------------- typed helpers

  list(): Promise<{ records: SessionRecord[]; live: SessionLiveState[]; groups: SessionGroup[] }> {
    return this.call('list')
  }
  createGroup(name: string): Promise<SessionGroup> {
    return this.call('createGroup', name)
  }
  renameGroup(id: string, name: string): Promise<void> {
    return this.call('renameGroup', id, name)
  }
  deleteGroup(id: string): Promise<void> {
    return this.call('deleteGroup', id)
  }
  setGroupCollapsed(id: string, collapsed: boolean): Promise<void> {
    return this.call('setGroupCollapsed', id, collapsed)
  }
  moveGroup(id: string, beforeId?: string): Promise<void> {
    return this.call('moveGroup', id, beforeId ?? null)
  }
  moveSession(id: string, move: SessionMove): Promise<void> {
    return this.call('moveSession', id, move)
  }
  relocate(id: string, cwd: string): Promise<SessionRecord> {
    return this.call('relocate', id, cwd)
  }
  history(id: string): Promise<ChatMessage[]> {
    return this.call('history', id)
  }
  create(opts: { cwd: string; title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | ''; groupId?: string }): Promise<SessionRecord> {
    return this.call('create', opts)
  }
  importCli(sessionId: string, cwd: string, title?: string): Promise<SessionRecord> {
    return this.call('importCli', sessionId, cwd, title)
  }
  listCli(dir?: string): Promise<CliSessionSummary[]> {
    return this.call('listCli', dir)
  }
  send(id: string, text: string, images?: ImageAttachment[]): Promise<void> {
    return this.call('send', id, text, images)
  }
  start(id: string): Promise<void> {
    return this.call('start', id)
  }
  stop(id: string): Promise<void> {
    return this.call('stop', id)
  }
  interrupt(id: string): Promise<void> {
    return this.call('interrupt', id)
  }
  answerPermission(id: string, requestId: string, decision: PermissionDecision): Promise<boolean> {
    return this.call('answerPermission', id, requestId, decision)
  }
  setModel(id: string, model: string): Promise<void> {
    return this.call('setModel', id, model)
  }
  setPermissionMode(id: string, mode: PermissionMode): Promise<void> {
    return this.call('setPermissionMode', id, mode)
  }
  setEffort(id: string, level: EffortLevel | ''): Promise<void> {
    return this.call('setEffort', id, level)
  }
  rename(id: string, title: string): Promise<void> {
    return this.call('rename', id, title)
  }
  setPinned(id: string, pinned: boolean): Promise<void> {
    return this.call('setPinned', id, pinned)
  }
  setArchived(id: string, archived: boolean): Promise<void> {
    return this.call('setArchived', id, archived)
  }
  remove(id: string, deleteTranscript: boolean): Promise<void> {
    return this.call('remove', id, deleteTranscript)
  }
  setActive(id: string | undefined): Promise<void> {
    this.activeSessionId = id
    return this.call('setActive', id ?? null)
  }
  stopTask(id: string, taskId: string): Promise<void> {
    return this.call('stopTask', id, taskId)
  }
  backgroundTasks(id: string, toolUseId?: string): Promise<boolean> {
    return this.call('backgroundTasks', id, toolUseId)
  }
  commands(id: string): Promise<SlashCommandView[]> {
    return this.call('commands', id)
  }
  models(id: string): Promise<ModelInfoView[]> {
    return this.call('models', id)
  }
  contextUsage(id: string, full?: boolean): Promise<ContextUsageView | null> {
    return this.call('contextUsage', id, Boolean(full))
  }
  planUsage(): Promise<SdkUsage | null> {
    return this.call('planUsage')
  }
  resumeOnLaunch(): Promise<void> {
    return this.call('resumeOnLaunch')
  }
  aliveCount(): Promise<number> {
    return this.call('aliveCount')
  }
  refreshBadge(): Promise<void> {
    return this.call('refreshBadge')
  }
  setSettings(settings: AppSettings, executable: string | undefined): Promise<void> {
    return this.call('setSettings', settings, executable)
  }
  setFocus(focused: boolean): Promise<void> {
    return this.call('setFocus', focused)
  }
  reloadEnv(): Promise<number> {
    return this.call('reloadEnv')
  }
  info(): Promise<{ pid: number; version: string; protocol: number; startedAt: number; aliveSessions: number; sdkVersion: string; logFile: string; socketPath: string }> {
    return this.call('info')
  }
}
