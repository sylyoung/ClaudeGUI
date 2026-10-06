/**
 * Finding text in the part of a chat that is not loaded, by reading the chat's transcript file.
 *
 * The window finds text in what it has loaded on its own; this covers the rest, from the start of
 * the file to where the loaded part begins. It runs in the app's main process rather than in the
 * session host, so it works as soon as the app is updated, without the host being replaced.
 *
 * Most of a large transcript is tool output — in one 1.1 GB chat measured here, 866 MB were tool
 * results (639 MB of them pictures) and only about 175 MB were prompts and replies — and a find
 * looks at prompts and replies only. So each line is judged by a few byte tests on its raw form
 * first, and only an entry that is a prompt or a reply and holds the text somewhere is parsed.
 * The file is read in pieces and a line is only ever held once it is complete.
 */
import fsp from 'fs/promises'
import type { ChatFileHit, ChatFileRows, ChatMessage } from '@shared/types'
import { countMatches, findPattern, snippetOf } from '@shared/findText'
import { TranscriptState, looksSynthetic } from './transcript'
import { lineEndAt, lineStartAt, readSessionLines, sizeOf } from './history'
import { readTranscriptIndex } from './transcriptIndex'

const NEWLINE = 0x0a
const CHUNK = 8 << 20
const MAX_HITS = 2000

export class SearchCancelled extends Error {
  constructor() {
    super('search replaced by a newer one')
  }
}

export interface SearchControl {
  cancelled: boolean
}

/**
 * Every prompt and reply in the lines that start before `to` (where the loaded part begins),
 * oldest first, that holds `query` — the newest `MAX_HITS` of them when there are more.
 */
export async function searchTranscript(
  file: string,
  query: string,
  to: number,
  control: SearchControl,
  onProgress?: (done: number, total: number) => void
): Promise<{ hits: ChatFileHit[]; truncated: boolean }> {
  const re = findPattern(query)
  const hits: ChatFileHit[] = []
  if (!re || to <= 0) return { hits, truncated: false }
  const size = sizeOf(file)
  if (!size) return { hits, truncated: false }

  // The raw line has the text JSON-escaped, so the words are looked for in that form. A query with
  // no letters that have a case (Chinese, digits) is looked for byte for byte; otherwise the line
  // is lowered first. Any white space in the query may be written as \n in the file, so only the
  // longest run without white space is required to be there.
  const words = query.trim().split(/\s+/).sort((a, b) => b.length - a.length)[0]
  const escaped = JSON.stringify(words).slice(1, -1)
  const caseless = escaped.toLowerCase() === escaped.toUpperCase()
  const exact = caseless ? Buffer.from(escaped, 'utf8') : null
  const lowered = escaped.toLowerCase()
  let truncated = false

  const consider = (line: Buffer, start: number, end: number): void => {
    const isUser = line.includes('"type":"user"')
    if (!isUser && !line.includes('"type":"assistant"')) return
    if (line.includes('"isSidechain":true')) return
    if (isUser && (line.includes('"tool_result"') || line.includes('"isMeta":true') || line.includes('"isCompactSummary":true') || line.includes('"teamName"'))) return
    if (exact ? !line.includes(exact) : !line.toString('utf8').toLowerCase().includes(lowered)) return
    let entry: { type?: string; uuid?: string; timestamp?: string; message?: { id?: string; content?: unknown } }
    try {
      entry = JSON.parse(line.toString('utf8')) as typeof entry
    } catch {
      // The last line of a transcript being written can be half there.
      return
    }
    const role = entry.type === 'user' ? 'user' : entry.type === 'assistant' ? 'assistant' : null
    if (!role) return
    const content = entry.message?.content
    const parts: string[] = []
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content as { type?: string; text?: string }[]) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
    }
    const text = role === 'user' ? parts.join('\n\n').trim() : parts.join('\n\n')
    if (!text || (role === 'user' && looksSynthetic(text))) return
    const count = countMatches(text, re)
    if (!count) return
    const rowId = role === 'user' ? entry.uuid : entry.message?.id
    const snippet = snippetOf(text, re)
    if (!rowId || !snippet) return
    // Past the cap, the oldest go: the newest are the ones next to the loaded part, where stepping
    // back from it arrives first.
    if (hits.length >= 2 * MAX_HITS) {
      hits.splice(0, hits.length - MAX_HITS)
      truncated = true
    }
    const ts = Date.parse(entry.timestamp ?? '')
    hits.push({ offset: start, end, rowId, role, ts: Number.isNaN(ts) ? 0 : ts, count, snippet })
  }

  const fh = await fsp.open(file, 'r')
  try {
    // Pieces of the line being read; joined once the line is complete.
    let pieces: Buffer[] = []
    let lineStart = 0
    for (let pos = 0; pos < size && lineStart < to; ) {
      if (control.cancelled) throw new SearchCancelled()
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - pos))
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos)
      if (!bytesRead) break
      const data = chunk.subarray(0, bytesRead)
      let from = 0
      for (let nl = data.indexOf(NEWLINE); nl !== -1; nl = data.indexOf(NEWLINE, from)) {
        const tail = data.subarray(from, nl)
        const line = pieces.length ? Buffer.concat([...pieces, tail]) : tail
        pieces = []
        const end = pos + nl + 1
        if (line.length && lineStart < to) consider(line, lineStart, end)
        lineStart = end
        from = nl + 1
        if (lineStart >= to) break
      }
      if (from < data.length && lineStart < to) pieces.push(Buffer.from(data.subarray(from)))
      pos += bytesRead
      onProgress?.(Math.min(pos, to), to)
    }
    if (pieces.length && lineStart < to) consider(Buffer.concat(pieces), lineStart, size)
  } finally {
    await fh.close().catch(() => undefined)
  }
  if (hits.length > MAX_HITS) {
    hits.splice(0, hits.length - MAX_HITS)
    truncated = true
  }
  return { hits, truncated }
}

