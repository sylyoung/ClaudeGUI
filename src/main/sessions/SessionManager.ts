import { randomUUID } from 'crypto'
import fs from 'fs'
import { deleteSession, listSessions } from '@anthropic-ai/claude-agent-sdk'
import type {
  AppSettings,
  ChatMessage,
  CliSessionSummary,
  EffortLevel,
  ImageAttachment,
  PendingPermission,
  PermissionDecision,
  PermissionMode,
  SessionEvent,
  SessionLiveState,
  SessionRecord
} from '@shared/types'
import type { AppStore } from '../store'
import { SessionRuntime, type RateLimitEventInfo } from './SessionRuntime'
import type { SdkUsage } from '../usageService'

export type NotifyKind = 'turn' | 'permission' | 'error'

export interface ManagerHost {
  getEnv(): Promise<Record<string, string>>
  getExecutable(): string | undefined
  getSettings(): AppSettings
  appVersion: string
  broadcast(event: SessionEvent): void
  notify(opts: { sessionId: string; title: string; body: string; kind: NotifyKind }): void
  isWindowFocused(): boolean
  updateBadge(count: number): void
  onRateLimit(info: RateLimitEventInfo, ts: number): void
  onTurnFinished(): void
  log(...args: unknown[]): void
}

export class SessionManager {
  private runtimes = new Map<string, SessionRuntime>()
  activeSessionId: string | undefined

  constructor(
    private store: AppStore,
    private host: ManagerHost
  ) {
    for (const record of store.listSessions()) this.runtimes.set(record.id, this.makeRuntime(record))
    this.activeSessionId = store.getActiveSession()
  }

  private makeRuntime(record: SessionRecord): SessionRuntime {
    return new SessionRuntime(record, {
      getEnv: () => this.host.getEnv(),
      getExecutable: () => this.host.getExecutable(),
      getSettings: () => this.host.getSettings(),
      appVersion: this.host.appVersion,
      onRateLimit: (info, ts) => this.host.onRateLimit(info, ts),
      emit: (e) => this.host.broadcast(e),
      saveRecord: (r) => {
        this.store.upsertSession(r)
        this.host.broadcast({ type: 'record', record: r })
      },
      onTurnFinished: (rt, preview, isError) => {
        const foreground = this.host.isWindowFocused() && this.activeSessionId === rt.id
        if (!foreground) {
          rt.bumpUnread()
          this.host.notify({ sessionId: rt.id, title: `${isError ? '⚠️ ' : '✅ '}${rt.record.title}`, body: preview || (isError ? 'Turn ended with an error' : 'Finished'), kind: isError ? 'error' : 'turn' })
        }
        this.refreshBadge()
        this.host.onTurnFinished()
      },
      onNeedsAttention: (rt, request: PendingPermission) => {
        const foreground = this.host.isWindowFocused() && this.activeSessionId === rt.id
        if (!foreground) {
          this.host.notify({ sessionId: rt.id, title: `🔔 ${rt.record.title}`, body: request.title || `${request.toolName} needs your approval`, kind: 'permission' })
        }
        this.refreshBadge()
      },
      onExit: (rt, error) => {
        if (error) this.host.notify({ sessionId: rt.id, title: `⛔ ${rt.record.title}`, body: `Process exited: ${error.slice(0, 160)}`, kind: 'error' })
        this.refreshBadge()
      },
      log: (...args) => this.host.log(...args)
    })
  }

  refreshBadge(): void {
    let count = 0
    for (const rt of this.runtimes.values()) {
      if (rt.live.status === 'requires_action' || rt.live.unread > 0) count += 1
    }
    this.host.updateBadge(count)
  }

  // ---------------------------------------------------------------- queries

  list(): { records: SessionRecord[]; live: SessionLiveState[] } {
    const records: SessionRecord[] = []
    const live: SessionLiveState[] = []
    for (const rt of this.runtimes.values()) {
      records.push(rt.record)
      live.push(rt.live)
    }
    records.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return { records, live }
  }

  get(id: string): SessionRuntime {
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error(`Unknown session ${id}`)
    return rt
  }

  async history(id: string): Promise<ChatMessage[]> {
    return this.get(id).ensureHistory()
  }

  // --------------------------------------------------------------- mutations

