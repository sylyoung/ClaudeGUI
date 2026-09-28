import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatFileHit, ChatMessage, SessionLiveState, SessionRecord } from '@shared/types'
import { countMatches, findPattern, findableText } from '@shared/findText'
import { useStore } from '@/store'
import type { ListFind, ListOlderPart } from './MessageList'

/**
 * Finding text in one chat (⌘F), the way a browser finds text in a page.
 *
 * Matches come from two places. The part of the chat the window has loaded is searched here, as
 * you type. The older part — the chat's file before what is loaded — is searched only when asked
 * for ("Search whole chat"), by the app reading the file (main/chatSearch.ts); after that, typing a
 * new word searches it again by itself until the box is closed.
 *
 * All matches form one list, oldest first: those of the older part, then those of the loaded part.
 * "3 of 17" is a place in that list, ↓ and ⏎ go to the next (newer) one, ↑ and ⇧⏎ to the previous.
 * A match in the loaded part is shown in the chat itself; a match in the older part is shown with
 * the rows around it, read from the file, in place of the loaded part until "Back to latest".
 */

type Target =
  | { part: 'loaded'; rowId: string; k: number; seq: number }
  | { part: 'older'; hit: number; k: number; seq: number }

interface OlderView {
  rows: ChatMessage[]
  from: number
  to: number
  /** Where the loaded part begins: the older part can be read on up to here. */
  limit: number
  busy: 'before' | 'after' | null
}

interface WholeSearch {
  state: 'running' | 'done' | 'error'
  query: string
  hits: ChatFileHit[]
  truncated: boolean
  done: number
  total: number
  error?: string
}

/** What each chat's find box held, so switching chats and back finds it as it was left. */
const remembered = new Map<string, { open: boolean; query: string; whole: boolean }>()

/**
 * Join two runs of rows read from neighbouring stretches of the file. A reply is written to the file
 * one block per line, so a boundary can fall inside one: its two halves become one row again.
 */
function joinRows(first: ChatMessage[], second: ChatMessage[]): ChatMessage[] {
  if (!first.length) return second
  if (!second.length) return first
  const have = new Set(first.map((m) => m.id))
  const a = first[first.length - 1]
  const b = second[0]
  if (a.kind === 'assistant' && b.kind === 'assistant' && a.id === b.id) {
    const ids = new Set(a.blocks.map((x) => (x.type === 'tool_use' ? x.id : '')))
    const merged: ChatMessage = { ...a, blocks: [...a.blocks, ...b.blocks.filter((x) => x.type !== 'tool_use' || !ids.has(x.id))] }
    return [...first.slice(0, -1), merged, ...second.slice(1).filter((m) => !have.has(m.id))]
  }
  return [...first, ...second.filter((m) => !have.has(m.id))]
}

