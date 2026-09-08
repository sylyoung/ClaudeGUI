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

  // What has happened to each prompt you typed. There are two states and no others. A prompt
  // Claude Code has not taken yet is queued: it waits at the very end of the chat, below the answer
  // being written, and can be pulled back into the input box. A prompt Claude Code has taken is
  // registered, and the host moves it down to sit directly above the answer it started, so it
  // leaves the waiting block and reappears in the conversation itself.
  const { promptState, queuedIds } = useMemo(() => {
    // What Claude Code itself says it has done with each prompt this app sent. A prompt it says
    // nothing about — read back from its own record, or already answered — has been taken.
    const delivery = live?.promptDelivery ?? {}
    const queuedIds = new Set(Object.keys(delivery).filter((id) => delivery[id] === 'queued'))
    const promptState = new Map<string, PromptState>()
    for (const m of messages) {
      if (m.kind !== 'user' || m.synthetic) continue
      promptState.set(m.id, queuedIds.has(m.id) ? 'queued' : 'registered')
    }
    return { promptState, queuedIds }
  }, [messages, live?.promptDelivery])
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
