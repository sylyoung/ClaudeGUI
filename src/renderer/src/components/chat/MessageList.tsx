import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage, PendingPermission, PermissionDecision, SessionLiveState } from '@shared/types'
import { MessageItem, type PromptState } from './MessageItem'
import { PermissionPrompt } from './PermissionPrompt'

const PAGE = 120

export function MessageList({
  sessionId,
  messages,
  live,
  pending,
  onAnswer,
  loaded
}: {
  sessionId: string
  messages: ChatMessage[]
  live: SessionLiveState | undefined
  pending: PendingPermission[]
  onAnswer: (requestId: string, d: PermissionDecision) => void
  loaded: boolean
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

  // What happened to each prompt you typed. The ones Claude has not taken yet (queuedCount of them,
  // newest last) are shown together at the bottom instead of where they were typed, so a prompt you
  // sent in the middle of a turn does not disappear upwards under the output of the earlier one.
  const busy = live?.status === 'running' || live?.status === 'requires_action' || live?.status === 'starting'
  const { promptState, queuedIds } = useMemo(() => {
    const promptState = new Map<string, PromptState>()
    const queuedIds = new Set<string>()
    let lastResult = -1
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].kind === 'result') { lastResult = i; break }
    const userIdx: number[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.kind === 'user' && !m.synthetic) userIdx.push(i)
    }
    const waiting = Math.min(live?.queuedCount ?? 0, userIdx.length)
    for (let k = 0; k < userIdx.length; k++) {
      const i = userIdx[k]
      const m = messages[i]
      const state: PromptState = k < waiting ? 'queued' : i < lastResult ? 'answered' : busy ? 'working' : 'sent'
      promptState.set(m.id, state)
      if (state === 'queued') queuedIds.add(m.id)
    }
    return { promptState, queuedIds }
  }, [messages, live?.queuedCount, busy])
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
        {pending.map((p) => (
          <PermissionPrompt key={p.requestId} request={p} onAnswer={(d) => onAnswer(p.requestId, d)} />
        ))}
        {queued.length > 0 && (
          <div className="queued-block" data-tip="Prompts Claude has not taken yet. They stay here, at the end of the chat, until the current turn finishes.">
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
