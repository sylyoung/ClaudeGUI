import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ChevronDown, ChevronUp } from 'lucide-react'
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
 * How long a move of the ↑ ↓ and latest buttons takes, in ms: one continuous scroll that starts fast
 * and slows into place, longer for a longer way (with its square root), within these bounds.
 */
const GLIDE_MIN = 180
const GLIDE_MAX = 600

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

/** The list is scrolled to the end of what is drawn. */
function atScrollEnd(list: HTMLElement): boolean {
  return list.scrollTop >= list.scrollHeight - list.clientHeight - 1
}

/** The prompt the ↑ ↓ buttons went to last, and where on screen they put it (null: still on the way). */
interface StepMark {
  row: HTMLElement
  at: number | null
}

/**
 * That prompt, while the chat still shows it where the buttons put it or is still on its way there;
 * null once anything else has moved the chat (your own scrolling).
 */
function markedPrompt(list: HTMLElement, mark: StepMark | null, moving: boolean): HTMLElement | null {
  if (!mark || !mark.row.isConnected) return null
  if (mark.at === null) return moving ? mark.row : null
  return Math.abs(atTop(list, mark.row) - mark.at) < 2 ? mark.row : null
}

/**
 * Where a step of the ↑ ↓ buttons goes on from, as an index into `rows` (your prompts as drawn): the
 * prompt the buttons went to last, while it is still marked. Otherwise the line STEP_MARGIN below the
 * top of the chat: a step up goes to the last prompt above that line, a step down to the first one
 * below it (rows.length and -1 stand for "none on that side").
 */
