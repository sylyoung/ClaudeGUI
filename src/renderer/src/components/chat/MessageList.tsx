import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage, PendingPermission, PermissionDecision } from '@shared/types'
import { MessageItem } from './MessageItem'
import { PermissionPrompt } from './PermissionPrompt'

const PAGE = 120

export function MessageList({
  sessionId,
  messages,
  pending,
  onAnswer,
  loaded
}: {
  sessionId: string
  messages: ChatMessage[]
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

  return (
    <div className="messages" ref={ref} onScroll={onScroll}>
      <div className="messages-inner">
        {hidden > 0 && (
          <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={() => setLimit((l) => l + PAGE * 2)}>
            Show {Math.min(hidden, PAGE * 2)} earlier messages ({hidden} hidden)
          </button>
        )}
        {!loaded && messages.length === 0 && <div className="faint" style={{ textAlign: 'center' }}>Loading history…</div>}
        {visible.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
        {pending.map((p) => (
          <PermissionPrompt key={p.requestId} request={p} onAnswer={(d) => onAnswer(p.requestId, d)} />
        ))}
      </div>
      {!stick && (
        <button className="jump-bottom" onClick={() => { setStick(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }}>
          <ArrowDown size={12} style={{ verticalAlign: -2 }} /> latest
        </button>
      )}
    </div>
  )
}
