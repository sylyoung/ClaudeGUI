import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import {
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  query,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AppSettings,
  BackgroundTaskView,
  ChatMessage,
  ContextUsageView,
  EffortLevel,
  ImageAttachment,
  ModelInfoView,
  PendingPermission,
  PermissionDecision,
  PermissionMode,
  PromptDelivery,
  RewindPreview,
  RewindResult,
  SessionEvent,
  SessionLiveState,
  SdkUsage,
  SessionRecord,
  SlashCommandView
} from '@shared/types'
import { TranscriptState, looksSynthetic } from './transcript'
import { splitList } from '@shared/util'

/** Unbounded async queue used as the SDK's streaming-input prompt. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private ended = false
  get size(): number {
    return this.items.length
  }
  push(item: T): void {
    if (this.ended) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }
  end(): void {
    this.ended = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined as never, done: true })
      }
    }
  }
}

export interface RateLimitEventInfo {
  rateLimitType?: string
  utilization?: number
  resetsAt?: number
  status?: string
}

export interface RuntimeDeps {
  getEnv(): Promise<Record<string, string>>
  getExecutable(): string | undefined
  getSettings(): AppSettings
  appVersion: string
  onRateLimit(info: RateLimitEventInfo, ts: number): void
  emit(event: SessionEvent): void
  saveRecord(record: SessionRecord): void
  /** silent = housekeeping (a context compaction): no unread mark, no notification. */
  onTurnFinished(rt: SessionRuntime, preview: string, isError: boolean, silent?: boolean): void
  onNeedsAttention(rt: SessionRuntime, request: PendingPermission): void
  onExit(rt: SessionRuntime, error?: string): void
  log(...args: unknown[]): void
}

const FLUSH_MS = 45
/** How long a chat may stay quiet before a prompt still marked as being answered is let go. */
const DELIVERY_QUIET_MS = 10_000

export class SessionRuntime {
  readonly transcript = new TranscriptState()
  live: SessionLiveState
  private q: Query | null = null
  private queue: AsyncQueue<SDKUserMessage> | null = null
  private abort: AbortController | null = null
  private pending = new Map<string, { resolve: (r: PermissionResult) => void; request: PendingPermission; suggestions?: PermissionUpdate[] }>()
  private historyLoaded = false
  private historyPromise: Promise<void> | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private stateDirty = false
  private runLoop: Promise<void> | null = null
  private stopping = false
  private startPromise: Promise<void> | null = null
  private tasks = new Map<string, BackgroundTaskView>()
  private lastAssistantText = ''
  /** Since the last finished turn: did Claude write anything, and was the context compacted? */
  private turnHadText = false
  private turnHadCompaction = false
  /** Since the last finished turn: was the compaction one the user asked for with "/compact"? */
  private turnHadManualCompaction = false
  private processCostSeen = 0
  /** Chain entry the next start resumes at (a rewind fork point), or null for the whole chain. */
  private resumeAt: string | null = null
  /** Whether file backups were switched on for the process that is running now. */
  private checkpointing = false
  /** Clears prompts left marked as being answered when no turn ever came for them. */
  private deliverySweep: NodeJS.Timeout | null = null

  constructor(
    public record: SessionRecord,
    private deps: RuntimeDeps
  ) {
    this.live = {
      id: record.id,
      status: 'stopped',
      processAlive: false,
      model: record.model,
      permissionMode: record.permissionMode,
      effort: record.effort ?? null,
      cwd: record.cwd,
      pendingPermissions: [],
      backgroundTasks: [],
      activeTools: [],
      totalCostUsd: record.totalCostUsd ?? 0,
      unread: 0,
      lastActivityAt: record.lastActiveAt,
      queuedCount: 0,
      queuedIds: [],
      promptDelivery: {}
    }
  }

  get id(): string {
    return this.record.id
  }

  get isAlive(): boolean {
    return this.q !== null
  }

  // ------------------------------------------------------------------ history

  async ensureHistory(): Promise<ChatMessage[]> {
    if (this.historyLoaded) return this.transcript.messages
    if (!this.historyPromise) this.historyPromise = this.loadHistory()
    await this.historyPromise
    return this.transcript.messages
  }

  private async loadHistory(): Promise<void> {
    try {
      const entries = await getSessionMessages(this.record.claudeSessionId, {
        dir: this.record.cwd,
        includeSystemMessages: true
      })
      // Replay before any live message so ordering is preserved.
      const liveSnapshot = this.transcript.messages
      const wasEmpty = liveSnapshot.length === 0
      if (wasEmpty) {
        const mainFile = path.join(projectDirFor(this.record.cwd), `${this.record.claudeSessionId}.jsonl`)
        const stamps = await readTimestamps(mainFile)
        let ts = this.record.createdAt || Date.now()
        for (const e of entries) {
          const real = stamps.get((e as { uuid: string }).uuid)
          if (real) ts = real
          this.transcript.applyHistoryEntry(e as never, ts)
          ts += 1
        }
        await this.loadSubagentHistory(ts)
        this.transcript.takeChanges()
      }
      this.deps.log(`[session ${this.id}] history loaded: ${entries.length} entries`)
      if (!this.record.lastPromptAt) {
        const t = lastPromptTime(this.transcript.messages)
        if (t) {
          this.record.lastPromptAt = t
          this.deps.saveRecord(this.record)
        }
      }
    } catch (err) {
      // A brand-new session has no transcript yet; that is fine.
      this.deps.log(`[session ${this.id}] no history (${(err as Error).message})`)
    }
    this.historyLoaded = true
    this.deps.emit({ type: 'messages-reset', sessionId: this.id, messages: this.transcript.messages })
  }

