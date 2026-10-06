import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, ChevronUp } from 'lucide-react'
import type { ChatMessage, PendingPermission, PermissionDecision, SessionLiveState } from '@shared/types'
import { MessageItem, type PromptState } from './MessageItem'
import { PermissionPrompt } from './PermissionPrompt'
import { WorkingStrip } from './WorkingStrip'
import { clearMatches, collectRanges, firstInView, paintMatches, revealRange } from '@/lib/findHighlight'
import { useStore } from '@/store'

const PAGE = 120
/** Rows drawn around a match the find moved to, when it lies above what is drawn. */
const AROUND_BEFORE = 30
const AROUND_AFTER = 60
/** How far below the top of the chat the ↑ ↓ buttons put the prompt they go to, in pixels. */
const STEP_MARGIN = 12

/**
 * Your prompts as drawn in the conversation, top to bottom: rows of their own (data-mid), so neither
 * the notes Claude Code writes as user messages nor the prompts still queued below the conversation.
 */
function promptRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.messages-inner > .msg-user[data-mid]')]
}

/** How far a row stands below the top of the list's visible area, in pixels. */
function atTop(list: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - list.getBoundingClientRect().top
}

/** A row of the list by its message id (rows carry it as data-mid). */
function rowElement(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`)
}

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
  /**
   * A row at the top and where it stood on screen when rows were asked for above it (see the scroll
   * keeping below): the first one that carries its id in the page — prompts and answers do, notices
   * not.
   */
  const anchor = useRef<{ id: string; at: number } | null>(null)
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
  /**
   * A step of the ↑ ↓ buttons to a prompt not drawn yet: the rows above (dir -1) or below (dir 1)
   * are being drawn or read first. `fromId` is the prompt it steps on from (null: none drawn that
   * way), `sig` what was drawn when it was last looked at.
   */
  const pendingStep = useRef<{ dir: -1 | 1; fromId: string | null; sig: string } | null>(null)

  useEffect(() => {
    if (prevSession.current !== sessionId) {
      prevSession.current = sessionId
      setLimit(PAGE)
      setStick(!older)
      setPaged(false)
      setWin(null)
      pendingStep.current = null
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
  // Only then may the window let go of the chat's older rows (store.ts, trimChat): above the end
  // they may be the rows being read.
  const setFollowing = useStore((s) => s.setFollowing)
  useEffect(() => {
    if (!older) setFollowing(sessionId, follow)
  }, [sessionId, follow, older, setFollowing])

  /**
   * Reach further back: first through what the window already holds, then — when that is all on
   * screen — into the chat's transcript, which is read from the end and only as far back as it is
   * looked at.
   */
  const showEarlier = useCallback((force = false) => {
    setPaged(true)
    // Where the top rows stand now, for keeping them under the eye once rows come in above them.
    const el = ref.current
    if (el && !anchor.current) {
      for (const m of visible.slice(0, 12)) {
        const e = rowElement(el, m.id)
        if (e) {
          anchor.current = { id: m.id, at: atTop(el, e) }
          break
        }
      }
    }
    if (windowed && winStart > 0) {
      setWin({ startId: messages[Math.max(0, winStart - PAGE * 2)].id, endId: messages[winEnd].id })
      return
    }
    if (!windowed && messages.length > limit) {
      setLimit((l) => l + PAGE * 2)
      return
    }
    if (!earlierAvailable || earlierBusy || (!force && Date.now() - loadedAt.current < 400)) return
    loadedAt.current = Date.now()
    onLoadEarlier()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, limit, windowed, winStart, winEnd, earlierAvailable, earlierBusy, onLoadEarlier])

  /** Reach further on from rows drawn around a match, back to the chat's end. */
  const showLater = useCallback((force = false) => {
    if (windowed) {
      const end = winEnd + PAGE * 2
      if (end >= messages.length - 1) {
        // Joined up with the end: the chat is drawn from the same first row down to its end.
        setWin(null)
        setLimit(messages.length - winStart)
      } else setWin({ startId: messages[winStart].id, endId: messages[end].id })
      return
    }
    if (!older?.laterAvailable || older.laterBusy || (!force && Date.now() - laterAt.current < 400)) return
    laterAt.current = Date.now()
    older.onLoadLater()
  }, [windowed, winStart, winEnd, messages, older])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setStick(dist < 80)
    // A row kept in place while rows are read in above it moves with the reader's own scrolling.
    const kept = anchor.current
    const keptRow = kept && rowElement(el, kept.id)
    if (kept && keptRow) kept.at = atTop(el, keptRow)
    // Scrolling to the top of a chat is the request for what came before it.
    if (el.scrollTop < 240) showEarlier()
    // And, where the rows shown are not the chat's end, scrolling to the bottom for what follows.
    if (dist < 240 && (below > 0 || older?.laterAvailable)) showLater()
    measureStepsSoon()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEarlier, showLater, below, older?.laterAvailable])

  // Following the newest message, and — when reading further back instead — keeping the row that
  // was under the eye where it was: rows added above would otherwise push the chat down. The list is
  // measured only for these: measuring it after every update made the browser lay out the whole
  // chat each time, and with a few hundred rows drawn and a subagent at work that was the window
  // busy for about 100 ms, several times a second (measured 2026-09-28).
  const firstShown = useRef<string | undefined>(undefined)
  const followRef = useRef(follow)
  followRef.current = follow
  const stickFrame = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const first = visible[0]?.id
    const before = firstShown.current
    firstShown.current = first
    if (follow) {
      anchor.current = null
      // Once per frame, however many updates came in during it.
      if (!stickFrame.current) {
        stickFrame.current = requestAnimationFrame(() => {
          stickFrame.current = 0
          const e = ref.current
          if (e && followRef.current) e.scrollTop = e.scrollHeight
        })
      }
      return
    }
    if (!before || first === before || !anchor.current) return
    // Rows came in above, pushing the rows that were at the top down by their height. The browser
    // keeps the row under the eye in place by itself, as soon as the page is measured, unless the
    // list was scrolled right to its top; only what it has not made up for is made up here. Before
    // 1.0.60 the shift was made up here as well, so the chat jumped on by the height of the rows
    // read in whenever it was scrolled near its top but not to it (measured 2026-10-06).
    const row = rowElement(el, anchor.current.id)
    if (row) el.scrollTop += atTop(el, row) - anchor.current.at
    anchor.current = null
  })
  useEffect(() => () => cancelAnimationFrame(stickFrame.current), [])

  // Going from one of your prompts to the next with the ↑ ↓ buttons, instead of scrolling: a step
  // puts the prompt at the top of the chat and outlines it for a moment. A prompt not drawn yet is
  // reached the way scrolling reaches it — the rows above (below) are drawn, or read from the
  // transcript, first — and the step goes on once they are in.
  const canReadEarlier = hidden > 0 || earlierAvailable
  const canReadLater = below > 0 || Boolean(older?.laterAvailable)
  const reach = useRef({ earlier: canReadEarlier, later: canReadLater })
  reach.current = { earlier: canReadEarlier, later: canReadLater }
  const drawnSig = `${messages.length}|${hidden}|${visible.length}|${visible[0]?.id}|${visible[visible.length - 1]?.id}`
  /** Whether each button has somewhere to go, as drawn and scrolled now. */
  const [steps, setSteps] = useState({ up: false, down: false })
  const stepFrame = useRef(0)
  // Measured once per frame at most, and only on a scroll or when rows come or go — not on every
  // update of an answer being written.
  const measureStepsSoon = useCallback(() => {
    if (stepFrame.current) return
    stepFrame.current = requestAnimationFrame(() => {
      stepFrame.current = 0
      const el = ref.current
      if (!el) return
      const rows = promptRows(el)
      const top = el.getBoundingClientRect().top
      const atEnd = el.scrollTop >= el.scrollHeight - el.clientHeight - 1
      const up = (rows.length > 0 && rows[0].getBoundingClientRect().top - top < STEP_MARGIN - 2) || reach.current.earlier
      const down = (rows.length > 0 && !atEnd && rows[rows.length - 1].getBoundingClientRect().top - top > STEP_MARGIN + 2) || reach.current.later
      setSteps((s) => (s.up === up && s.down === down ? s : { up, down }))
    })
  }, [])
  useEffect(() => measureStepsSoon(), [drawnSig, canReadEarlier, canReadLater, measureStepsSoon])
  useEffect(() => () => cancelAnimationFrame(stepFrame.current), [])

  const flashed = useRef<{ row: HTMLElement; timer: number } | null>(null)
  const goToPrompt = useCallback((row: HTMLElement) => {
    const el = ref.current
    if (!el) return
    // No longer following the end: a scroll to it queued for this frame must not undo the step.
    followRef.current = false
    setStick(false)
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - STEP_MARGIN
    if (flashed.current) {
      clearTimeout(flashed.current.timer)
      flashed.current.row.classList.remove('stepped')
    }
    void row.offsetWidth // so the outline starts over when the same prompt is gone to again
    row.classList.add('stepped')
    flashed.current = {
      row,
      timer: window.setTimeout(() => {
        row.classList.remove('stepped')
        flashed.current = null
      }, 1600)
    }
  }, [])
  useEffect(() => () => clearTimeout(flashed.current?.timer), [])

  const stepPrompt = (dir: -1 | 1) => {
    const el = ref.current
    if (!el) return
    pendingStep.current = null
    const rows = promptRows(el)
    const top = el.getBoundingClientRect().top
    const at = (r: HTMLElement) => r.getBoundingClientRect().top - top
    // The prompt at the top of the chat is the one just above the line STEP_MARGIN down: a step
    // up goes to the one before it, a step down to the one after it.
    let to: HTMLElement | undefined
    let from: HTMLElement | undefined
    if (dir < 0) {
      for (const r of rows) {
        if (at(r) >= STEP_MARGIN - 2) {
          from = r
          break
        }
        to = r
      }
    } else {
      for (const r of rows) {
        if (at(r) > STEP_MARGIN + 2) {
          to = r
          break
        }
        from = r
      }
      // At the end of what is drawn, a prompt further down cannot be brought any higher.
      if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) to = undefined
    }
    if (to) return goToPrompt(to)
    if (dir < 0 ? !canReadEarlier : !canReadLater) return
    pendingStep.current = { dir, fromId: from?.dataset.mid ?? null, sig: drawnSig }
    if (dir < 0) {
      followRef.current = false
      setStick(false)
      showEarlier(true)
    } else showLater(true)
  }

  // A step waiting for rows: once they are in, go to the prompt, or draw (read) further.
  useLayoutEffect(() => {
    const p = pendingStep.current
    const el = ref.current
    if (!p || !el || p.sig === drawnSig) return
    p.sig = drawnSig
    const rows = promptRows(el)
    const i = p.fromId ? rows.findIndex((r) => r.dataset.mid === p.fromId) : p.dir < 0 ? rows.length : -1
    // The prompt it stepped on from is no longer drawn (the chat moved elsewhere meanwhile).
    if (i === -1 && p.fromId) {
      pendingStep.current = null
      return
    }
    const to = rows[i + p.dir]
    if (to) {
      pendingStep.current = null
      goToPrompt(to)
    } else if (p.dir < 0 ? canReadEarlier : canReadLater) {
      if (p.dir < 0) showEarlier(true)
      else showLater(true)
    } else pendingStep.current = null
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
    <>
      <div className="messages" ref={ref} onScroll={onScroll}>
        <div className="messages-inner">
          {earlierBusy && <div className="faint" style={{ textAlign: 'center' }}>Reading earlier messages…</div>}
          {!earlierBusy && (hidden > 0 || earlierAvailable) && (
            <button
              data-tip={hidden > 0 ? 'Show earlier messages' : "Read further back in this chat's transcript. Scrolling to the top does the same."}
              className="btn ghost"
              style={{ alignSelf: 'center' }}
              onClick={() => showEarlier()}
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
            <button className="btn ghost" style={{ alignSelf: 'center' }} data-tip="Show the messages that follow. Scrolling to the bottom does the same." onClick={() => showLater()}>
              Show {Math.min(below, PAGE * 2)} later messages ({below} below)
            </button>
          )}
          {older && (older.laterBusy ? (
            <div className="faint" style={{ textAlign: 'center' }}>Reading later messages…</div>
          ) : older.laterAvailable ? (
            <button className="btn ghost" style={{ alignSelf: 'center' }} data-tip="Read the messages that follow this part of the chat. Scrolling to the bottom does the same." onClick={() => showLater()}>
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
      </div>
      {/* Over the list rather than in it, so they stay in the corner while it scrolls. */}
      {messages.length > 0 && (
        <div className="jump-nav">
          <button className="jump-btn icon" disabled={!steps.up} data-tip="Go to your previous prompt: it is put at the top of the chat. Further back than what is shown, earlier messages are read in, as scrolling to the top does." onClick={() => stepPrompt(-1)}>
            <ChevronUp size={14} />
          </button>
          <button className="jump-btn icon" disabled={!steps.down} data-tip="Go to your next prompt: it is put at the top of the chat." onClick={() => stepPrompt(1)}>
            <ChevronDown size={14} />
          </button>
          {!older && (!stick || windowed) && (
            <button data-tip="Jump to the newest message and follow new output" className="jump-btn" onClick={toLatest}>
              <ArrowDown size={12} /> latest
            </button>
          )}
        </div>
      )}
    </>
  )
}