  create(opts: { cwd: string; title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | '' }): SessionRecord {
    const cwd = opts.cwd.replace(/\/+$/, '') || '/'
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Directory does not exist: ${cwd}`)
    const id = randomUUID()
    const now = Date.now()
    const settings = this.store.settings.get()
    const record: SessionRecord = {
      id,
      claudeSessionId: id,
      title: opts.title?.trim() || 'New session',
      autoTitle: settings.autoTitle !== false && !opts.title?.trim(),
      cwd,
      model: opts.model || settings.defaultModel || undefined,
      permissionMode: opts.permissionMode || settings.defaultPermissionMode || 'default',
      effort: (opts.effort ?? settings.defaultEffort) || undefined,
      createdAt: now,
      lastActiveAt: now,
      source: 'gui'
    }
    this.store.upsertSession(record)
    this.store.addRecentDirectory(cwd)
    const rt = this.makeRuntime(record)
    this.runtimes.set(id, rt)
    this.host.broadcast({ type: 'record', record })
    this.host.broadcast({ type: 'state', state: rt.live })
    return record
  }

  async importCli(claudeSessionId: string, cwd: string, title?: string): Promise<SessionRecord> {
    const existing = [...this.runtimes.values()].find((r) => r.record.claudeSessionId === claudeSessionId)
    if (existing) return existing.record
    const now = Date.now()
    const settings = this.store.settings.get()
    const record: SessionRecord = {
      id: claudeSessionId,
      claudeSessionId,
      title: title?.trim() || 'Imported session',
      autoTitle: settings.autoTitle !== false && !title?.trim(),
      cwd,
      permissionMode: settings.defaultPermissionMode || 'default',
      model: settings.defaultModel || undefined,
      effort: settings.defaultEffort || undefined,
      createdAt: now,
      lastActiveAt: now,
      source: 'cli-import'
    }
    this.store.upsertSession(record)
    this.store.addRecentDirectory(cwd)
    const rt = this.makeRuntime(record)
    this.runtimes.set(record.id, rt)
    this.host.broadcast({ type: 'record', record })
    this.host.broadcast({ type: 'state', state: rt.live })
    return record
  }

  async listCli(dir?: string, limit = 300): Promise<CliSessionSummary[]> {
    const known = new Set([...this.runtimes.values()].map((r) => r.record.claudeSessionId))
    const infos = await listSessions({ dir: dir || undefined, limit, includeProgrammatic: false })
    return infos.map((i) => ({
      sessionId: i.sessionId,
      summary: i.customTitle || i.summary || i.firstPrompt || '(untitled)',
      lastModified: i.lastModified,
      createdAt: i.createdAt,
      cwd: i.cwd,
      firstPrompt: i.firstPrompt,
      customTitle: i.customTitle,
      fileSize: i.fileSize,
      gitBranch: i.gitBranch,
      alreadyImported: known.has(i.sessionId)
    }))
  }

  async send(id: string, text: string, images?: ImageAttachment[]): Promise<void> {
    const rt = this.get(id)
    await rt.send(text, images)
    this.refreshBadge()
  }

  async start(id: string): Promise<void> {
    await this.get(id).ensureStarted()
  }

  async stop(id: string): Promise<void> {
    await this.get(id).stop(true)
    this.refreshBadge()
  }

  async interrupt(id: string): Promise<void> {
    await this.get(id).interrupt()
  }

  answerPermission(id: string, requestId: string, decision: PermissionDecision): boolean {
    const ok = this.get(id).answerPermission(requestId, decision)
    this.refreshBadge()
    return ok
  }

  rename(id: string, title: string): void {
    const rt = this.get(id)
    rt.rename(title)
    this.host.broadcast({ type: 'record', record: rt.record })
  }

  setPinned(id: string, pinned: boolean): void {
    const rt = this.get(id)
    rt.record.pinned = pinned
    this.store.upsertSession(rt.record)
    this.host.broadcast({ type: 'record', record: rt.record })
  }

  setArchived(id: string, archived: boolean): void {
    const rt = this.get(id)
    rt.record.archived = archived
    this.store.upsertSession(rt.record)
    this.host.broadcast({ type: 'record', record: rt.record })
  }

  async remove(id: string, deleteTranscript: boolean): Promise<void> {
    const rt = this.runtimes.get(id)
    if (!rt) return
    await rt.stop(false)
    this.runtimes.delete(id)
    this.store.removeSession(id)
    if (deleteTranscript) {
      try {
        await deleteSession(rt.record.claudeSessionId, { dir: rt.record.cwd })
      } catch (err) {
        this.host.log(`[manager] deleteSession failed: ${(err as Error).message}`)
      }
    }
    if (this.activeSessionId === id) this.setActive(undefined)
    this.host.broadcast({ type: 'record-removed', id })
    this.refreshBadge()
  }

  setActive(id: string | undefined): void {
    this.activeSessionId = id
    this.store.setActiveSession(id)
    if (id) {
      const rt = this.runtimes.get(id)
      rt?.markRead()
    }
    this.refreshBadge()
  }

  async stopAll(): Promise<void> {
    const all = [...this.runtimes.values()].filter((r) => r.isAlive)
    await Promise.all(all.map((r) => r.stop(true).catch(() => undefined)))
  }

  aliveCount(): number {
    let n = 0
    for (const rt of this.runtimes.values()) if (rt.isAlive) n += 1
    return n
  }

  /** Plan limits through any running session (used when no login token can be read directly). */
  async planUsageFromAnySession(): Promise<SdkUsage | null> {
    for (const rt of this.runtimes.values()) {
      if (!rt.isAlive) continue
      try {
        const u = await rt.getPlanUsage()
        if (u) return u
      } catch (err) {
        this.host.log(`[manager] plan usage via session failed: ${(err as Error).message}`)
      }
    }
    return null
  }

  /** Start session processes at launch according to Settings → General → "Resume on launch". */
  async resumeOnLaunch(): Promise<void> {
    const mode = this.host.getSettings().resumeOnLaunch
    if (!mode || mode === 'none') return
    const all = [...this.runtimes.values()].filter((r) => !r.record.archived)
    let targets =
      mode === 'all' ? all : mode === 'pinned' ? all.filter((r) => r.record.pinned) : all.filter((r) => r.id === this.activeSessionId)
    targets.sort((a, b) => b.record.lastActiveAt - a.record.lastActiveAt)
    if (mode === 'all') targets = targets.slice(0, 12)
    this.host.log(`[manager] resume on launch (${mode}): ${targets.length} session(s)`)
    for (const rt of targets) {
      rt.ensureStarted().catch((err) => this.host.log(`[manager] resume ${rt.id} failed: ${(err as Error).message}`))
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}