  /** Attach persisted subagent transcripts to their Agent tool blocks (most recent 40). */
  private async loadSubagentHistory(baseTs: number): Promise<void> {
    const subDir = path.join(projectDirFor(this.record.cwd), this.record.claudeSessionId, 'subagents')
    let metas: string[]
    try {
      metas = fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json'))
    } catch {
      return
    }
    metas = metas
      .map((f) => ({ f, m: fs.statSync(path.join(subDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 40)
      .map((x) => x.f)
    for (const f of metas) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8')) as { toolUseId?: string }
        const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '')
        if (!meta.toolUseId || !this.transcript.hasTool(meta.toolUseId) || this.transcript.toolChildCount(meta.toolUseId) > 0) continue
        const msgs = await getSubagentMessages(this.record.claudeSessionId, agentId, { dir: this.record.cwd })
        const stamps = await readTimestamps(path.join(subDir, f.replace(/\.meta\.json$/, '.jsonl')))
        let ts = baseTs
        for (const m of msgs) {
          const real = stamps.get((m as { uuid: string }).uuid)
          if (real) ts = real
          this.transcript.applyHistoryEntry({ ...(m as never as object), parent_tool_use_id: meta.toolUseId } as never, ts)
          ts += 1
        }
      } catch (err) {
        this.deps.log(`[session ${this.id}] subagent history ${f}: ${(err as Error).message}`)
      }
    }
  }

  // ------------------------------------------------------------------ process

  async ensureStarted(): Promise<void> {
    if (this.q) return
    if (!this.startPromise) this.startPromise = this.start().finally(() => (this.startPromise = null))
    await this.startPromise
  }

  private async start(): Promise<void> {
    this.stopping = false
    if (!isDirectory(this.record.cwd)) {
      this.live.cwdMissing = true
      this.live.error = `Working directory not found: ${this.record.cwd}. Use "Change working directory…" to point the session at the folder's new location.`
      this.setStatus('error')
      this.scheduleFlush()
      throw new Error(this.live.error)
    }
    this.live.cwdMissing = false
    await this.ensureHistory()
    this.setStatus('starting')
    this.live.error = undefined
    const env = await this.deps.getEnv()
    let resume = false
    try {
      const info = await getSessionInfo(this.record.claudeSessionId, { dir: this.record.cwd })
      resume = Boolean(info)
    } catch {
      resume = false
    }
    const mode = this.record.permissionMode as SdkPermissionMode
    const settings = this.deps.getSettings()
    const allowed = splitList(settings.allowedTools || '')
    const disallowed = splitList(settings.disallowedTools || '')
    const sources = ['user', ...(settings.useProjectSettings ? ['project'] : []), ...(settings.useLocalSettings ? ['local'] : [])]
    const options: Options = {
      cwd: this.record.cwd,
      model: this.record.model || undefined,
      permissionMode: mode,
      allowDangerouslySkipPermissions: mode === 'bypassPermissions' ? true : undefined,
      effort: this.record.effort || undefined,
      includePartialMessages: true,
      enableFileCheckpointing: settings.fileCheckpointing !== false,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: sources as Options['settingSources'],
      maxTurns: settings.maxTurns > 0 ? settings.maxTurns : undefined,
      maxThinkingTokens: settings.maxThinkingTokens > 0 ? settings.maxThinkingTokens : undefined,
      allowedTools: allowed.length ? allowed : undefined,
      disallowedTools: disallowed.length ? disallowed : undefined,
      canUseTool: (toolName, input, opts) => this.handleCanUseTool(toolName, input, opts),
      env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: `ClaudeGUI/${this.deps.appVersion}` },
      stderr: (data) => this.deps.log(`[claude ${this.id.slice(0, 8)} stderr] ${data.trimEnd()}`),
      abortController: (this.abort = new AbortController())
    }
    const exe = this.deps.getExecutable()
    if (exe) options.pathToClaudeCodeExecutable = exe
    if (resume) {
      options.resume = this.record.claudeSessionId
      // Set by rewind(): the CLI then replays the conversation only up to that entry.
      if (this.resumeAt) {
        options.resumeSessionAt = this.resumeAt
        this.deps.log(`[session ${this.id}] resuming at ${this.resumeAt} (rewind)`)
      }
    } else {
      options.sessionId = this.record.claudeSessionId
      if (this.record.title && !this.record.autoTitle) options.title = this.record.title
    }
    this.checkpointing = options.enableFileCheckpointing === true
    this.queue = new AsyncQueue<SDKUserMessage>()
    const q = query({ prompt: this.queue, options })
    this.q = q
    this.live.processAlive = true
    this.live.processStartedAt = Date.now()
    this.processCostSeen = 0
    this.tasks.clear()
    this.live.backgroundTasks = []
    this.deps.log(`[session ${this.id}] started (${resume ? 'resume' : 'new'}) cwd=${this.record.cwd}`)
    this.runLoop = this.consume(q)
    q.initializationResult()
      .then((init) => {
        if (this.q !== q) return
        this.live.slashCommands = init.commands.map(toCommandView)
        this.live.models = init.models.map(toModelView)
        if (this.live.status === 'starting') this.setStatus('idle')
        this.scheduleFlush()
        void this.refreshContextUsage('summary')
      })
      .catch((err) => this.deps.log(`[session ${this.id}] initialize failed: ${(err as Error).message}`))
  }

