import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ChatMessage, PendingPermission, PermissionDecision, SessionLiveState } from '@shared/types'
import { MessageItem, type PromptState } from './MessageItem'
import { PermissionPrompt } from './PermissionPrompt'
import { WorkingStrip } from './WorkingStrip'
import { clearMatches, collectRanges, firstInView, paintMatches, revealRange } from '@/lib/findHighlight'

const PAGE = 120
/** Rows drawn around a match the find moved to, when it lies above what is drawn. */
const AROUND_BEFORE = 30
const AROUND_AFTER = 60

/** What a find in the chat asks of the list: what to mark, and which match is the current one. */
export interface ListFind {
  re: RegExp | null
  /** The current match: the k-th in row `rowId`. A new `seq` brings it into view. */
  target: { rowId: string; k: number; seq: number } | null
  /**
   * How many matches each drawn row has, and — when there is no current match yet — the first
   * one on screen or below it, which is where a new find starts.
   */
  onReport: (counts: Map<string, number>, pick: { rowId: string; k: number } | null) => void
}

/**
 * An older part of the chat read from its file for a find, shown in place of the loaded part.
 * It can be read further back (the ordinary "earlier" props) and further on (these).
 */
export interface ListOlderPart {
  laterAvailable: boolean
  laterBusy: boolean
  onLoadLater: () => void
  onBackToLatest: () => void
}

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
  onLoadEarlier,
  find,
  older
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
  find?: ListFind
  older?: ListOlderPart
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(!older)
  const [limit, setLimit] = useState(PAGE)
  /**
   * Rows drawn from `startId` to `endId` instead of the newest ones: the find moved to a match
   * above what was drawn. Null while the chat shows its end, as it normally does.
   */
  const [win, setWin] = useState<{ startId: string; endId: string } | null>(null)
  const prevSession = useRef(sessionId)
  /** The chat has been scrolled back at least once, so saying where it begins means something. */
  const [paged, setPaged] = useState(false)
  const loadedAt = useRef(0)
  const laterAt = useRef(0)

  useEffect(() => {
    if (prevSession.current !== sessionId) {
      prevSession.current = sessionId
      setLimit(PAGE)
      setStick(!older)
      setPaged(false)
      setWin(null)
    }
  }, [sessionId, older])

  const winStart = win ? messages.findIndex((m) => m.id === win.startId) : -1
  const winEnd = win && winStart !== -1 ? messages.findIndex((m) => m.id === win.endId) : -1
  const windowed = winStart !== -1 && winEnd >= winStart
  const visible = windowed ? messages.slice(winStart, winEnd + 1) : messages.length > limit ? messages.slice(messages.length - limit) : messages
  const hidden = windowed ? winStart : messages.length - visible.length
  /** Rows below the drawn ones: only while a find has moved the chat up to a match. */
  const below = windowed ? messages.length - 1 - winEnd : 0
  // The chat follows new output only while it shows its own end and is scrolled there.
  const follow = stick && !windowed && !older

  /**
   * Reach further back: first through what the window already holds, then — when that is all on
   * screen — into the chat's transcript, which is read from the end and only as far back as it is
   * looked at.
   */
  const showEarlier = useCallback(() => {
    setPaged(true)
    if (windowed && winStart > 0) {
      setWin({ startId: messages[Math.max(0, winStart - PAGE * 2)].id, endId: messages[winEnd].id })
      return
    }
    if (!windowed && messages.length > limit) {
      setLimit((l) => l + PAGE * 2)
      return
    }
    if (!earlierAvailable || earlierBusy || Date.now() - loadedAt.current < 400) return
    loadedAt.current = Date.now()
    onLoadEarlier()
  }, [messages, limit, windowed, winStart, winEnd, earlierAvailable, earlierBusy, onLoadEarlier])

  /** Reach further on from rows drawn around a match, back to the chat's end. */
  const showLater = useCallback(() => {
    if (windowed) {
      const end = winEnd + PAGE * 2
      if (end >= messages.length - 1) {
        // Joined up with the end: the chat is drawn from the same first row down to its end.
        setWin(null)
        setLimit(messages.length - winStart)
      } else setWin({ startId: messages[winStart].id, endId: messages[end].id })
      return
    }
    if (!older?.laterAvailable || older.laterBusy || Date.now() - laterAt.current < 400) return
    laterAt.current = Date.now()
    older.onLoadLater()
  }, [windowed, winStart, winEnd, messages, older])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setStick(dist < 80)
    // Scrolling to the top of a chat is the request for what came before it.
    if (el.scrollTop < 240) showEarlier()
    // And, where the rows shown are not the chat's end, scrolling to the bottom for what follows.
    if (dist < 240 && (below > 0 || older?.laterAvailable)) showLater()
  }, [showEarlier, showLater, below, older?.laterAvailable])

  // Following the newest message, and — when reading further back instead — keeping the row that
  // was under the eye where it was: rows added above would otherwise push the chat down.
  const firstShown = useRef<string | undefined>(undefined)
  const lastHeight = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const first = visible[0]?.id
    if (follow) el.scrollTop = el.scrollHeight
    else if (first !== firstShown.current && el.scrollHeight > lastHeight.current) el.scrollTop += el.scrollHeight - lastHeight.current
    firstShown.current = first
    lastHeight.current = el.scrollHeight
  })

  // A find that moved to a match above the rows drawn: draw the rows around it instead.
  const target = find?.target
  useEffect(() => {
    if (!target) return
    const i = messages.findIndex((m) => m.id === target.rowId)
    if (i === -1 || visible.some((m) => m.id === target.rowId)) return
    setWin({ startId: messages[Math.max(0, i - AROUND_BEFORE)].id, endId: messages[Math.min(messages.length - 1, i + AROUND_AFTER)].id })
    setStick(false)
    // Only a new match (seq) moves the rows; what is drawn depends on it, not the other way round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.seq, target?.rowId])

  // Marking the matches, after the rows are drawn (and after the scroll above has been set, so that
  // bringing the current match into view has the last word).
  const scrolledSeq = useRef(-1)
  const reported = useRef('')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !find) return
    if (!find.re) {
      if (reported.current) {
        clearMatches()
        reported.current = ''
      }
      return
    }
    const byRow = collectRanges(el, find.re)
    const all: Range[] = []
    for (const ranges of byRow.values()) all.push(...ranges)
    const t = find.target
    const mine = t ? byRow.get(t.rowId) : undefined
    const current = t && mine?.length ? mine[Math.min(t.k, mine.length - 1)] : null
    paintMatches(all, current)
    if (t && current && scrolledSeq.current !== t.seq) {
      scrolledSeq.current = t.seq
      revealRange(el, current)
      setStick(false)
    }
    const pick = t ? null : firstInView(el, byRow)
    const signature = `${find.re.source}|${[...byRow].map(([id, r]) => `${id}:${r.length}`).join(',')}|${pick ? `${pick.rowId}:${pick.k}` : ''}`
    if (signature !== reported.current) {
      reported.current = signature
      find.onReport(new Map([...byRow].map(([id, r]) => [id, r.length])), pick)
    }
  })
  // On the way out, in the same step that removes the rows: a list drawn in this one's place (the
  // older part of the chat, or back) paints its own marks right after.
  useLayoutEffect(() => () => clearMatches(), [])

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
  // The end of the chat — the turn running, permissions asked for, prompts waiting — is shown only
  // where the chat is drawn down to its end.
  const atEnd = !windowed && !older
  const queued = atEnd ? visible.filter((m) => queuedIds.has(m.id)) : []
  const flow = queuedIds.size ? visible.filter((m) => !queuedIds.has(m.id)) : visible

  const toLatest = () => {
    setWin(null)
    setStick(true)
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }

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
        {!earlierBusy && (paged || older) && hidden === 0 && !earlierAvailable && messages.length > 0 && (
          <div className="faint" style={{ textAlign: 'center' }}>The beginning of this chat</div>
        )}
        {!loaded && messages.length === 0 && <div className="faint" style={{ textAlign: 'center' }}>Loading history…</div>}
        {flow.map((m) => (
          <MessageItem key={m.id} message={m} state={promptState.get(m.id)} />
        ))}
        {below > 0 && (
          <button className="btn ghost" style={{ alignSelf: 'center' }} data-tip="Show the messages that follow. Scrolling to the bottom does the same." onClick={showLater}>
            Show {Math.min(below, PAGE * 2)} later messages ({below} below)
          </button>
        )}
        {older && (older.laterBusy ? (
          <div className="faint" style={{ textAlign: 'center' }}>Reading later messages…</div>
        ) : older.laterAvailable ? (
          <button className="btn ghost" style={{ alignSelf: 'center' }} data-tip="Read the messages that follow this part of the chat. Scrolling to the bottom does the same." onClick={showLater}>
            Show later messages
          </button>
        ) : (
          <button className="btn ghost" style={{ alignSelf: 'center' }} data-tip="The rest of the chat is what it normally shows: go back to its latest messages" onClick={older.onBackToLatest}>
            The rest of the chat follows — back to the latest messages
          </button>
        ))}
        {atEnd && working && <WorkingStrip live={live} since={turnStartedAt} />}
        {atEnd && pending.map((p) => (
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
      {!older && (!stick || windowed) && (
        <button data-tip="Jump to the newest message and follow new output" className="jump-bottom" onClick={toLatest}>
          <ArrowDown size={12} style={{ verticalAlign: -2 }} /> latest
        </button>
      )}
    </div>
  )
}