export function useChatFind(record: SessionRecord, live: SessionLiveState | undefined, messages: ChatMessage[]) {
  const saved = remembered.get(record.id)
  const [open, setOpen] = useState(saved?.open ?? false)
  const [query, setQuery] = useState(saved?.query ?? '')
  /** The query the matches are for: what was typed, once typing pauses. */
  const [applied, setApplied] = useState(saved?.query ?? '')
  const [wholeWanted, setWholeWanted] = useState(saved?.whole ?? false)
  const [whole, setWhole] = useState<WholeSearch | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [olderView, setOlderView] = useState<OlderView | null>(null)
  const [olderBusy, setOlderBusy] = useState(false)
  /** How many matches each drawn row of the loaded part has, as drawn (markdown can differ from the text). */
  const [drawn, setDrawn] = useState<Map<string, number>>(new Map())
  /** A new query waits for its first match to be chosen from what is on screen. */
  const awaitingPick = useRef(true)
  const seq = useRef(0)
  const searchId = useRef(0)
  /** A file search was started at some point, so there may be one to stop. */
  const searched = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const ref = useMemo(() => ({ cwd: record.cwd, claudeSessionId: record.claudeSessionId }), [record.cwd, record.claudeSessionId])
  const historyFrom = live?.historyFrom ?? 0

  useEffect(() => {
    remembered.set(record.id, { open, query, whole: wholeWanted })
  }, [record.id, open, query, wholeWanted])

  useEffect(() => {
    const t = setTimeout(() => setApplied(query), 150)
    return () => clearTimeout(t)
  }, [query])

  const re = useMemo(() => (open ? findPattern(applied) : null), [open, applied])

  // A new query starts over: its first match is the first one on screen or below it.
  useEffect(() => {
    awaitingPick.current = true
    setTarget(null)
    setDrawn(new Map())
  }, [re?.source])

  // The loaded part, as its rows' text has it.
  const loadedCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (!re) return counts
    for (const m of messages) {
      const text = findableText(m)
      if (!text) continue
      const n = countMatches(text, re)
      if (n) counts.set(m.id, n)
    }
    return counts
  }, [messages, re])

  // The loaded part as one list, in the chat's order: a drawn row counts what is drawn.
  const loaded = useMemo(() => {
    const rows: { rowId: string; n: number }[] = []
    for (const m of messages) {
      const n = drawn.get(m.id) ?? loadedCounts.get(m.id) ?? 0
      if (n) rows.push({ rowId: m.id, n })
    }
    return rows
  }, [messages, drawn, loadedCounts])

  // The older part: what the file search found before the loaded part. Scrolling up loads more of
  // the chat, and what it loads is counted in the loaded part from then on, not twice.
  const olderHits = useMemo(() => {
    if (!whole || whole.state !== 'done' || !re || whole.query !== applied) return []
    return whole.hits.filter((h) => h.offset < historyFrom)
  }, [whole, re, applied, historyFrom])

  const olderTotal = olderHits.reduce((n, h) => n + h.count, 0)
  const loadedTotal = loaded.reduce((n, r) => n + r.n, 0)
  const total = olderTotal + loadedTotal

  /** Where the current match stands in the whole list (0-based), or -1. */
  const position = useMemo(() => {
    if (!target) return -1
    if (target.part === 'older') {
      if (target.hit >= olderHits.length) return -1
      let g = 0
      for (let i = 0; i < target.hit; i++) g += olderHits[i].count
      return g + Math.min(target.k, olderHits[target.hit].count - 1)
    }
    let g = olderTotal
    for (const r of loaded) {
      if (r.rowId === target.rowId) return g + Math.min(target.k, r.n - 1)
      g += r.n
    }
    return -1
  }, [target, olderHits, olderTotal, loaded])

  const readAround = useCallback(
    async (hit: ChatFileHit) => {
      setOlderBusy(true)
      try {
        const r = await window.api.sessions.fileRows(ref, { kind: 'around', offset: hit.offset, end: hit.end, historyFrom })
        setOlderView({ rows: r.rows, from: r.from, to: r.to, limit: r.limit, busy: null })
      } catch (err) {
        useStore.getState().toast(`Could not read that part of the chat: ${(err as Error).message}`, 'error')
      } finally {
        setOlderBusy(false)
      }
    },
    [ref, historyFrom]
  )

  /** Make match `g` of the whole list the current one, and show it. */
  const goTo = useCallback(
    (g: number) => {
      if (!total) return
      g = ((g % total) + total) % total
      seq.current += 1
      awaitingPick.current = false
      if (g < olderTotal) {
        let i = 0
        while (g >= olderHits[i].count) g -= olderHits[i++].count
        const hit = olderHits[i]
        setTarget({ part: 'older', hit: i, k: g, seq: seq.current })
        if (!olderView || hit.offset < olderView.from || hit.end > olderView.to) void readAround(hit)
        return
      }
      g -= olderTotal
      for (const r of loaded) {
        if (g < r.n) {
          setOlderView(null)
          setTarget({ part: 'loaded', rowId: r.rowId, k: g, seq: seq.current })
          return
        }
        g -= r.n
      }
    },
    [total, olderTotal, olderHits, olderView, loaded, readAround]
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!total) return
      if (position === -1) {
        // Nothing chosen (after going back to the latest messages): ↓ starts at the first match of
        // the loaded part, ↑ at the newest.
        goTo(dir === 1 ? olderTotal : total - 1)
        return
      }
      goTo(position + dir)
    },
    [total, position, olderTotal, goTo]
  )

  /** Open the older part of the chat at one of the matches the file search listed. */
  const showHit = useCallback(
    (i: number) => {
      let g = 0
      for (let j = 0; j < i; j++) g += olderHits[j].count
      goTo(g)
    },
    [olderHits, goTo]
  )

  // The file search, whenever it has been asked for and the query changes.
  useEffect(() => {
    if (!open || !wholeWanted || !re || historyFrom <= 0) return
    const id = ++searchId.current
    searched.current = true
    setWhole({ state: 'running', query: applied, hits: [], truncated: false, done: 0, total: historyFrom })
    window.api.sessions
      .searchFile({ ...ref, searchId: id, query: applied, historyFrom })
      .then((r) => {
        if (id !== searchId.current || r.cancelled) return
        setWhole({ state: 'done', query: applied, hits: r.hits, truncated: r.truncated, done: historyFrom, total: historyFrom })
      })
      .catch((err) => {
        if (id === searchId.current) setWhole({ state: 'error', query: applied, hits: [], truncated: false, done: 0, total: 0, error: (err as Error).message })
      })
    // historyFrom is left out on purpose: loading more of the chat does not start the search again,
    // it only moves matches from the older part to the loaded one (see olderHits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wholeWanted, re?.source, ref])

  useEffect(
    () =>
      window.api.events.onChatSearchProgress((p) => {
        if (p.searchId !== searchId.current) return
        setWhole((w) => (w && w.state === 'running' ? { ...w, done: p.done, total: p.total } : w))
      }),
    []
  )

  // A search still running when the box closes, or the chat goes away, is stopped.
  useEffect(() => {
    if ((open && wholeWanted) || !searched.current) return
    searchId.current += 1
    void window.api.sessions.stopSearch(ref).catch(() => undefined)
    setWhole(null)
  }, [open, wholeWanted, ref])
  useEffect(
    () => () => {
      if (searched.current) void window.api.sessions.stopSearch(ref).catch(() => undefined)
    },
    [ref]
  )

  // While the older part is on screen, a new query starts at the first of its matches in that part.
  useEffect(() => {
    if (!awaitingPick.current || !olderView || !olderHits.length) return
    const i = olderHits.findIndex((h) => h.offset >= olderView.from && h.end <= olderView.to)
    if (i === -1) return
    awaitingPick.current = false
    seq.current += 1
    setTarget({ part: 'older', hit: i, k: 0, seq: seq.current })
  }, [olderHits, olderView])

  const onLoadedReport = useCallback<ListFind['onReport']>(
    (counts, pick) => {
      setDrawn(counts)
      if (!awaitingPick.current || olderView) return
      if (pick) {
        awaitingPick.current = false
        seq.current += 1
        setTarget({ part: 'loaded', rowId: pick.rowId, k: pick.k, seq: seq.current })
      }
    },
    [olderView]
  )

  // Nothing matched on screen, but the loaded part has matches further up: start at the newest.
  useEffect(() => {
    if (!awaitingPick.current || olderView || !re || target || !loaded.length) return
    const t = setTimeout(() => {
      if (!awaitingPick.current) return
      const last = loaded[loaded.length - 1]
      awaitingPick.current = false
      seq.current += 1
      setTarget({ part: 'loaded', rowId: last.rowId, k: last.n - 1, seq: seq.current })
    }, 60)
    return () => clearTimeout(t)
  }, [loaded, olderView, re, target])

  /** Bumped by every ⌘F: the box puts the cursor in its field, with the old words selected. */
  const [focusSeq, setFocusSeq] = useState(0)
  const openBox = useCallback(() => {
    setOpen(true)
    setFocusSeq((n) => n + 1)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setTarget(null)
  }, [])

  const backToLatest = useCallback(() => {
    setOlderView(null)
    setTarget((t) => (t?.part === 'older' ? null : t))
  }, [])

  // The rows of the older part, read further back or further on.
  const readOlder = useCallback(
    async (dir: 'before' | 'after') => {
      const v = olderView
      if (!v || v.busy) return
      setOlderView({ ...v, busy: dir })
      try {
        const r =
          dir === 'before'
            ? await window.api.sessions.fileRows(ref, { kind: 'before', to: v.from })
            : await window.api.sessions.fileRows(ref, { kind: 'after', from: v.to, historyFrom })
        setOlderView((cur) => {
          if (!cur || cur.from !== v.from || cur.to !== v.to) return cur
          return dir === 'before'
            ? { ...cur, rows: joinRows(r.rows, cur.rows), from: r.from, busy: null }
            : { ...cur, rows: joinRows(cur.rows, r.rows), to: r.to, limit: r.limit, busy: null }
        })
      } catch {
        setOlderView((cur) => (cur ? { ...cur, busy: null } : cur))
      }
    },
    [olderView, ref, historyFrom]
  )

  // What the list is told: the current match, in the terms of the rows it draws.
  const listTarget = useMemo<ListFind['target']>(() => {
    if (!target) return null
    if (target.part === 'loaded') return { rowId: target.rowId, k: target.k, seq: target.seq }
    const hit = olderHits[target.hit]
    if (!hit) return null
    // A reply spans several lines of the file; its matches are counted across all of them.
    let k = target.k
    for (let i = 0; i < target.hit; i++) if (olderHits[i].rowId === hit.rowId) k += olderHits[i].count
    return { rowId: hit.rowId, k, seq: target.seq }
  }, [target, olderHits])

  const liveFind = useMemo<ListFind>(
    () => ({ re, target: target?.part === 'loaded' ? listTarget : null, onReport: onLoadedReport }),
    [re, target, listTarget, onLoadedReport]
  )
  const olderFind = useMemo<ListFind>(
    () => ({ re, target: target?.part === 'older' ? listTarget : null, onReport: () => undefined }),
    [re, target, listTarget]
  )
  const olderPart = useMemo<ListOlderPart | null>(
    () =>
      olderView && {
        laterAvailable: olderView.to < olderView.limit,
        laterBusy: olderView.busy === 'after',
        onLoadLater: () => void readOlder('after'),
        onBackToLatest: backToLatest
      },
    [olderView, readOlder, backToLatest]
  )

  return {
    open,
    openBox,
    close,
    query,
    setQuery,
    inputRef,
    focusSeq,
    total,
    position,
    step,
    /** The chat has an older part that is not loaded, so there is more to search than what is here. */
    hasOlderPart: historyFrom > 0,
    wholeWanted,
    searchWhole: () => setWholeWanted(true),
    stopWhole: () => setWholeWanted(false),
    whole: whole?.query === applied ? whole : null,
    olderHits,
    currentHit: target?.part === 'older' ? target.hit : -1,
    showHit,
    olderBusy,
    olderView,
    olderPart,
    readOlderBefore: () => void readOlder('before'),
    backToLatest,
    liveFind,
    olderFind
  }
}