  private async consume(q: Query): Promise<void> {
    let error: string | undefined
    try {
      for await (const msg of q) {
        if (this.q !== q) break
        this.handle(msg)
      }
    } catch (err) {
      error = (err as Error)?.message || String(err)
      if (!this.stopping) this.deps.log(`[session ${this.id}] query error: ${error}`)
      if (this.resumeAt && /No message found with message\.uuid|Resume rejected/i.test(error)) {
        // Claude Code refused to cut its own transcript there. Give up on the fork point instead of
        // failing every start from now on, and say so: Claude still remembers the removed part.
        this.resumeAt = null
        this.transcript.addLocalNotice(
          'The chat was rewound here, but Claude Code could not cut its own transcript at this point, so Claude may still remember the removed messages. The files were still put back if you asked for that.',
          'warning'
        )
      }
    } finally {
      if (this.q === q) {
        this.q = null
        this.queue = null
        this.abort = null
      }
      // Reject anything still waiting on this process.
      for (const [id, p] of this.pending) {
        p.resolve({ behavior: 'deny', message: 'Session process ended.' })
        this.pending.delete(id)
      }
      this.live.pendingPermissions = []
      this.live.activeTools = []
      this.live.processAlive = false
      this.live.activity = null
      this.setQueued([])
      // Nothing can be waiting or being answered once the process is gone; the chat falls back to
      // reading those prompts from the transcript, where they show as delivered but unanswered.
      for (const id of Object.keys(this.live.promptDelivery)) this.setDelivery(id, null)
      if (this.deliverySweep) {
        clearTimeout(this.deliverySweep)
        this.deliverySweep = null
      }
      for (const m of this.transcript.messages) {
        if (m.kind === 'assistant' && m.streaming) {
          m.streaming = false
          this.transcript.changed.add(m.id)
        }
      }
      if (error && !this.stopping) {
        this.live.error = error
        this.setStatus('error')
      } else {
        this.setStatus('stopped')
      }
      this.scheduleFlush()
      this.deps.onExit(this, this.stopping ? undefined : error)
    }
  }

  async stop(graceful = true): Promise<void> {
    const q = this.q
    if (!q) return
    this.stopping = true
    this.queue?.end()
    if (graceful) {
      await Promise.race([this.runLoop, new Promise((r) => setTimeout(r, 4000))])
    }
    if (this.q === q) {
      try {
        q.close()
      } catch (err) {
        this.deps.log(`[session ${this.id}] close failed: ${(err as Error).message}`)
      }
    }
    await Promise.race([this.runLoop, new Promise((r) => setTimeout(r, 1500))])
  }

  // --------------------------------------------------------------------- rewind

  /** The prompt and the chain entry the conversation would be cut back to. */
  private rewindTarget(messageId: string): { index: number; text: string; forkAt: string | null } {
    const idx = this.transcript.messages.findIndex((m) => m.id === messageId)
    const target = this.transcript.messages[idx]
    if (!target || target.kind !== 'user' || target.synthetic) throw new Error('A rewind goes back to one of your own prompts')
    let forkAt: string | null = null
    for (let i = idx - 1; i >= 0; i--) {
      const m = this.transcript.messages[i]
      if (m.kind === 'assistant' && !m.parentToolUseId) {
        forkAt = m.chainUuid ?? null
        break
      }
    }
    return { index: idx, text: target.text, forkAt }
  }

  /** Why there is no point to go back to before this prompt. */
  private noForkReason(messageId: string): string {
    const idx = this.transcript.messages.findIndex((m) => m.id === messageId)
    const earlier = this.transcript.messages.slice(0, idx).some((m) => m.kind === 'assistant' && !m.parentToolUseId)
    return earlier
      ? 'The answer before this prompt was written by an older version of the app, which did not record the point Claude Code would have to resume from.'
      : 'This is the first prompt of the chat, so there is nothing before it to go back to.'
  }

  /** What a rewind to this prompt would do, without changing anything. */
  async rewindPreview(messageId: string): Promise<RewindPreview> {
    const { text, forkAt } = this.rewindTarget(messageId)
    const preview: RewindPreview = {
      text,
      canRewind: Boolean(forkAt),
      reason: forkAt ? undefined : this.noForkReason(messageId),
      files: { available: false, changed: 0, insertions: 0, deletions: 0, paths: [] }
    }
    if (!this.q) {
      preview.files.reason = 'The session is not running. Start it first if the files should be put back as well.'
      return preview
    }
    if (!this.checkpointing) {
      preview.files.reason = 'This session was started without file backups, so only the conversation can be rewound.'
      return preview
    }
    try {
      const r = await this.q.rewindFiles(messageId, { dryRun: true })
      preview.files.available = r.canRewind
      preview.files.reason = r.canRewind ? undefined : r.error || 'Claude Code has no file backups for this prompt.'
      preview.files.paths = r.filesChanged ?? []
      preview.files.changed = r.filesChanged?.length ?? 0
      preview.files.insertions = r.insertions ?? 0
      preview.files.deletions = r.deletions ?? 0
    } catch (err) {
      preview.files.reason = (err as Error).message
    }
    return preview
  }

  /**
   * Cut the chat back to just before one of your prompts: optionally put the files Claude changed
   * since then back as they were, stop the process, drop the messages from that prompt onwards and
   * remember the fork point, so the next message continues the conversation from there.
   */
  async rewind(messageId: string, restoreFiles: boolean): Promise<RewindResult> {
    const { index, text, forkAt } = this.rewindTarget(messageId)
    if (!forkAt) throw new Error(this.noForkReason(messageId))
    let filesRestored = 0
    let filesSkipped = 0
    if (restoreFiles) {
      if (!this.q) throw new Error('The session is not running, so the files cannot be put back.')
      // The real rewind does not always report which files it touched, so count them first.
      const planned = await this.q.rewindFiles(messageId, { dryRun: true }).catch(() => null)
      const r = await this.q.rewindFiles(messageId)
      if (!r.canRewind) throw new Error(r.error || 'The files could not be put back.')
      filesRestored = r.filesChanged?.length ?? planned?.filesChanged?.length ?? 0
      filesSkipped = r.skippedLinks ?? 0
    }
    await this.stop(true)
    for (const m of this.transcript.messages.slice(index)) this.transcript.removeMessage(m.id)
    this.resumeAt = forkAt
    const lastPrompt = [...this.transcript.messages].reverse().find((m) => m.kind === 'user' && !m.synthetic)
    this.record.lastPromptAt = lastPrompt?.ts ?? this.record.createdAt
    this.record.lastActiveAt = Date.now()
    this.live.lastPreview = text.replace(/\s+/g, ' ').slice(0, 140)
    this.live.unread = 0
    this.deps.saveRecord(this.record)
    this.deps.log(`[session ${this.id}] rewound to ${messageId} (files: ${restoreFiles ? filesRestored : 'kept'})`)
    this.scheduleFlush()
    this.flush()
    return { text, filesRestored, filesSkipped }
  }

