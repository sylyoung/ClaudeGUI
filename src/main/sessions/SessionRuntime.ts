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
  BackgroundTaskView,
  ChatMessage,
  EffortLevel,
  ImageAttachment,
  ModelInfoView,
  PendingPermission,
  PermissionDecision,
  PermissionMode,
  SessionEvent,
  SessionLiveState,
  SessionRecord,
  SlashCommandView
} from '@shared/types'
import { TranscriptState } from './transcript'

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

export interface RuntimeDeps {
  getEnv(): Promise<Record<string, string>>
  getExecutable(): string | undefined
  emit(event: SessionEvent): void
  saveRecord(record: SessionRecord): void
  onTurnFinished(rt: SessionRuntime, preview: string, isError: boolean): void
  onNeedsAttention(rt: SessionRuntime, request: PendingPermission): void
  onExit(rt: SessionRuntime, error?: string): void
  log(...args: unknown[]): void
}

const FLUSH_MS = 45

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
  private processCostSeen = 0

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
      queuedCount: 0
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
    const options: Options = {
      cwd: this.record.cwd,
      model: this.record.model || undefined,
      permissionMode: mode,
      allowDangerouslySkipPermissions: mode === 'bypassPermissions' ? true : undefined,
      effort: this.record.effort || undefined,
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: (toolName, input, opts) => this.handleCanUseTool(toolName, input, opts),
      env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'ClaudeGUI/0.1.0' },
      stderr: (data) => this.deps.log(`[claude ${this.id.slice(0, 8)} stderr] ${data.trimEnd()}`),
      abortController: (this.abort = new AbortController())
    }
    const exe = this.deps.getExecutable()
    if (exe) options.pathToClaudeCodeExecutable = exe
    if (resume) options.resume = this.record.claudeSessionId
    else {
      options.sessionId = this.record.claudeSessionId
      if (this.record.title && !this.record.autoTitle) options.title = this.record.title
    }
    this.queue = new AsyncQueue<SDKUserMessage>()
    const q = query({ prompt: this.queue, options })
    this.q = q
    this.live.processAlive = true
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
      this.live.queuedCount = 0
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

  async interrupt(): Promise<void> {
    if (!this.q) return
    try {
      await this.q.interrupt()
    } catch (err) {
      this.deps.log(`[session ${this.id}] interrupt failed: ${(err as Error).message}`)
    }
  }

  // ------------------------------------------------------------------ input

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
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
    if (this.live.status === 'running' || this.live.status === 'requires_action') this.live.queuedCount += 1
    else this.setStatus('running')
    this.queue.push(message)
    this.record.lastActiveAt = Date.now()
    this.live.lastActivityAt = this.record.lastActiveAt
    this.live.lastPreview = text.slice(0, 120)
    this.deps.saveRecord(this.record)
    this.scheduleFlush()
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

  async getContextUsage(): Promise<unknown> {
    if (!this.q) return null
    return this.q.getContextUsage({ detail: 'summary' })
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
      case 'stream_event': {
        this.transcript.apply(msg, ts)
        if (msg.event.type === 'message_start' && this.live.status !== 'requires_action') this.setStatus('running')
        break
      }
      case 'assistant': {
        this.transcript.apply(msg, ts)
        if (this.live.status === 'idle' || this.live.status === 'starting') this.setStatus('running')
        const usage = msg.message.usage as unknown as Record<string, number> | undefined
        if (usage && !msg.parent_tool_use_id) {
          const ctx = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
          if (ctx > 0) this.live.contextTokens = ctx
        }
        for (const b of msg.message.content) {
          if (b.type === 'text' && !msg.parent_tool_use_id && b.text.trim()) this.lastAssistantText = b.text
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
        if (this.live.queuedCount > 0) this.live.queuedCount -= 1
        const queued = (msg as { queued_turn_count?: number }).queued_turn_count ?? this.live.queuedCount
        if (queued > 0) this.setStatus('running')
        else if (this.live.status !== 'requires_action') this.setStatus('idle')
        const preview = msg.subtype === 'success' ? msg.result : `${msg.subtype}`
        const text = (this.lastAssistantText || preview || '').trim()
        this.live.lastPreview = text.replace(/\s+/g, ' ').slice(0, 140)
        this.record.lastActiveAt = ts
        this.deps.saveRecord(this.record)
        this.deps.onTurnFinished(this, this.live.lastPreview, Boolean(msg.is_error) || msg.subtype !== 'success')
        this.refreshTitle()
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
    switch (s.subtype) {
      case 'init': {
        this.live.model = String(s.model ?? this.live.model ?? '')
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
