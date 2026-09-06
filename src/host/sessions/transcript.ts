/**
 * Pure transcript reducer: folds Claude Agent SDK messages (live stream or replayed history)
 * into the renderer-facing ChatMessage model. No I/O here.
 */
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  SDKUserMessageReplay
} from '@anthropic-ai/claude-agent-sdk'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  AssistantChatMessage,
  AssistantBlockView,
  ChatMessage,
  ImageAttachment,
  ResultChatMessage,
  SystemChatMessage,
  ToolUseBlockView,
  TurnStats,
  UserChatMessage
} from '@shared/types'

let toolResultMaxChars = 60_000

/** Tool results longer than this are truncated in the middle (configurable in Settings → Advanced). */
export function setToolResultMaxChars(n: number): void {
  toolResultMaxChars = Math.max(2_000, Math.floor(n) || 60_000)
}

function now(): number {
  return Date.now()
}

function truncateMiddle(text: string, max = toolResultMaxChars): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.floor(max * 0.7))
  const tail = text.slice(-Math.floor(max * 0.3))
  return `${head}\n\n… [${(text.length - max).toLocaleString()} characters truncated by ClaudeGUI] …\n\n${tail}`
}

type AnyBlock = { type: string; [k: string]: unknown }

interface ToolRef {
  block: ToolUseBlockView
  /** Top-level chat message that must be re-sent when this block changes. */
  top: ChatMessage
}

export class TranscriptState {
  messages: ChatMessage[] = []
  /** ids of top-level messages changed since the last flush */
  changed = new Set<string>()
  removed = new Set<string>()

  private topById = new Map<string, ChatMessage>()
  private tools = new Map<string, ToolRef>()
  /** assistant message id -> the (possibly nested) assistant message + its top-level owner */
  private assistants = new Map<string, { msg: AssistantChatMessage; top: ChatMessage }>()
  private finalized = new Map<string, number>()
  /** uuids of user messages the GUI itself inserted (so replays are not duplicated) */
  private localUserUuids = new Set<string>()
  private orphanResults = new Map<string, { content: string; images?: ImageAttachment[]; isError: boolean; structured?: unknown; ts: number }>()
  private seq = 0

  reset(): void {
    this.messages = []
    this.changed.clear()
    this.removed.clear()
    this.topById.clear()
    this.tools.clear()
    this.assistants.clear()
    this.finalized.clear()
    this.orphanResults.clear()
  }

  takeChanges(): { changed: ChatMessage[]; removed: string[] } {
    const changed: ChatMessage[] = []
    for (const id of this.changed) {
      const m = this.topById.get(id)
      if (m) changed.push(m)
    }
    const removed = [...this.removed]
    this.changed.clear()
    this.removed.clear()
    return { changed, removed }
  }

  private touch(top: ChatMessage): void {
    this.changed.add(top.id)
  }

