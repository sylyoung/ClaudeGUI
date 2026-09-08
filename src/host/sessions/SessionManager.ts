import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { compareRecords, lastPromptOf } from '@shared/util'
import { nextGroupColor } from '@shared/colors'
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
  RewindPreview,
  RewindResult,
  SessionEvent,
  SessionLiveState,
  SdkUsage,
  SessionGroup,
  SessionMove,
  SessionRecord
} from '@shared/types'
import type { SessionsStore } from '../../main/store'
import { SessionRuntime, lastPromptTimeFromFile, projectDirFor, type RateLimitEventInfo } from './SessionRuntime'

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
    private store: SessionsStore,
    private host: ManagerHost
  ) {
    for (const record of store.listSessions()) this.runtimes.set(record.id, this.makeRuntime(record))
    this.activeSessionId = store.getActiveSession()
    this.assignMissingGroupColors()
    void this.backfillPromptTimes()
  }

  /** Groups created before 1.0.4 have no colour yet: give each one the next free palette colour. */
  private assignMissingGroupColors(): void {
    const groups = this.store.listGroups()
    if (!groups.some((g) => !g.color)) return
    const next: SessionGroup[] = []
    for (const g of groups) next.push(g.color ? g : { ...g, color: nextGroupColor(next) })
    this.store.setGroups(next)
  }

  /**
   * Records created before 1.0.4 have no `lastPromptAt`: read it from the tail of their transcript
   * (one file at a time, in the background) so the "recent" order is right from the first launch.
   */
  private async backfillPromptTimes(): Promise<void> {
    let changed = 0
    for (const rt of this.runtimes.values()) {
      if (rt.record.lastPromptAt) continue
      const file = path.join(projectDirFor(rt.record.cwd), `${rt.record.claudeSessionId}.jsonl`)
      const t = await lastPromptTimeFromFile(file).catch(() => undefined)
      if (rt.record.lastPromptAt) continue // set meanwhile by send() / history
      rt.record.lastPromptAt = t ?? lastPromptOf(rt.record)
      this.store.upsertSession(rt.record)
      this.host.broadcast({ type: 'record', record: rt.record })
      changed += 1
    }
    if (changed) this.host.log(`[manager] backfilled last-prompt time for ${changed} session(s)`)
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
      onTurnFinished: (rt, preview, isError, silent) => {
        const foreground = this.host.isWindowFocused() && this.activeSessionId === rt.id
        if (!foreground && !silent) {
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

  list(): { records: SessionRecord[]; live: SessionLiveState[]; groups: SessionGroup[] } {
    const records: SessionRecord[] = []
    const live: SessionLiveState[] = []
    for (const rt of this.runtimes.values()) {
      if (!rt.isAlive) rt.live.cwdMissing = !dirExists(rt.record.cwd)
      records.push(rt.record)
      live.push(rt.live)
    }
    records.sort(compareRecords)
    return { records, live, groups: this.store.listGroups() }
  }

  // ------------------------------------------------------------------ groups

  private broadcastGroups(): void {
    this.host.broadcast({ type: 'groups', groups: this.store.listGroups() })
  }

  createGroup(name: string, color?: string): SessionGroup {
    const groups = this.store.listGroups()
    const group: SessionGroup = {
      id: randomUUID(),
      name: name.trim() || 'New group',
      order: (groups[groups.length - 1]?.order ?? -1) + 1,
      color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : nextGroupColor(groups)
    }
    this.store.setGroups([...groups, group])
    this.broadcastGroups()
    return group
  }

  setGroupColor(id: string, color: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Not a colour: ${color}`)
    this.store.setGroups(this.store.listGroups().map((g) => (g.id === id ? { ...g, color } : g)))
    this.broadcastGroups()
  }

  renameGroup(id: string, name: string): void {
    const groups = this.store.listGroups().map((g) => (g.id === id ? { ...g, name: name.trim() || g.name } : g))
    this.store.setGroups(groups)
    this.broadcastGroups()
  }

  setGroupCollapsed(id: string, collapsed: boolean): void {
    this.store.setGroups(this.store.listGroups().map((g) => (g.id === id ? { ...g, collapsed } : g)))
    this.broadcastGroups()
  }

  /** Reorder a group: put it before `beforeId` (or last when omitted). */
  moveGroup(id: string, beforeId?: string): void {
    const groups = this.store.listGroups()
    const moving = groups.find((g) => g.id === id)
    if (!moving) return
    const rest = groups.filter((g) => g.id !== id)
    const idx = beforeId ? rest.findIndex((g) => g.id === beforeId) : -1
    rest.splice(idx >= 0 ? idx : rest.length, 0, moving)
    this.store.setGroups(rest.map((g, i) => ({ ...g, order: i })))
    this.broadcastGroups()
  }

  /** Delete a group; its sessions become ungrouped (nothing is removed). */
  deleteGroup(id: string): void {
    this.store.setGroups(this.store.listGroups().filter((g) => g.id !== id).map((g, i) => ({ ...g, order: i })))
    for (const rt of this.runtimes.values()) {
      if (rt.record.groupId === id) {
        rt.record.groupId = undefined
        this.store.upsertSession(rt.record)
        this.host.broadcast({ type: 'record', record: rt.record })
      }
    }
    this.broadcastGroups()
  }

  /** Place a session inside a group at a position (drag & drop, "Move to group"). */
  moveSession(id: string, move: SessionMove): void {
    const rt = this.get(id)
    const target = move.groupId || undefined
    const members = [...this.runtimes.values()].filter((r) => r.id !== id && (r.record.groupId || undefined) === target).sort((a, b) => compareRecords(a.record, b.record))
    const idx = move.beforeId ? members.findIndex((r) => r.id === move.beforeId) : -1
    members.splice(idx >= 0 ? idx : members.length, 0, rt)
    rt.record.groupId = target
    members.forEach((r, i) => {
      r.record.order = i
    })
    this.store.replaceSessions((list) => list.map((s) => this.runtimes.get(s.id)?.record ?? s))
    for (const r of members) this.host.broadcast({ type: 'record', record: r.record })
  }

  /** Point a session at another folder (e.g. after the folder was renamed) and move its transcript along. */
  async relocate(id: string, newCwd: string): Promise<SessionRecord> {
    const rt = this.get(id)
    const cwd = newCwd.replace(/\/+$/, '') || '/'
    if (!dirExists(cwd)) throw new Error(`Directory does not exist: ${cwd}`)
    if (rt.isAlive) await rt.stop(true)
    rt.moveTranscript(cwd)
    rt.record.cwd = cwd
    rt.live.cwd = cwd
    rt.live.cwdMissing = false
    rt.live.error = undefined
    if (rt.live.status === 'error') rt.live.status = 'stopped'
    this.store.upsertSession(rt.record)
    this.host.broadcast({ type: 'record', record: rt.record })
    this.host.broadcast({ type: 'state', state: { ...rt.live } })
    this.host.log(`[manager] relocated ${id} -> ${cwd}`)
    return rt.record
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

  /** New sessions go to the top of their group; the position only changes by drag & drop. */
  private topOrder(groupId: string | undefined): number {
    let min = 0
    for (const rt of this.runtimes.values()) {
      if ((rt.record.groupId || undefined) === (groupId || undefined) && typeof rt.record.order === 'number' && rt.record.order < min) min = rt.record.order
    }
    return min - 1
  }

  create(opts: { cwd: string; title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | ''; groupId?: string }): SessionRecord {
    const cwd = opts.cwd.replace(/\/+$/, '') || '/'
    if (!dirExists(cwd)) throw new Error(`Directory does not exist: ${cwd}`)
    const id = randomUUID()
    const now = Date.now()
    const settings = this.host.getSettings()
    const groupId = opts.groupId && this.store.listGroups().some((g) => g.id === opts.groupId) ? opts.groupId : undefined
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
      source: 'gui',
      groupId,
      order: this.topOrder(groupId)
    }
    this.store.upsertSession(record)
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
    const settings = this.host.getSettings()
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
      source: 'cli-import',
      order: this.topOrder(undefined)
    }
    this.store.upsertSession(record)
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

  async send(id: string, text: string, images?: ImageAttachment[]): Promise<string> {
    const rt = this.get(id)
    const messageId = await rt.send(text, images)
    this.refreshBadge()
    return messageId
  }

  async start(id: string): Promise<void> {
    await this.get(id).ensureStarted()
  }

  async stop(id: string): Promise<void> {
    await this.get(id).stop(true)
    this.refreshBadge()
  }

  cancelQueued(id: string, messageId: string): Promise<{ cancelled: boolean; text: string; images?: ImageAttachment[] }> {
    return this.get(id).cancelQueued(messageId)
  }

  rewindPreview(id: string, messageId: string): Promise<RewindPreview> {
    return this.get(id).rewindPreview(messageId)
  }

  async rewind(id: string, messageId: string, restoreFiles: boolean): Promise<RewindResult> {
    const result = await this.get(id).rewind(messageId, restoreFiles)
    this.refreshBadge()
    return result
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

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