/** How much of the file a read around a match starts with, and how far it may be widened. */
const AROUND_BEFORE = 1024 * 1024
const AROUND_AFTER = 512 * 1024
const STEP = 2 * 1024 * 1024
const MAX_WINDOW = 64 * 1024 * 1024
/** Rows worth showing: a read is widened until it has at least this many. */
const ENOUGH_ROWS = 80

/** The rows the whole lines from `from` to `to` hold, as the chat shows them. */
async function rowsOf(file: string, ref: { cwd: string; claudeSessionId: string }, from: number, to: number): Promise<ChatMessage[]> {
  if (to <= from) return []
  const entries = await readSessionLines(ref.claudeSessionId, ref.cwd, file, from, to)
  // readTranscriptIndex drops the first line of a range that does not start the file, as the tail
  // of the line before; starting on that line's newline keeps it.
  const { stamps, recaps } = await readTranscriptIndex(file, from > 0 ? from - 1 : 0, to)
  const state = new TranscriptState()
  let ts = 0
  for (const e of entries) {
    const real = stamps.get((e as { uuid: string }).uuid)
    if (real) ts = real
    state.applyHistoryEntry(e as never, ts)
    ts += 1
  }
  state.settleReplayOrder()
  state.insertRecaps(recaps)
  return state.messages
}

/**
 * The rows around one match: a stretch of the file before and after the entry, widened on both
 * sides until it holds a screenful, and never past `limit` — where the loaded part of the chat
 * takes over.
 */
export async function readRowsAround(file: string, ref: { cwd: string; claudeSessionId: string }, hit: { offset: number; end: number }, limit: number): Promise<ChatFileRows> {
  let before = AROUND_BEFORE
  let after = AROUND_AFTER
  for (;;) {
    const from = await lineStartAt(file, Math.max(0, hit.offset - before))
    const to = Math.min(limit, await lineEndAt(file, Math.min(limit, hit.end + after)))
    const rows = await rowsOf(file, ref, from, Math.max(to, hit.end))
    const wide = before + after >= MAX_WINDOW
    if (rows.length >= ENOUGH_ROWS || wide || (from === 0 && to >= limit)) return { rows, from, to: Math.max(to, hit.end) }
    before *= 2
    after *= 2
  }
}

/** The rows just before `to`, reaching further back until there is a screenful or the file starts. */
export async function readRowsBefore(file: string, ref: { cwd: string; claudeSessionId: string }, to: number): Promise<ChatFileRows> {
  for (let window = STEP; ; window *= 2) {
    const from = await lineStartAt(file, Math.max(0, to - window))
    const rows = await rowsOf(file, ref, from, to)
    if (rows.length >= ENOUGH_ROWS || from === 0 || window >= MAX_WINDOW) return { rows, from, to }
  }
}

/** The rows just after `from`, reaching further on until there is a screenful or `limit` is reached. */
export async function readRowsAfter(file: string, ref: { cwd: string; claudeSessionId: string }, from: number, limit: number): Promise<ChatFileRows> {
  for (let window = STEP; ; window *= 2) {
    const to = Math.min(limit, await lineEndAt(file, Math.min(limit, from + window)))
    const rows = await rowsOf(file, ref, from, to)
    if (rows.length >= ENOUGH_ROWS || to >= limit || window >= MAX_WINDOW) return { rows, from, to }
  }
}

/**
 * Where the loaded part of a chat really begins: the first whole line at or after `historyFrom`.
 * From 1.0.55 on that is a line start already; a session host of 1.0.54 or older read the loaded
 * part from a byte inside a line, and dropped that line, so the part read for a find runs up to the
 * end of it and no row falls between the two.
 */
export function loadedPartStart(file: string, historyFrom: number): Promise<number> {
  return historyFrom > 0 ? lineEndAt(file, historyFrom - 1) : Promise.resolve(0)
}
