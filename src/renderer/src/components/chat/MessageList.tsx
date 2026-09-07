import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage, PendingPermission, PermissionDecision, SessionLiveState } from '@shared/types'
import { MessageItem, type PromptState } from './MessageItem'
import { PermissionPrompt } from './PermissionPrompt'
import { WorkingStrip } from './WorkingStrip'

const PAGE = 120

export function MessageList({
  sessionId,
  messages,
  live,
  pending,
  onAnswer,
  loaded,
  working,
  turnStartedAt
}: {
  sessionId: string
  messages: ChatMessage[]
  live: SessionLiveState | undefined
  pending: PendingPermission[]
  onAnswer: (requestId: string, d: PermissionDecision) => void
  loaded: boolean
  /** A turn is running: what Claude is doing right now is shown as the last row of the chat. */
  working: boolean
  turnStartedAt: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const [limit, setLimit] = useState(PAGE)
  const prevSession = useRef(sessionId)

  useEffect(() => {
    if (prevSession.current !== sessionId) {
      prevSession.current = sessionId
      setLimit(PAGE)
      setStick(true)
    }
  }, [sessionId])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setStick(dist < 80)
  }, [])

  useLayoutEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  })

  const visible = messages.length > limit ? messages.slice(messages.length - limit) : messages
  const hidden = messages.length - visible.length

  // What happened to each prompt you typed. The ones Claude has not taken off its queue yet are
  // shown together at the bottom instead of where they were typed, so a prompt you sent in the
  // middle of a turn does not disappear upwards under the output of the earlier one. When Claude
  // takes one, the host moves it to the end of the chat, so it leaves the waiting block and
  // reappears here, directly above the answer it starts.
  const busy = live?.status === 'running' || live?.status === 'requires_action' || live?.status === 'starting'
  const { promptState, queuedIds } = useMemo(() => {
    const promptState = new Map<string, PromptState>()
    // What Claude Code itself says it has done with each prompt this app sent: still in its queue,
    // or taken by the turn it is running.
    const delivery = live?.promptDelivery ?? {}
    const queuedIds = new Set(Object.keys(delivery).filter((id) => delivery[id] === 'queued'))
    let lastPrompt = -1
    for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.kind === 'user' && !m.synthetic) { lastPrompt = i; break } }
    // Prompts Claude Code says nothing about were sent by an earlier run of the app and read back
    // from its record. Their state comes from what followed them, up to the next prompt: an answer
    // of Claude's own means the prompt was answered, the notice Claude Code writes when a turn is
    // stopped means it was not. The turn footers this app draws are not part of that record, so
    // the answer itself has to be the evidence.
    let openId: string | null = null
    let openIndex = -1
    let answered = false
    let stopped = false
    const settle = (): void => {
      if (openId === null) return
      const known = delivery[openId]
      // Only the newest prompt can be the one a running turn is answering.
      promptState.set(openId, known ?? (busy && openIndex === lastPrompt ? 'working' : stopped || !answered ? 'sent' : 'answered'))
      openId = null
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m.kind === 'user' && !m.synthetic) {
        settle()
        openId = m.id
        openIndex = i
        answered = false
        stopped = false
      } else if (openId === null) continue
      else if (m.kind === 'user') stopped = stopped || m.text.startsWith('[Request interrupted')
      else if (m.kind === 'result') answered = true
      else if (m.kind === 'assistant' && !m.parentToolUseId) answered = true
    }
    settle()
    return { promptState, queuedIds }
  }, [messages, live?.promptDelivery, busy])
  const queued = visible.filter((m) => queuedIds.has(m.id))
  const flow = queuedIds.size ? visible.filter((m) => !queuedIds.has(m.id)) : visible

  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      <div className="messages-inner">
        {hidden > 0 && (
          <button data-tip="Show earlier messages" className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => setLimit((l) => l + PAGE * 2)}>
            Show {Math.min(hidden, PAGE * 2)} earlier messages ({hidden} hidden)
          </button>
        )}
        {!loaded && messages.length === 0 && <div className="faint" style={{ textAlign: 'center' }}>Loading history…</div>}
        {flow.map((m) => (
          <MessageItem key={m.id} message={m} state={promptState.get(m.id)} />
        ))}
        {working && <WorkingStrip live={live} since={turnStartedAt} />}
        {pending.map((p) => (
          <PermissionPrompt key={p.requestId} request={p} onAnswer={(d) => onAnswer(p.requestId, d)} />
        ))}
        {queued.length > 0 && (
          <div className="queued-block" data-tip="Prompts Claude has not taken yet. They stay here, at the end of the chat, until the current turn finishes. ↑ in the input box, or the take-back button on a prompt, pulls one out of the queue again.">
            <div className="queued-head">
              <span className="pmark">⋯</span> {queued.length} prompt{queued.length === 1 ? '' : 's'} waiting — sent when the current turn ends
            </div>
            {queued.map((m) => (
              <MessageItem key={m.id} message={m} state="queued" />
            ))}
          </div>
        )}
      </div>
      {!stick && (
        <button data-tip="Jump to the newest message and follow new output" className="jump-bottom" onClick={() => { setStick(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }}>
          <ArrowDown size={12} style={{ verticalAlign: -2 }} /> latest
        </button>
      )}
    </div>
  )
}