function stepFrom(list: HTMLElement, rows: HTMLElement[], dir: -1 | 1, marked: HTMLElement | null): number {
  const i = marked ? rows.indexOf(marked) : -1
  if (i !== -1) return i
  if (dir < 0) {
    const below = rows.findIndex((r) => atTop(list, r) >= STEP_MARGIN - 2)
    return below === -1 ? rows.length : below
  }
  let above = -1
  while (above + 1 < rows.length && atTop(list, rows[above + 1]) <= STEP_MARGIN + 2) above++
  return above
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
   * Steps of the ↑ ↓ buttons to a prompt not drawn yet: the rows above (dir -1) or below (dir 1)
   * are being drawn or read first. `fromId` is the prompt they step on from (null: none drawn that
   * way), `n` how many prompts on from it (a press while waiting adds one), `since` when it began,
   * `sig` what was drawn when it was last looked at.
   */
  const pendingStep = useRef<{ dir: -1 | 1; fromId: string | null; n: number; since: number; sig: string } | null>(null)
  /** The move under way of the ↑ ↓ and latest buttons (see glideTo). */
  const glide = useRef<{ frame: number } | null>(null)
  const stepMark = useRef<StepMark | null>(null)
  const stopGlide = () => {
    if (glide.current) cancelAnimationFrame(glide.current.frame)
    glide.current = null
  }

  useEffect(() => {
    if (prevSession.current !== sessionId) {
      prevSession.current = sessionId
      setLimit(PAGE)
      setStick(!older)
      setPaged(false)
      setWin(null)
      pendingStep.current = null
      stepMark.current = null
      stopGlide()
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

  /** Near the top (bottom) of what is drawn: draw or read what comes before (after) it. */
  const readNear = useCallback(() => {
    const el = ref.current
    if (!el) return
    // Scrolling to the top of a chat is the request for what came before it.
    if (el.scrollTop < 240) showEarlier()
    // And, where the rows shown are not the chat's end, scrolling to the bottom for what follows.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240 && (below > 0 || older?.laterAvailable)) showLater()
  }, [showEarlier, showLater, below, older?.laterAvailable])
  const readNearNow = useRef(readNear)
  readNearNow.current = readNear

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    // The buttons' own moves are not the reader scrolling: they neither let go of the chat's end nor
    // take it up (the buttons do that themselves), and read nothing in on the way.
    const own = glide.current !== null
    if (!own) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    // A row kept in place while rows are read in above it moves with the reader's own scrolling.
    const kept = anchor.current
    const keptRow = kept && rowElement(el, kept.id)
    if (kept && keptRow) kept.at = atTop(el, keptRow)
    if (!own) readNear()
    measureStepsSoon()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readNear])

  // A turn of the wheel or a swipe stops a move of the buttons — but not what is left of a swipe made
  // before it, which coasts on in small steps for a moment: a press right after one would be lost.
  const lastWheel = useRef(0)
  const onWheel = () => {
    const now = performance.now()
    if (now - lastWheel.current > 150) stopGlide()
    lastWheel.current = now
  }

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
  // scrolls the chat until the prompt is at its top, and outlines it for a moment. A prompt not drawn
  // yet is reached the way scrolling reaches it — the rows above (below) are drawn, or read from the
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
      const marked = markedPrompt(el, stepMark.current, glide.current !== null)
      const up = stepFrom(el, rows, -1, marked) > 0 || reach.current.earlier
      // At the end of what is drawn a prompt further down cannot be brought any higher: a step down
      // goes on there only from a prompt the buttons went to (and marks the next one).
      const down = (stepFrom(el, rows, 1, marked) < rows.length - 1 && (marked !== null || !atScrollEnd(el))) || reach.current.later
      setSteps((s) => (s.up === up && s.down === down ? s : { up, down }))
    })
  }, [])
  useEffect(() => measureStepsSoon(), [drawnSig, canReadEarlier, canReadLater, measureStepsSoon])
  useEffect(() => () => cancelAnimationFrame(stepFrame.current), [])

  /**
   * Scroll the list to `to()` in one continuous move that starts fast and slows into place, then call
   * `then`. `to` is worked out afresh on every frame, so rows read in above or an answer growing on
   * the way do not throw it off. A move started meanwhile replaces this one; the reader's own
   * scrolling stops it (onWheel, and a press in the list such as on its scroll bar).
   */
  const glideTo = useCallback((to: () => number, then: () => void) => {
    const el = ref.current
    if (!el) return
    if (glide.current) cancelAnimationFrame(glide.current.frame)
    const target = () => Math.max(0, Math.min(el.scrollHeight - el.clientHeight, to()))
    const span = target() - el.scrollTop
    const instant = Math.abs(span) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches
    const ms = instant ? 0 : Math.min(GLIDE_MAX, Math.max(GLIDE_MIN, 120 + 6 * Math.sqrt(Math.abs(span))))
    const start = performance.now()
    const g = { frame: 0 }
    glide.current = g
    const frame = (now: number) => {
      if (glide.current !== g) return
      const t = ms ? Math.min(1, Math.max(0, (now - start) / ms)) : 1
      // What is left of the way shrinks with the cube of the time left.
      el.scrollTop = target() - span * (1 - t) ** 3
      if (t < 1) {
        g.frame = requestAnimationFrame(frame)
        return
      }
      // Over one frame later: the scroll event of the last move comes in then, and is the move's own.
      g.frame = requestAnimationFrame(() => {
        if (glide.current !== g) return
        glide.current = null
        then()
      })
    }
    g.frame = requestAnimationFrame(frame)
  }, [])
  useEffect(
    () => () => {
      if (glide.current) cancelAnimationFrame(glide.current.frame)
    },
    []
  )

  const flashed = useRef<{ row: HTMLElement; timer: number } | null>(null)
  const goToPrompt = useCallback(
    (row: HTMLElement) => {
      const el = ref.current
      if (!el) return
      // No longer following the end: a scroll to it queued for this frame must not undo the step.
      followRef.current = false
      setStick(false)
      const mark: StepMark = { row, at: null }
      stepMark.current = mark
      glideTo(
        () => (row.isConnected ? el.scrollTop + atTop(el, row) - STEP_MARGIN : el.scrollTop),
        () => {
          // Where the prompt ended up: at the top, or lower for one near the end of the chat.
          if (stepMark.current === mark && row.isConnected) mark.at = atTop(el, row)
          readNearNow.current()
          measureStepsSoon()
        }
      )
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
    },
    [glideTo, measureStepsSoon]
  )
  useEffect(() => () => clearTimeout(flashed.current?.timer), [])

  const stepPrompt = (dir: -1 | 1) => {
    const el = ref.current
    if (!el) return
    const p = pendingStep.current
    // Still waiting for rows that way (and not for long): one prompt further once they are in.
    if (p && p.dir === dir && Date.now() - p.since < 4000) {
      p.n++
      return
    }
    pendingStep.current = null
    const rows = promptRows(el)
    const marked = markedPrompt(el, stepMark.current, glide.current !== null)
    const i = stepFrom(el, rows, dir, marked)
    const to = rows[i + dir]
    if (to && (dir < 0 || marked || !atScrollEnd(el))) return goToPrompt(to)
    if (dir < 0 ? !canReadEarlier : !canReadLater) return
    pendingStep.current = { dir, fromId: rows[i]?.dataset.mid ?? null, n: 1, since: Date.now(), sig: drawnSig }
    if (dir < 0) {
      followRef.current = false
      setStick(false)
      showEarlier(true)
    } else showLater(true)
  }

  // Steps waiting for rows: once they are in, go to the prompt, or draw (read) further.
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
    const to = rows[i + p.dir * p.n]
    if (to) {
      pendingStep.current = null
      goToPrompt(to)
    } else if (p.dir < 0 ? canReadEarlier : canReadLater) {
      if (p.dir < 0) showEarlier(true)
      else showLater(true)
    } else {
      // The chat goes no further that way: its first (last) prompt, then.
      pendingStep.current = null
      const end = p.dir < 0 ? rows[0] : rows[rows.length - 1]
      if (end && end !== rows[i]) goToPrompt(end)
    }
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
      stopGlide()
      stepMark.current = null
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

  // The latest button: the chat's end, followed from there on as new output comes in.
  const latestOn = Boolean(older) || !stick || windowed
  const toLatest = () => {
    pendingStep.current = null
    stepMark.current = null
    if (older) return older.onBackToLatest()
    const el = ref.current
    if (!el) return
    if (windowed) {
      // The rows drawn are a part around a match of the find, not the chat's end: the end is drawn in
      // their place, with nothing in between to scroll through.
      stopGlide()
      setWin(null)
      setStick(true)
      el.scrollTop = el.scrollHeight
      return
    }
    glideTo(() => el.scrollHeight - el.clientHeight, () => setStick(true))
  }

  return (
    <>
      <div className="messages" ref={ref} onScroll={onScroll} onWheel={onWheel} onPointerDown={stopGlide}>
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
      {/* Over the list rather than in it, so they stay in the corner while it scrolls. Always all three,
          each in its own place, so that none moves under the mouse; and a press does not take the
          keyboard away from the input box. */}
      {messages.length > 0 && (steps.up || steps.down || latestOn) && (
        <div className="jump-nav" onMouseDown={(e) => e.preventDefault()}>
          <button className="jump-btn" disabled={!steps.up} data-tip="Your previous prompt: the chat scrolls up until it is at the top. Before the first one shown, earlier messages are read in first, as scrolling to the top does." onClick={() => stepPrompt(-1)}>
            <ChevronUp size={16} />
          </button>
          <button className="jump-btn" disabled={!steps.down} data-tip="Your next prompt: the chat scrolls down until it is at the top." onClick={() => stepPrompt(1)}>
            <ChevronDown size={16} />
          </button>
          <button className="jump-btn" disabled={!latestOn} data-tip={older ? "Back to the chat's latest messages" : 'The latest message: the chat scrolls to its end and follows new output from there.'} onClick={toLatest}>
            <ArrowDownToLine size={16} />
          </button>
        </div>
      )}
    </>
  )
}
