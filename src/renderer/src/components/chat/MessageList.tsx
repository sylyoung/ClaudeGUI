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
  turnStartedAt,
  earlierAvailable,
  earlierBusy,
  onLoadEarlier
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
  /** The chat's transcript holds more than what is loaded, further back than the first row here. */
  earlierAvailable: boolean
  /** That part is being read right now. */
  earlierBusy: boolean
  onLoadEarlier: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const [limit, setLimit] = useState(PAGE)
  const prevSession = useRef(sessionId)
  /** The chat has been scrolled back at least once, so saying where it begins means something. */
  const [paged, setPaged] = useState(false)
  const loadedAt = useRef(0)

  useEffect(() => {
    if (prevSession.current !== sessionId) {
      prevSession.current = sessionId
      setLimit(PAGE)
      setStick(true)
      setPaged(false)
    }
  }, [sessionId])

  const visible = messages.length > limit ? messages.slice(messages.length - limit) : messages
  const hidden = messages.length - visible.length

  /**
   * Reach further back: first through what the window already holds, then — when that is all on
   * screen — into the chat's transcript, which is read from the end and only as far back as it is
   * looked at.
   */
  const showEarlier = useCallback(() => {
    setPaged(true)
    if (messages.length > limit) {
      setLimit((l) => l + PAGE * 2)
      return
    }
    if (!earlierAvailable || earlierBusy || Date.now() - loadedAt.current < 400) return
    loadedAt.current = Date.now()
    onLoadEarlier()
  }, [messages.length, limit, earlierAvailable, earlierBusy, onLoadEarlier])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setStick(dist < 80)
    // Scrolling to the top of a chat is the request for what came before it.
    if (el.scrollTop < 240) showEarlier()
  }, [showEarlier])

  // Following the newest message, and — when reading further back instead — keeping the row that
  // was under the eye where it was: rows added above would otherwise push the chat down.
  const firstShown = useRef<string | undefined>(undefined)
  const lastHeight = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const first = visible[0]?.id
    if (stick) el.scrollTop = el.scrollHeight
    else if (first !== firstShown.current && el.scrollHeight > lastHeight.current) el.scrollTop += el.scrollHeight - lastHeight.current
    firstShown.current = first
    lastHeight.current = el.scrollHeight
  })

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
        {earlierBusy && <div className="faint" style={{ textAlign: 'center' }}>Reading earlier messages…</div>}
        {!earlierBusy && (hidden > 0 || earlierAvailable) && (
          <button
            data-tip={hidden > 0 ? 'Show earlier messages' : "Read further back in this chat's transcript. Scrolling to the top does the same."}
            className="btn ghost"
            style={{ alignSelf: 'center' }}
            onClick={showEarlier}
          >
            {hidden > 0 ? `Show ${Math.min(hidden, PAGE * 2)} earlier messages (${hidden} hidden)` : 'Show earlier messages'}
          </button>
        )}
        {!earlierBusy && paged && hidden === 0 && !earlierAvailable && messages.length > 0 && (
          <div className="faint" style={{ textAlign: 'center' }}>The beginning of this chat</div>
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