  async interrupt(): Promise<void> {
    if (!this.q) return
    try {
      await this.q.interrupt()
    } catch (err) {
      this.deps.log(`[session ${this.id}] interrupt failed: ${(err as Error).message}`)
    }
  }

  // ------------------------------------------------------------------ input

  /** Hand a prompt to Claude Code; the id it is known by in the chat is returned. */
  async send(text: string, images?: ImageAttachment[]): Promise<string> {
    await this.ensureStarted()
    if (!this.queue) throw new Error('Session is not running')
    const uuid = randomUUID()
    this.transcript.addLocalUserMessage(uuid, text, images)
    const content: unknown[] = []
    if (text.trim()) content.push({ type: 'text', text })
    for (const img of images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
    }
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: images?.length ? (content as never) : text },
      parent_tool_use_id: null,
      uuid: uuid as never,
      session_id: this.record.claudeSessionId
    }
    // A prompt waits whenever Claude Code still owes an answer for an earlier one. Reading that
    // from the prompts themselves rather than from the session status also covers the moments
    // where the status is briefly idle although the CLI has already taken the next prompt.
    if (this.hasUnfinishedPrompt() || this.live.status === 'running' || this.live.status === 'requires_action') {
      this.setDelivery(uuid, 'queued')
      this.setQueued([...this.live.queuedIds, uuid])
    } else {
      this.setDelivery(uuid, 'working')
      this.setStatus('running')
    }
    this.queue.push(message)
    this.record.lastActiveAt = Date.now()
    this.record.lastPromptAt = this.record.lastActiveAt
    this.live.lastActivityAt = this.record.lastActiveAt
    this.live.lastPreview = text.slice(0, 120)
    this.deps.saveRecord(this.record)
    this.scheduleFlush()
    return uuid
  }

  /** Remember which prompts Claude Code has not taken off its queue yet. */
  private setQueued(ids: string[]): void {
    this.live.queuedIds = ids
    this.live.queuedCount = ids.length
  }

  /**
   * Record what Claude Code has done with a prompt this app sent; `null` means the turn that took
   * it has finished, so the chat can read its state from the transcript again.
   */
  private setDelivery(id: string, state: PromptDelivery | null): void {
    const current = this.live.promptDelivery
    if (state === null) {
      if (!(id in current)) return
      const next = { ...current }
      delete next[id]
      this.live.promptDelivery = next
    } else {
      if (current[id] === state) return
      this.live.promptDelivery = { ...current, [id]: state }
    }
    this.stateDirty = true
  }

  /**
   * Claude Code has just taken a prompt off its queue: it is being answered from now on, and it
   * belongs at the end of the chat, directly above the answer that is about to be written, rather
   * than where it was typed — which was in the middle of the answer to the previous prompt.
   */
  private startWorking(id: string): void {
    this.setDelivery(id, 'working')
    this.transcript.moveToEnd(id)
    this.scheduleFlush()
  }

  /** Is there a prompt Claude Code has not answered yet? */
  private hasUnfinishedPrompt(): boolean {
    return Object.values(this.live.promptDelivery).some((s) => s === 'queued' || s === 'working')
  }

  /**
   * Claude Code named the prompts the turn it is starting has taken, so they are being answered
   * now and are no longer waiting in its queue.
   */
  private takePrompts(msg: { user_message_uuids?: string[]; user_message_uuid?: string }): void {
    const ids = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : [])
    if (!ids.length) return
    for (const id of ids) if (this.live.promptDelivery[id] === 'queued') this.startWorking(id)
    const taken = new Set(ids)
    const rest = this.live.queuedIds.filter((id) => !taken.has(id))
    if (rest.length !== this.live.queuedIds.length) {
      this.setQueued(rest)
      this.stateDirty = true
      this.scheduleFlush()
    }
  }

  /**
   * A chat that has been idle for a while has nothing waiting and nothing running, whatever the
   * last turn said: a prompt still marked as waiting or as being answered was taken by a turn
   * that never came (answered inside a turn Claude Code did not name, or dropped). Letting those
   * go keeps a stale mark from sitting in the chat — and from pushing every later prompt into the
   * queue behind it.
   */
  private sweepDeliveryWhenQuiet(): void {
    if (this.deliverySweep) clearTimeout(this.deliverySweep)
    this.deliverySweep = setTimeout(() => {
      this.deliverySweep = null
      if (this.live.status !== 'idle' || !Object.keys(this.live.promptDelivery).length) return
      for (const id of Object.keys(this.live.promptDelivery)) this.setDelivery(id, null)
      this.setQueued([])
      this.stateDirty = true
      this.flush()
    }, DELIVERY_QUIET_MS)
  }

  /**
   * Take a prompt back out of Claude Code's queue and hand its text back, so it can go into the
   * input box for editing. Only possible while it is still waiting: once the CLI has taken it for
   * the running turn it will answer it, and we say so rather than pretend it was withdrawn.
   */
  async cancelQueued(messageId: string): Promise<{ cancelled: boolean; text: string; images?: ImageAttachment[] }> {
    const msg = this.transcript.messages.find((m) => m.id === messageId)
    const text = msg?.kind === 'user' ? msg.text : ''
    const images = msg?.kind === 'user' ? msg.images : undefined
    if (!this.live.queuedIds.includes(messageId)) return { cancelled: false, text, images }
    const q = this.q as (Query & { cancelAsyncMessage?(uuid: string): Promise<boolean> }) | null
    let cancelled = false
    try {
      cancelled = q?.cancelAsyncMessage ? Boolean(await q.cancelAsyncMessage(messageId)) : false
    } catch (err) {
      this.deps.log(`[session ${this.id}] taking a queued prompt back failed: ${(err as Error).message}`)
    }
    if (!cancelled) return { cancelled: false, text, images }
    this.setQueued(this.live.queuedIds.filter((id) => id !== messageId))
    this.setDelivery(messageId, null)
    this.transcript.removeMessage(messageId)
    this.scheduleFlush()
    this.flush()
    return { cancelled: true, text, images }
  }

  // ------------------------------------------------------------- permissions

  private handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<NonNullable<Options['canUseTool']>>[2]
  ): Promise<PermissionResult> {
    const request: PendingPermission = {
      requestId: opts.requestId || randomUUID(),
      toolUseId: opts.toolUseID,
      toolName,
      input,
      suggestions: opts.suggestions as unknown[] | undefined,
      title: opts.title,
      description: opts.description,
      displayName: opts.displayName,
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      agentId: opts.agentID,
      createdAt: Date.now()
    }
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(request.requestId, { resolve, request, suggestions: opts.suggestions })
      this.live.pendingPermissions = [...this.live.pendingPermissions, request]
      this.setStatus('requires_action')
      this.scheduleFlush()
      this.deps.onNeedsAttention(this, request)
      opts.signal.addEventListener('abort', () => {
        if (this.pending.has(request.requestId)) {
          this.pending.delete(request.requestId)
          this.live.pendingPermissions = this.live.pendingPermissions.filter((p) => p.requestId !== request.requestId)
          if (!this.live.pendingPermissions.length && this.live.status === 'requires_action') this.setStatus('running')
          this.scheduleFlush()
          resolve({ behavior: 'deny', message: 'Request cancelled.' })
        }
      })
    })
  }

  answerPermission(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    this.live.pendingPermissions = this.live.pendingPermissions.filter((r) => r.requestId !== requestId)
    if (decision.behavior === 'allow') {
      p.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? p.request.input,
        updatedPermissions: decision.alwaysAllow ? p.suggestions : undefined,
        decisionClassification: decision.alwaysAllow ? 'user_permanent' : 'user_temporary'
      })
    } else {
      this.transcript.markToolDenied(p.request.toolUseId)
      p.resolve({
        behavior: 'deny',
        message: decision.message || 'The user declined this action.',
        interrupt: decision.interrupt,
        decisionClassification: 'user_reject'
      })
    }
    if (!this.live.pendingPermissions.length && this.live.status === 'requires_action') this.setStatus('running')
    this.scheduleFlush()
    return true
  }

  // ---------------------------------------------------------------- controls

  async setModel(model: string): Promise<void> {
    this.record.model = model || undefined
    this.live.model = model || undefined
    this.deps.saveRecord(this.record)
    if (this.q) await this.q.setModel(model || undefined)
    this.scheduleFlush()
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.record.permissionMode = mode
    this.live.permissionMode = mode
    this.deps.saveRecord(this.record)
    if (this.q) await this.q.setPermissionMode(mode as SdkPermissionMode)
    this.scheduleFlush()
  }

  async setEffort(level: EffortLevel | ''): Promise<void> {
    this.record.effort = level || undefined
    this.live.effort = level || null
    this.deps.saveRecord(this.record)
    if (this.q) await this.q.applyFlagSettings({ effortLevel: level ? level : null } as never)
    this.scheduleFlush()
  }

  async stopTask(taskId: string): Promise<void> {
    if (this.q) await this.q.stopTask(taskId)
  }

  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    if (!this.q) return false
    return this.q.backgroundTasks(toolUseId)
  }

  async getCommands(): Promise<SlashCommandView[]> {
    if (this.live.slashCommands) return this.live.slashCommands
    if (!this.q) return []
    const cmds = await this.q.supportedCommands()
    this.live.slashCommands = cmds.map(toCommandView)
    return this.live.slashCommands
  }

  async getModels(): Promise<ModelInfoView[]> {
    if (this.live.models) return this.live.models
    if (!this.q) return []
    const models = await this.q.supportedModels()
    this.live.models = models.map(toModelView)
    return this.live.models
  }

  private contextRefreshing = false

  /**
   * Ask the CLI for its context-window accounting. 'summary' is cheap (uses the last response's
   * usage); 'full' re-counts every category with the token-count API.
   */
  async refreshContextUsage(detail: 'summary' | 'full' = 'summary'): Promise<ContextUsageView | null> {
    if (!this.q) return this.live.contextUsage ?? null
    if (this.contextRefreshing && detail === 'summary') return this.live.contextUsage ?? null
    this.contextRefreshing = true
    try {
      const r = await this.q.getContextUsage({ detail })
      const view: ContextUsageView = {
        totalTokens: r.totalTokens,
        maxTokens: r.rawMaxTokens || r.maxTokens,
        percentage: r.percentage,
        model: (r as { model?: string }).model ?? this.live.model,
        categories: r.categories.map((c) => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.isDeferred ? 'deferred' : undefined })),
        checkedAt: Date.now()
      }
      this.live.contextUsage = view
      this.live.contextWindow = view.maxTokens
      if (view.totalTokens > 0) this.live.contextTokens = view.totalTokens
      this.scheduleFlush()
      return view
    } catch (err) {
      this.deps.log(`[session ${this.id}] context usage failed: ${(err as Error).message}`)
      return this.live.contextUsage ?? null
    } finally {
      this.contextRefreshing = false
    }
  }

  /** Plan rate limits as reported by the CLI's structured /usage (experimental SDK API). */
  async getPlanUsage(): Promise<SdkUsage | null> {
    if (!this.q) return null
    const q = this.q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors?: boolean }) => Promise<unknown> }
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof fn !== 'function') return null
    return (await fn.call(this.q, { skipBehaviors: true })) as SdkUsage
  }

  /** Move the transcript (and subagent transcripts) to the project folder of a new working directory. */
  moveTranscript(newCwd: string): void {
    const from = projectDirFor(this.record.cwd)
    const to = projectDirFor(newCwd)
    if (from === to) return
    fs.mkdirSync(to, { recursive: true })
    const id = this.record.claudeSessionId
    for (const name of [`${id}.jsonl`, id]) {
      const src = path.join(from, name)
      const dst = path.join(to, name)
      try {
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst)
      } catch (err) {
        this.deps.log(`[session ${this.id}] move ${src} -> ${dst} failed: ${(err as Error).message}`)
      }
    }
  }

  markRead(): void {
    if (this.live.unread) {
      this.live.unread = 0
      this.scheduleFlush()
    }
  }

  rename(title: string): void {
    this.record.title = title
    this.record.autoTitle = false
    this.deps.saveRecord(this.record)
  }

  // ---------------------------------------------------------------- handling

  private handle(msg: SDKMessage): void {
    const ts = Date.now()
    this.live.lastActivityAt = ts
    switch (msg.type) {
      // The prompts a turn has taken are read before its first row is written into the chat:
      // taking a prompt moves it to the end of the chat, and it has to get there before the
      // answer it starts, not after it.
      case 'stream_event': {
        this.takePrompts(msg)
        this.transcript.apply(msg, ts)
        if (msg.event.type === 'message_start' && this.live.status !== 'requires_action') this.setStatus('running')
        break
      }
      case 'assistant': {
        if (!msg.parent_tool_use_id) this.takePrompts(msg)
        this.transcript.apply(msg, ts)
        if (this.live.status === 'idle' || this.live.status === 'starting') this.setStatus('running')
        const usage = msg.message.usage as unknown as Record<string, number> | undefined
        if (usage && !msg.parent_tool_use_id) {
          const ctx = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
          if (ctx > 0) this.live.contextTokens = ctx
        }
        for (const b of msg.message.content) {
          if (b.type === 'text' && !msg.parent_tool_use_id && b.text.trim()) {
            this.lastAssistantText = b.text
            this.turnHadText = true
          }
        }
        break
      }
      case 'user': {
        this.transcript.apply(msg, ts)
        const content = msg.message.content
        if (Array.isArray(content)) {
          const done = new Set<string>()
          for (const b of content as { type: string; tool_use_id?: string }[]) if (b.type === 'tool_result' && b.tool_use_id) done.add(b.tool_use_id)
          if (done.size) this.live.activeTools = this.live.activeTools.filter((t) => !done.has(t.toolUseId))
        }
        break
      }
      case 'result': {
        this.transcript.apply(msg, ts)
        {
          const processCost = msg.total_cost_usd ?? 0
          const delta = Math.max(0, processCost - this.processCostSeen)
          this.processCostSeen = processCost
          this.record.totalCostUsd = (this.record.totalCostUsd ?? 0) + delta
          this.live.totalCostUsd = this.record.totalCostUsd
        }
        const last = this.transcript.messages[this.transcript.messages.length - 1]
        if (last?.kind === 'result') this.live.lastTurn = last.stats
        this.live.activeTools = []
        this.live.activity = null
        // Which of the prompts still waiting were taken by this turn. Claude Code may fold several
        // of them into one turn, so counting one off per finished turn leaves prompts marked as
        // waiting long after they were answered; the result says exactly which ones it consumed
        // (user_message_uuids) and how many of ours are still in its queue (queued_turn_count).
        const r = msg as { queued_turn_count?: number; user_message_uuid?: string; user_message_uuids?: string[] }
        const consumed = new Set(r.user_message_uuids ?? (r.user_message_uuid ? [r.user_message_uuid] : []))
        let waiting = this.live.queuedIds.filter((id) => !consumed.has(id))
        // Backstop for a prompt taken without being named: the queue is first in, first out, and
        // queued_turn_count says how many of our sends are still in it. A prompt that leaves the
        // queue here without being named was taken for the turn that starts next — it is being
        // answered, not answered, which is the difference the chat used to get wrong after a
        // /compact (the compaction's own result names no prompt at all).
        const takenNext = new Set<string>()
        if (typeof r.queued_turn_count === 'number' && r.queued_turn_count < waiting.length) {
          for (const id of waiting.slice(0, waiting.length - r.queued_turn_count)) takenNext.add(id)
          waiting = waiting.slice(waiting.length - r.queued_turn_count)
        }
        // The prompts this turn answered are finished, and so is anything it was working on:
        // Claude Code runs one turn at a time. The prompts it has just taken for the next turn
        // are the exception — they are being answered from now on.
        for (const id of consumed) this.setDelivery(id, null)
        for (const [id, state] of Object.entries(this.live.promptDelivery)) {
          if (state === 'working' && !takenNext.has(id)) this.setDelivery(id, null)
        }
        for (const id of takenNext) this.startWorking(id)
        this.setQueued(waiting)
        const queued = r.queued_turn_count ?? waiting.length
        if (queued > 0) this.setStatus('running')
        else if (this.live.status !== 'requires_action') this.setStatus('idle')
        this.sweepDeliveryWhenQuiet()
        const preview = msg.subtype === 'success' ? msg.result : humanResultSubtype(msg.subtype, (msg as { errors?: string[] }).errors)
        const text = (this.lastAssistantText || preview || '').trim()
        this.live.lastPreview = text.replace(/\s+/g, ' ').slice(0, 140)
        this.record.lastActiveAt = ts
        this.deps.saveRecord(this.record)
        // A turn that only compacted the context is housekeeping, not an answer: it must not mark
        // the chat unread or raise a notification. A "/compact" the user typed counts as
        // housekeeping even though compacting writes a summary — that summary is not an answer to
        // read — unless a real prompt was folded into the same turn.
        const otherPrompts = [...consumed].filter((id) => {
          const m = this.transcript.messages.find((x) => x.id === id)
          return m?.kind === 'user' && !/^\s*\/compact\b/.test(m.text)
        })
        const compactionOnly = this.turnHadManualCompaction
          ? otherPrompts.length === 0
          : this.turnHadCompaction && !this.turnHadText
        this.turnHadCompaction = false
        this.turnHadManualCompaction = false
        this.turnHadText = false
        this.deps.onTurnFinished(this, this.live.lastPreview, Boolean(msg.is_error) || msg.subtype !== 'success', compactionOnly)
        this.refreshTitle()
        void this.refreshContextUsage('summary')
        break
      }
      case 'tool_progress': {
        this.transcript.apply(msg, ts)
        const idx = this.live.activeTools.findIndex((t) => t.toolUseId === msg.tool_use_id)
        const view = { toolUseId: msg.tool_use_id, toolName: msg.tool_name, elapsedSeconds: msg.elapsed_time_seconds, parentToolUseId: msg.parent_tool_use_id }
        if (idx >= 0) this.live.activeTools[idx] = view
        else this.live.activeTools = [...this.live.activeTools, view]
        break
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        this.live.rateLimit = { status: info.status, rateLimitType: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt }
        this.deps.onRateLimit({ rateLimitType: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt, status: info.status }, ts)
        break
      }
      case 'conversation_reset': {
        this.transcript.reset()
        this.record.conversationId = msg.new_conversation_id
        this.deps.saveRecord(this.record)
        this.deps.emit({ type: 'messages-reset', sessionId: this.id, messages: [] })
        break
      }
      case 'system': {
        this.handleSystem(msg as SDKMessage & { type: 'system' }, ts)
        break
      }
      default:
        break
    }
    this.stateDirty = true
    this.scheduleFlush()
  }

  private handleSystem(msg: SDKMessage & { type: 'system' }, ts: number): void {
    const s = msg as unknown as Record<string, unknown> & { subtype: string }
    if (s.subtype === 'compact_boundary') {
      this.turnHadCompaction = true
      // "manual" = the user typed /compact; "auto" = the context ran full during a real turn.
      if ((s.compact_metadata as { trigger?: string } | undefined)?.trigger === 'manual') this.turnHadManualCompaction = true
    }
    switch (s.subtype) {
      case 'init': {
        // The CLI accepted the fork point; a later restart must not truncate again.
        this.resumeAt = null
        this.live.model = String(s.model ?? this.live.model ?? '')
        if (this.live.model && this.record.lastModel !== this.live.model) {
          this.record.lastModel = this.live.model
          this.deps.saveRecord(this.record)
        }
        this.live.permissionMode = s.permissionMode as PermissionMode
        this.live.cwd = String(s.cwd ?? this.record.cwd)
        this.live.claudeVersion = String(s.claude_code_version ?? '')
        if (s.effort !== undefined) this.live.effort = (s.effort as EffortLevel | null) ?? null
        const sid = String(s.session_id ?? '')
        if (sid && sid !== this.record.claudeSessionId) {
          this.deps.log(`[session ${this.id}] session id changed ${this.record.claudeSessionId} -> ${sid}`)
          this.record.claudeSessionId = sid
          this.deps.saveRecord(this.record)
        }
        if (this.live.status === 'starting') this.setStatus('running')
        break
      }
      case 'session_state_changed': {
        const state = s.state as 'idle' | 'running' | 'requires_action'
        if (state === 'idle') {
          this.live.activeTools = []
          this.live.activity = null
          if (this.live.status !== 'requires_action' || !this.live.pendingPermissions.length) this.setStatus(this.live.pendingPermissions.length ? 'requires_action' : 'idle')
        } else if (state === 'running') {
          if (!this.live.pendingPermissions.length) this.setStatus('running')
        } else if (state === 'requires_action') {
          this.setStatus('requires_action')
        }
        break
      }
      case 'status': {
        this.live.activity = (s.status as 'compacting' | 'requesting' | null) ?? null
        if (s.permissionMode) this.live.permissionMode = s.permissionMode as PermissionMode
        break
      }
      case 'background_tasks_changed': {
        const list = (s.tasks as { task_id: string; task_type: string; description: string; ambient?: boolean }[]) ?? []
        const next = new Map<string, BackgroundTaskView>()
        for (const t of list) {
          const prev = this.tasks.get(t.task_id)
          next.set(t.task_id, { ...(prev ?? { startedAt: ts }), taskId: t.task_id, taskType: t.task_type, description: t.description, ambient: t.ambient, status: prev?.status ?? 'running' })
        }
        this.tasks = next
        this.live.backgroundTasks = [...next.values()]
        break
      }
      case 'task_started': {
        const id = String(s.task_id)
        const prev = this.tasks.get(id)
        this.tasks.set(id, {
          ...(prev ?? {}),
          taskId: id,
          taskType: String(s.task_type ?? prev?.taskType ?? 'task'),
          description: String(s.description ?? prev?.description ?? ''),
          toolUseId: s.tool_use_id as string | undefined,
          ambient: Boolean(s.ambient),
          status: 'running',
          startedAt: prev?.startedAt ?? ts
        })
        this.live.backgroundTasks = [...this.tasks.values()]
        this.transcript.apply(msg, ts)
        break
      }
      case 'task_progress': {
        const id = String(s.task_id)
        const prev = this.tasks.get(id)
        if (prev) {
          prev.summary = s.summary as string | undefined
          prev.lastToolName = s.last_tool_name as string | undefined
          prev.usage = s.usage as BackgroundTaskView['usage']
          prev.description = String(s.description ?? prev.description)
          this.live.backgroundTasks = [...this.tasks.values()]
        }
        this.transcript.apply(msg, ts)
        break
      }
      case 'task_updated': {
        const id = String(s.task_id)
        const prev = this.tasks.get(id)
        const patch = (s.patch ?? {}) as Partial<BackgroundTaskView> & { status?: BackgroundTaskView['status'] }
        if (prev) {
          if (patch.status) prev.status = patch.status
          if (patch.description) prev.description = patch.description
          this.live.backgroundTasks = [...this.tasks.values()]
        }
        break
      }
      case 'task_notification': {
        const id = String(s.task_id)
        if (this.tasks.delete(id)) this.live.backgroundTasks = [...this.tasks.values()]
        this.transcript.apply(msg, ts)
        break
      }
      case 'commands_changed': {
        this.live.slashCommands = ((s.commands as { name: string; description: string; argumentHint: string; aliases?: string[] }[]) ?? []).map(toCommandView)
        break
      }
      default:
        this.transcript.apply(msg, ts)
        break
    }
  }

  private setStatus(status: SessionLiveState['status']): void {
    if (this.live.status !== status) {
      this.live.status = status
      this.stateDirty = true
    }
  }

  private refreshTitlePending = false
  private refreshTitle(): void {
    if (!this.record.autoTitle || this.refreshTitlePending) return
    this.refreshTitlePending = true
    setTimeout(async () => {
      this.refreshTitlePending = false
      try {
        const info = await getSessionInfo(this.record.claudeSessionId, { dir: this.record.cwd })
        const title = info?.customTitle || info?.summary
        if (title && title !== this.record.title) {
          this.record.title = title.slice(0, 120)
          this.deps.saveRecord(this.record)
          this.deps.emit({ type: 'record', record: this.record })
        }
      } catch {
        /* ignore */
      }
    }, 1500)
  }

  bumpUnread(): void {
    this.live.unread += 1
    this.stateDirty = true
    this.scheduleFlush()
  }

  scheduleFlush(): void {
    this.stateDirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_MS)
  }

  flush(): void {
    const { changed, removed } = this.transcript.takeChanges()
    for (const id of removed) this.deps.emit({ type: 'message-removed', sessionId: this.id, messageId: id })
    for (const m of changed) this.deps.emit({ type: 'message', sessionId: this.id, message: m })
    if (this.stateDirty) {
      this.stateDirty = false
      this.deps.emit({ type: 'state', state: { ...this.live } })
    }
  }
}