  private addTop(msg: ChatMessage): void {
    this.messages.push(msg)
    this.topById.set(msg.id, msg)
    this.touch(msg)
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${now().toString(36)}-${this.seq}`
  }

  // ---------------------------------------------------------------- user side

  /** Insert the user's own prompt immediately (before the CLI echoes it back). */
  addLocalUserMessage(uuid: string, text: string, images?: ImageAttachment[]): UserChatMessage {
    this.localUserUuids.add(uuid)
    const msg: UserChatMessage = { kind: 'user', id: uuid, ts: now(), text, images, parentToolUseId: null }
    this.addTop(msg)
    return msg
  }

  removeMessage(id: string): void {
    const idx = this.messages.findIndex((m) => m.id === id)
    if (idx < 0) return
    this.messages.splice(idx, 1)
    this.topById.delete(id)
    this.changed.delete(id)
    this.removed.add(id)
  }

  // ---------------------------------------------------------------- SDK entry

  apply(sdk: SDKMessage, ts: number = now()): void {
    switch (sdk.type) {
      case 'stream_event':
        this.applyStreamEvent(sdk, ts)
        break
      case 'assistant':
        this.applyAssistant(sdk, ts)
        break
      case 'user':
        this.applyUser(sdk, ts)
        break
      case 'result':
        this.applyResult(sdk, ts)
        break
      case 'system':
        this.applySystem(sdk as SDKMessage & { type: 'system' }, ts)
        break
      case 'tool_progress':
        this.markToolRunning(sdk.tool_use_id)
        break
      default:
        break
    }
  }

  // ------------------------------------------------------------- streaming

  private streamingByParent = new Map<string, string>()

  private applyStreamEvent(sdk: SDKPartialAssistantMessage, ts: number): void {
    const ev = sdk.event as BetaRawMessageStreamEvent
    const parentKey = sdk.parent_tool_use_id ?? '__main__'
    switch (ev.type) {
      case 'message_start': {
        const m = ev.message
        const entry = this.getOrCreateAssistant(m.id, sdk.parent_tool_use_id, ts, m.model)
        entry.msg.streaming = true
        this.streamingByParent.set(parentKey, m.id)
        this.touch(entry.top)
        break
      }
      case 'content_block_start': {
        const entry = this.currentAssistant(parentKey, ts, sdk.parent_tool_use_id)
        if (!entry) return
        const cb = ev.content_block as unknown as AnyBlock
        const block = this.viewBlockFromApi(cb, ts, true)
        if (!block) return
        // Keep block positions aligned with the API index when possible.
        while (entry.msg.blocks.length < ev.index) entry.msg.blocks.push({ type: 'text', text: '' })
        entry.msg.blocks[ev.index] = block
        if (block.type === 'tool_use') this.tools.set(block.id, { block, top: entry.top })
        this.touch(entry.top)
        break
      }
      case 'content_block_delta': {
        const entry = this.currentAssistant(parentKey, ts, sdk.parent_tool_use_id)
        if (!entry) return
        const block = entry.msg.blocks[ev.index]
        if (!block) return
        const delta = ev.delta as unknown as AnyBlock
        if (delta.type === 'text_delta' && block.type === 'text') block.text += String(delta.text ?? '')
        else if (delta.type === 'thinking_delta' && block.type === 'thinking') block.text += String(delta.thinking ?? '')
        else if (delta.type === 'input_json_delta' && block.type === 'tool_use') block.partialJson = (block.partialJson ?? '') + String(delta.partial_json ?? '')
        else return
        this.touch(entry.top)
        break
      }
      case 'content_block_stop': {
        const entry = this.currentAssistant(parentKey, ts, sdk.parent_tool_use_id)
        if (!entry) return
        const block = entry.msg.blocks[ev.index]
        if (block?.type === 'tool_use' && block.status === 'streaming') {
          block.input = safeParseJson(block.partialJson) ?? block.input
          block.partialJson = undefined
          block.status = 'pending'
          this.touch(entry.top)
        }
        break
      }
      case 'message_delta': {
        const entry = this.currentAssistant(parentKey, ts, sdk.parent_tool_use_id)
        if (!entry) return
        const d = ev.delta as unknown as AnyBlock
        if (d.stop_reason) entry.msg.stopReason = String(d.stop_reason)
        break
      }
      case 'message_stop': {
        const entry = this.currentAssistant(parentKey, ts, sdk.parent_tool_use_id)
        if (!entry) return
        entry.msg.streaming = false
        this.streamingByParent.delete(parentKey)
        this.touch(entry.top)
        break
      }
    }
  }

  private currentAssistant(parentKey: string, ts: number, parentToolUseId: string | null) {
    const id = this.streamingByParent.get(parentKey)
    if (id) {
      const e = this.assistants.get(id)
      if (e) return e
    }
    // Stream started without message_start (should not happen) — create a placeholder.
    const entry = this.getOrCreateAssistant(this.nextId('asst'), parentToolUseId, ts)
    this.streamingByParent.set(parentKey, entry.msg.id)
    return entry
  }

  // ------------------------------------------------------------- assistant

  private getOrCreateAssistant(id: string, parentToolUseId: string | null, ts: number, model?: string) {
    const existing = this.assistants.get(id)
    if (existing) {
      if (model && !existing.msg.model) existing.msg.model = model
      return existing
    }
    const msg: AssistantChatMessage = {
      kind: 'assistant',
      id,
      ts,
      model,
      blocks: [],
      streaming: true,
      parentToolUseId
    }
    let top: ChatMessage
    if (parentToolUseId) {
      const ref = this.tools.get(parentToolUseId)
      if (ref) {
        ref.block.children = ref.block.children ?? []
        ref.block.children.push(msg)
        top = ref.top
        this.touch(top)
      } else {
        this.addTop(msg)
        top = msg
      }
    } else {
      this.addTop(msg)
      top = msg
    }
    const entry = { msg, top }
    this.assistants.set(id, entry)
    return entry
  }

  private viewBlockFromApi(cb: AnyBlock, ts: number, streaming: boolean): AssistantBlockView | null {
    switch (cb.type) {
      case 'text':
        return { type: 'text', text: String(cb.text ?? '') }
      case 'thinking':
        return { type: 'thinking', text: String(cb.thinking ?? '') }
      case 'redacted_thinking':
        return { type: 'thinking', text: '' }
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use': {
        const input = (cb.input && typeof cb.input === 'object' ? (cb.input as Record<string, unknown>) : {}) as Record<string, unknown>
        return {
          type: 'tool_use',
          id: String(cb.id),
          name: String(cb.name ?? 'tool'),
          input,
          partialJson: streaming ? '' : undefined,
          status: streaming ? 'streaming' : 'pending',
          startedAt: ts
        }
      }
      default:
        return null
    }
  }

  private applyAssistant(sdk: SDKAssistantMessage, ts: number): void {
    const api = sdk.message
    const entry = this.getOrCreateAssistant(api.id, sdk.parent_tool_use_id, ts, api.model)
    const msg = entry.msg
    if (sdk.subagent_type) msg.subagentType = sdk.subagent_type
    if (sdk.error) msg.error = sdk.error
    if (sdk.aborted) {
      msg.aborted = true
      msg.streaming = false
    }
    if (api.stop_reason) {
      msg.stopReason = api.stop_reason
    }
    const content = Array.isArray(api.content) ? (api.content as unknown as AnyBlock[]) : []
    let pos = this.finalized.get(api.id) ?? 0
    for (const cb of content) {
      const view = this.viewBlockFromApi(cb, ts, false)
      if (!view) continue
      if (view.type === 'tool_use') {
        const ref = this.tools.get(view.id)
        if (ref && ref.block !== view) {
          ref.block.input = view.input
          ref.block.name = view.name
          ref.block.partialJson = undefined
          if (ref.block.status === 'streaming') ref.block.status = 'pending'
          // make sure position accounting stays aligned
          const idx = msg.blocks.indexOf(ref.block)
          pos = Math.max(pos, idx + 1)
          continue
        }
      }
      const existing = msg.blocks[pos]
      if (existing && existing.type === view.type) {
        if (view.type === 'tool_use' && existing.type === 'tool_use') {
          existing.input = view.input
          existing.name = view.name
          existing.partialJson = undefined
          if (existing.status === 'streaming') existing.status = 'pending'
          this.tools.set(existing.id, { block: existing, top: entry.top })
        } else if (view.type === 'text' && existing.type === 'text') {
          existing.text = view.text
        } else if (view.type === 'thinking' && existing.type === 'thinking') {
          existing.text = view.text
        }
      } else {
        msg.blocks.splice(pos, 0, view)
        if (view.type === 'tool_use') this.tools.set(view.id, { block: view, top: entry.top })
      }
      pos += 1
    }
    this.finalized.set(api.id, pos)
    // Finalised messages replayed from history are never "streaming".
    if (!sdk.parent_tool_use_id && (api.stop_reason || msg.aborted)) msg.streaming = false
    // Attach orphan tool results that arrived before their tool_use (history edge case).
    for (const b of msg.blocks) {
      if (b.type === 'tool_use' && !b.result && this.orphanResults.has(b.id)) {
        const r = this.orphanResults.get(b.id)!
        this.orphanResults.delete(b.id)
        b.result = { content: r.content, images: r.images, isError: r.isError, structured: r.structured, receivedAt: r.ts }
        b.status = r.isError ? 'error' : 'done'
      }
    }
    this.touch(entry.top)
  }

  // ------------------------------------------------------------------ user

  private applyUser(sdk: SDKUserMessage | SDKUserMessageReplay, ts: number): void {
    const uuid = (sdk as SDKUserMessageReplay).uuid
    if (uuid && this.localUserUuids.has(uuid)) {
      const local = this.topById.get(uuid)
      if (local && local.kind === 'user') {
        // Keep our optimistic copy; nothing else to do.
      }
      return
    }
    const message = sdk.message as { role: string; content: string | AnyBlock[] }
    const content = message.content
    const parentToolUseId = sdk.parent_tool_use_id
    if (typeof content === 'string') {
      this.addUserText(uuid ?? this.nextId('user'), content, [], ts, parentToolUseId, Boolean(sdk.isSynthetic))
      return
    }
    if (!Array.isArray(content)) return
    const texts: string[] = []
    const images: ImageAttachment[] = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        this.attachToolResult(String(block.tool_use_id), block, Boolean(block.is_error), sdk.tool_use_result, ts)
      } else if (block.type === 'text') {
        texts.push(String(block.text ?? ''))
      } else if (block.type === 'image') {
        const img = imageFromBlock(block)
        if (img) images.push(img)
      } else if (block.type === 'document') {
        texts.push('[document attachment]')
      }
    }
    if (texts.length || images.length) {
      this.addUserText(uuid ?? this.nextId('user'), texts.join('\n\n'), images, ts, parentToolUseId, Boolean(sdk.isSynthetic))
    }
  }

  private addUserText(id: string, text: string, images: ImageAttachment[], ts: number, parentToolUseId: string | null, synthetic: boolean): void {
    const msg: UserChatMessage = {
      kind: 'user',
      id,
      ts,
      text,
      images: images.length ? images : undefined,
      synthetic: synthetic || looksSynthetic(text),
      parentToolUseId
    }
    if (parentToolUseId) {
      const ref = this.tools.get(parentToolUseId)
      if (ref) {
        ref.block.children = ref.block.children ?? []
        ref.block.children.push(msg)
        this.touch(ref.top)
        return
      }
    }
    if (this.topById.has(id)) return
    this.addTop(msg)
  }

  private attachToolResult(toolUseId: string, block: AnyBlock, isError: boolean, structured: unknown, ts: number): void {
    const { text, images } = flattenToolResultContent(block.content)
    const ref = this.tools.get(toolUseId)
    if (!ref) {
      this.orphanResults.set(toolUseId, { content: truncateMiddle(text), images, isError, structured, ts })
      return
    }
    ref.block.result = { content: truncateMiddle(text), images, isError, structured, receivedAt: ts }
    ref.block.status = isError ? 'error' : 'done'
    if (isError && /permission|denied|rejected|user declined/i.test(text.slice(0, 200))) ref.block.status = 'denied'
    this.touch(ref.top)
  }

  hasTool(toolUseId: string): boolean {
    return this.tools.has(toolUseId)
  }

  toolChildCount(toolUseId: string): number {
    return this.tools.get(toolUseId)?.block.children?.length ?? 0
  }

  markToolRunning(toolUseId: string): void {
    const ref = this.tools.get(toolUseId)
    if (!ref) return
    if (ref.block.status === 'pending' || ref.block.status === 'streaming') {
      ref.block.status = 'running'
      this.touch(ref.top)
    }
  }

  markToolDenied(toolUseId: string): void {
    const ref = this.tools.get(toolUseId)
    if (!ref) return
    ref.block.status = 'denied'
    this.touch(ref.top)
  }

  updateTask(
    toolUseId: string | undefined,
    patch: Partial<NonNullable<ToolUseBlockView['task']>> & { taskId: string }
  ): void {
    if (!toolUseId) return
    const ref = this.tools.get(toolUseId)
    if (!ref) return
    ref.block.task = { ...(ref.block.task ?? { taskId: patch.taskId }), ...patch }
    this.touch(ref.top)
  }

  // ---------------------------------------------------------------- result

  private applyResult(sdk: SDKResultMessage, ts: number): void {
    // Any message still marked streaming is finished now.
    for (const e of this.assistants.values()) {
      if (e.msg.streaming) {
        e.msg.streaming = false
        this.touch(e.top)
      }
    }
    this.streamingByParent.clear()
    const usage = (sdk.usage ?? {}) as unknown as Record<string, number>
    const stats: TurnStats = {
      costUsd: sdk.total_cost_usd ?? 0,
      durationMs: sdk.duration_ms ?? 0,
      numTurns: sdk.num_turns ?? 0,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      isError: Boolean(sdk.is_error),
      endedAt: ts
    }
    let errorText: string | undefined
    if (sdk.subtype !== 'success') {
      const errs = (sdk.errors ?? []).filter((e) => !e.startsWith('[ede_diagnostic]'))
      const last = this.messages[this.messages.length - 1]
      const interrupted = last?.kind === 'user' && last.text.startsWith('[Request interrupted')
      errorText = errs.length ? `${sdk.subtype}: ${errs.join('; ')}` : interrupted ? 'interrupted' : sdk.subtype
    } else if (sdk.is_error) {
      errorText = sdk.result
    }
    const msg: ResultChatMessage = { kind: 'result', id: sdk.uuid || this.nextId('result'), ts, stats, errorText }
    this.addTop(msg)
  }

  // ---------------------------------------------------------------- system

  private applySystem(sdk: SDKMessage & { type: 'system' }, ts: number): void {
    const s = sdk as unknown as Record<string, unknown> & { subtype: string; uuid?: string }
    const id = (s.uuid as string) || this.nextId('sys')
    const add = (level: SystemChatMessage['level'], text: string, data?: Record<string, unknown>) => {
      const m: SystemChatMessage = { kind: 'system', id, ts, subtype: s.subtype, level, text, data }
      this.addTop(m)
    }
    switch (s.subtype) {
      case 'compact_boundary': {
        const meta = (s.compact_metadata ?? {}) as Record<string, unknown>
        const pre = Number(meta.pre_tokens ?? 0)
        const post = meta.post_tokens != null ? Number(meta.post_tokens) : undefined
        add('notice', `Context compacted (${meta.trigger ?? 'auto'}): ${pre.toLocaleString()} tokens${post != null ? ` → ${post.toLocaleString()}` : ''}`)
        break
      }
      case 'informational': {
        const level = (s.level as string) === 'warning' ? 'warning' : (s.level as string) === 'suggestion' ? 'suggestion' : 'notice'
        add(level, String(s.content ?? ''))
        break
      }
      case 'notification':
        add(s.priority === 'high' || s.priority === 'immediate' ? 'warning' : 'notice', String(s.text ?? ''))
        break
      case 'local_command_output':
        add('info', String(s.content ?? ''), { markdown: true })
        break
      case 'api_retry':
        add('warning', `API retry ${s.attempt}/${s.max_retries} (${s.error ?? 'error'}${s.error_status ? ' ' + s.error_status : ''}), waiting ${Math.round(Number(s.retry_delay_ms ?? 0) / 1000)}s`)
        break
      case 'permission_denied': {
        const toolUseId = String(s.tool_use_id ?? '')
        this.markToolDenied(toolUseId)
        add('notice', `Permission denied for ${s.tool_name}${s.decision_reason ? ': ' + s.decision_reason : ''}`)
        break
      }
      case 'model_refusal_fallback':
        add('warning', String(s.content ?? `Model refusal: retried on ${s.fallback_model}`))
        break
      case 'model_refusal_no_fallback':
        add('warning', String(s.content ?? 'The model refused this request.'))
        break
      case 'task_started':
        this.updateTask(s.tool_use_id as string | undefined, {
          taskId: String(s.task_id),
          description: s.description as string,
          subagentType: s.subagent_type as string | undefined,
          status: 'running',
          isBackgrounded: Boolean(s.is_backgrounded)
        })
        break
      case 'task_progress':
        this.updateTask(s.tool_use_id as string | undefined, {
          taskId: String(s.task_id),
          description: s.description as string,
          subagentType: s.subagent_type as string | undefined,
          summary: s.summary as string | undefined,
          lastToolName: s.last_tool_name as string | undefined,
          usage: s.usage as ToolUseBlockView['task'] extends infer T ? (T extends { usage?: infer U } ? U : never) : never
        })
        break
      case 'task_notification':
        this.updateTask(s.tool_use_id as string | undefined, {
          taskId: String(s.task_id),
          status: s.status as 'completed' | 'failed' | 'stopped',
          summary: s.summary as string | undefined,
          outputFile: s.output_file as string | undefined,
          usage: s.usage as ToolUseBlockView['task'] extends infer T ? (T extends { usage?: infer U } ? U : never) : never
        })
        break
      default:
        break
    }
  }

  // --------------------------------------------------------------- history

  /** Feed a replayed history entry (from getSessionMessages) through the same reducer. */
  applyHistoryEntry(entry: { type: string; uuid: string; message: unknown; parent_tool_use_id: string | null }, ts: number): void {
    if (entry.type === 'assistant') {
      const api = entry.message as SDKAssistantMessage['message']
      if (!api || typeof api !== 'object') return
      this.applyAssistant(
        { type: 'assistant', message: api, parent_tool_use_id: entry.parent_tool_use_id, uuid: entry.uuid as never, session_id: '' },
        ts
      )
      // history entries are complete
      const e = this.assistants.get(api.id)
      if (e) e.msg.streaming = false
    } else if (entry.type === 'user') {
      const m = entry.message as { role?: string; content?: unknown }
      if (!m || typeof m !== 'object') return
      this.applyUser(
        {
          type: 'user',
          message: m as never,
          parent_tool_use_id: entry.parent_tool_use_id,
          uuid: entry.uuid as never,
          session_id: '',
          isReplay: true
        },
        ts
      )
    } else if (entry.type === 'system') {
      const m = entry.message as Record<string, unknown> | undefined
      const subtype = (m?.subtype as string) || (entry as Record<string, unknown>).subtype
      if (subtype) {
        this.applySystem({ ...(m ?? {}), ...(entry as object), type: 'system', subtype } as never, ts)
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

function safeParseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function imageFromBlock(block: AnyBlock): ImageAttachment | null {
  const src = block.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined
  if (!src) return null
  if (src.type === 'base64' && src.data) return { mediaType: src.media_type ?? 'image/png', data: src.data }
  return null
}

export function flattenToolResultContent(content: unknown): { text: string; images?: ImageAttachment[] } {
  if (content == null) return { text: '' }
  if (typeof content === 'string') return { text: content }
  if (Array.isArray(content)) {
    const parts: string[] = []
    const images: ImageAttachment[] = []
    for (const c of content as AnyBlock[]) {
      if (!c || typeof c !== 'object') continue
      if (c.type === 'text') parts.push(String(c.text ?? ''))
      else if (c.type === 'image') {
        const img = imageFromBlock(c)
        if (img) images.push(img)
      } else if (c.type === 'resource_link') parts.push(`[resource] ${c.uri}`)
      else parts.push(JSON.stringify(c))
    }
    return { text: parts.join('\n'), images: images.length ? images : undefined }
  }
  return { text: JSON.stringify(content) }
}

/** Text of a user-role message that the CLI generated itself (task notifications, command echoes…). */
export function looksSynthetic(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('<task-notification>') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<local-command-') ||
    t.startsWith('[Request interrupted') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<bash-input>') ||
    t.startsWith('<bash-stdout>') ||
    t.startsWith('<monitor-notification>') ||
    t.startsWith('<background-task') ||
    t.startsWith('<cron-')
  )
}