/** Build a uuid -> epoch-ms map from a transcript JSONL without parsing every line fully. */
async function readTimestamps(file: string): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return map
  }
  if (size > 200 * 1024 * 1024) return map
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  const re = /"uuid":"([0-9a-f-]{36})"[^\n]*?"timestamp":"([^"]+)"|"timestamp":"([^"]+)"[^\n]*?"uuid":"([0-9a-f-]{36})"/
  for await (const line of rl) {
    if (!line.includes('"timestamp"')) continue
    const m = re.exec(line)
    if (!m) continue
    const uuid = m[1] ?? m[4]
    const iso = m[2] ?? m[3]
    const t = Date.parse(iso)
    if (uuid && !Number.isNaN(t)) map.set(uuid, t)
  }
  return map
}

/** Sidebar-friendly wording for non-success result subtypes ("error_during_execution" → "interrupted"…). */
function humanResultSubtype(subtype: string, errors?: string[]): string {
  const joined = (errors ?? []).join(' ').toLowerCase()
  if (/interrupt|abort|cancel/.test(joined)) return 'interrupted'
  switch (subtype) {
    case 'error_during_execution':
      return joined ? `failed: ${(errors ?? [])[0]?.slice(0, 100)}` : 'interrupted'
    case 'error_max_turns':
      return 'stopped: turn limit reached'
    case 'error_max_budget_usd':
      return 'stopped: budget limit reached'
    case 'error_max_structured_output_retries':
      return 'stopped: output format retries exhausted'
    default:
      return subtype.replace(/^error_/, 'error: ').replace(/_/g, ' ')
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Timestamp of the last prompt the user typed (top-level, non-synthetic user message). */
export function lastPromptTime(messages: ChatMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'user' && !m.synthetic && !m.parentToolUseId && (m.text.trim() || m.images?.length)) return m.ts
  }
  return undefined
}

/**
 * Cheap version of the above for sessions whose history is not loaded: scan the transcript file
 * backwards, one chunk at a time, until a user message that is a real prompt (not a tool result
 * or a CLI echo) is found. Long tool-heavy sessions can have many megabytes without a prompt.
 */
export async function lastPromptTimeFromFile(file: string, chunkBytes = 1024 * 1024, maxBytes = 96 * 1024 * 1024): Promise<number | undefined> {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return undefined
  }
  const fh = await fs.promises.open(file, 'r').catch(() => null)
  if (!fh) return undefined
  try {
    let end = size
    let carry = '' // partial line at the start of the previously read (later) chunk
    let scanned = 0
    while (end > 0 && scanned < maxBytes) {
      const start = Math.max(0, end - chunkBytes)
      const buf = Buffer.alloc(end - start)
      await fh.read(buf, 0, end - start, start)
      const text = buf.toString('utf8') + carry
      const lines = text.split('\n')
      if (start > 0) carry = lines.shift() ?? ''
      else carry = ''
      let best: number | undefined
      for (const line of lines) {
        const t = promptTimeOfLine(line)
        if (t !== undefined && (best === undefined || t > best)) best = t
      }
      if (best !== undefined) return best
      scanned += end - start
      end = start
    }
    return undefined
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Epoch ms of a transcript line when it is a user prompt typed by the user; otherwise undefined. */
function promptTimeOfLine(line: string): number | undefined {
  if (!line.includes('"type":"user"') || !line.includes('"timestamp"')) return undefined
  try {
    const e = JSON.parse(line) as { type?: string; isMeta?: boolean; toolUseResult?: unknown; timestamp?: string; message?: { role?: string; content?: unknown } }
    if (e.type !== 'user' || e.isMeta || e.toolUseResult) return undefined
    const c = e.message?.content
    let text = ''
    let hasImage = false
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      let onlyResults = c.length > 0
      for (const b of c as { type?: string; text?: string }[]) {
        if (b.type === 'text') text += b.text ?? ''
        if (b.type === 'image') hasImage = true
        if (b.type !== 'tool_result') onlyResults = false
      }
      if (onlyResults) return undefined
    }
    if (!hasImage && (!text.trim() || looksSynthetic(text))) return undefined
    const t = Date.parse(e.timestamp ?? '')
    return Number.isNaN(t) ? undefined : t
  } catch {
    return undefined
  }
}

/** ~/.claude/projects/<encoded cwd> — Claude Code replaces every non-alphanumeric character with '-'. */
export function projectDirFor(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function toCommandView(c: { name: string; description: string; argumentHint: string; aliases?: string[] }): SlashCommandView {
  return { name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases }
}

function toModelView(m: { value: string; displayName: string; description: string; supportedEffortLevels?: EffortLevel[] }): ModelInfoView {
  return { value: m.value, displayName: m.displayName, description: m.description, supportedEffortLevels: m.supportedEffortLevels }
}
