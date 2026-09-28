/**
 * Reading a chat's history: the end of its transcript first, the rest only when it is asked for.
 *
 * Claude Code's own reader, `getSessionMessages()`, walks a chat's whole transcript file and only
 * then cuts what it returns, so the cost of opening a chat grows with the file rather than with
 * what is shown. On this machine that is the difference between a moment and half a minute: the
 * transcripts here run from a few megabytes to two gigabytes, and the largest cost about 28 seconds
 * and over a gigabyte of memory to open (measured 2026-09-23) — for six messages.
 *
 * The reader also accepts a `sessionStore`, which it asks for the transcript entries instead of
 * opening the file itself. That is what is used here: the store hands it the lines of one byte
 * range of the same file, so Claude Code still does all the parsing and folding — nothing about a
 * chat is read differently — it is simply given the part of the file that is being looked at. The
 * same 352 MB chat then loads in 25 ms instead of 1003 ms, with the same messages.
 *
 * What the reader will not do is cross a compaction. It builds the conversation by following the
 * `parentUuid` of the last entry backwards, and a compaction writes a fresh entry with no parent,
 * so the walk ends there — six messages for a chat of several thousand. That is right for Claude
 * Code, which is about to continue the conversation and may only use what is still in the model's
 * context; it is wrong for a window whose job is to show what was said. So a range is cut into the
 * pieces of conversation it holds — a new piece begins wherever an entry's parent is not in the
 * piece being built, which is what a compaction and a resumed session leave behind — and each
 * piece is handed to the reader on its own. Claude Code still does all the parsing and folding of
 * every piece; the pieces are put back in the order the file has them. The 39 MB chat measured
 * here returns 1,978 messages for its last 8 MB instead of 5.
 *
 * A chat opens on the last `FIRST_WINDOW` bytes, widened until it holds a screenful of
 * conversation, and scrolling up asks for the range before it.
 */
import fs from 'fs'
import { getSessionMessages, getSubagentMessages, type SessionMessage, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { LineIndex } from '@shared/rows'

/** What a chat is opened on. A range this size holds hundreds of messages in every chat measured. */
const FIRST_WINDOW = 2 * 1024 * 1024
/** Messages worth opening a chat on: the window is widened until it brings back at least this many. */
const ENOUGH_MESSAGES = 200
/** How far a read may be widened looking for them, for a chat whose messages are unusually large. */
const MAX_WINDOW = 64 * 1024 * 1024
/** How much further back one "show earlier messages" reaches, before the same widening. */
const EARLIER_WINDOW = 2 * 1024 * 1024

/**
 * One read at a time. Each is now small, so this costs almost nothing — it is kept because it is
 * what stops a dozen chats opening at once from adding up to a memory spike in the session host.
 */
let queue: Promise<unknown> = Promise.resolve()

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * The transcript entries whose lines lie in [from, to) of the file. A range that does not start at
 * the beginning of the file starts in the middle of a line, and that half line is dropped; the same
 * happens at the end, where the file may be being written to right now.
 */
async function entriesInRange(file: string, from: number, to: number): Promise<SessionStoreEntry[]> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, to - from))
    if (buf.length === 0) return []
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    let text = buf.subarray(0, bytesRead).toString('utf8')
    if (from > 0) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    const entries: SessionStoreEntry[] = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        entries.push(JSON.parse(t) as SessionStoreEntry)
      } catch {
        // A line cut in half by the edge of the range, or one still being written.
      }
    }
    return entries
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** A store that answers Claude Code's reader with the entries it is given, and nothing else. */
function storeOf(entries: SessionStoreEntry[]): SessionStore {
  return {
    async append() {
      /* nothing is written through this store */
    },
    async load() {
      return entries
    },
    async listSubkeys() {
      return []
    }
  }
}

/** An entry that is part of the conversation's chain, as opposed to one of the notes around it. */
function isChained(e: SessionStoreEntry): boolean {
  const t = (e as { type?: string }).type
  return (t === 'user' || t === 'assistant' || t === 'system') && !(e as { isSidechain?: boolean }).isSidechain
}

/**
 * The pieces of conversation a range holds. Each one is a chain the reader can follow from its last
 * entry back to its first: a compaction, and a session resumed after one, write an entry whose
 * parent is not in the file before it, and that entry begins the next piece. A piece is also what
 * the reader is given, so everything else — attachments, titles, the app's own notes — travels with
 * the piece it was written in.
 */
function piecesOf(entries: SessionStoreEntry[]): SessionStoreEntry[][] {
  const pieces: SessionStoreEntry[][] = []
  let piece: SessionStoreEntry[] = []
  let known = new Set<string>()
  for (const e of entries) {
    const parent = (e as { parentUuid?: string | null }).parentUuid
    if (piece.length && isChained(e) && (!parent || !known.has(parent))) {
      pieces.push(piece)
      piece = []
      known = new Set<string>()
    }
    piece.push(e)
    const uuid = (e as { uuid?: string }).uuid
    if (uuid) known.add(uuid)
  }
  if (piece.length) pieces.push(piece)
  return pieces
}

/**
 * A piece without the note it ends on, when it ends on one. Claude Code begins its walk back through
 * a conversation at the latest message that is not a note of its own (`isMeta`) — the line it writes
 * after a tool returned a picture ("[Image: original 2800x1424 …]") is one — and a piece that ends on
 * such a note has no message after it to begin at: the walk began at a side branch further up
 * instead, and the last minutes of the piece were missing (found 2026-09-28: 38 of 173 messages of a
 * piece of the WuTsai chat, read as the part before a cut). Notes are not shown in any case.
 */
const WALKED = new Set(['user', 'assistant', 'progress', 'system', 'attachment'])

function withoutTrailingNote(piece: SessionStoreEntry[]): SessionStoreEntry[] {
  let p = piece
  for (;;) {
    let last = -1
    for (let i = p.length - 1; i >= 0 && last < 0; i--) {
      const e = p[i] as { type?: string; isSidechain?: boolean }
      if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain) last = i
    }
    const note = p[last] as { isMeta?: boolean; uuid?: string; parentUuid?: string | null } | undefined
    if (!note?.isMeta) return p
    // What hangs off the note (an attachment, say) hangs off the message before it instead, so the
    // walk that begins there comes to that message; the note itself goes.
    p = p
      .filter((_, i) => i !== last)
      .map((x) => {
        const e = x as { type?: string; parentUuid?: string | null }
        return WALKED.has(e.type ?? '') && e.parentUuid === note.uuid ? ({ ...x, parentUuid: note.parentUuid ?? null } as SessionStoreEntry) : x
      })
  }
}

/**
 * One byte range of a transcript, read as the conversation it holds: every piece folded by Claude
 * Code and put back in the order of the file. An entry that appears in two pieces — a transcript
 * written twice over the same conversation — is kept once, where it first stands.
 */
async function foldRange(sessionId: string, dir: string, file: string, from: number, to: number): Promise<SessionMessage[]> {
  const entries = await entriesInRange(file, from, to)
  const messages: SessionMessage[] = []
  const seen = new Set<string>()
  for (const piece of piecesOf(entries)) {
    const folded = await getSessionMessages(sessionId, { dir, includeSystemMessages: true, sessionStore: storeOf(withoutTrailingNote(piece)) })
    for (const m of folded) {
      const uuid = (m as { uuid?: string }).uuid
      if (uuid) {
        if (seen.has(uuid)) continue
        seen.add(uuid)
      }
      messages.push(m)
    }
  }
  return messages
}

export interface HistoryRead {
  messages: SessionMessage[]
  /** Size of the transcript file, in megabytes, rounded. */
  fileMB: number
  /** Where the read started in the file. 0 means the chat is loaded from its very beginning. */
  from: number
}

/**
 * The end of a chat's transcript: the last `FIRST_WINDOW` bytes, doubled until the chat has a
 * screenful of conversation in it, for the chats whose messages are large enough that a window that
 * size holds only a handful.
 */
export function readSessionHistory(sessionId: string, dir: string, file: string): Promise<HistoryRead> {
  const size = sizeOf(file)
  return oneAtATime(async () => {
    let window = FIRST_WINDOW
    let from = await stepStartAtOrBefore(file, await lineAtOrAfter(file, Math.max(0, size - window)))
    let messages = await foldLines(sessionId, dir, file, from, size)
    while (from > 0 && window < MAX_WINDOW && messages.length < ENOUGH_MESSAGES) {
      window = Math.min(window * 2, MAX_WINDOW)
      from = await stepStartAtOrBefore(file, await lineAtOrAfter(file, Math.max(0, size - window)))
      messages = await foldLines(sessionId, dir, file, from, size)
    }
    return { messages, fileMB: Math.round(size / 1048576), from }
  })
}

/**
 * The start of the first whole line at or after `pos`. Every part of a chat that is read begins and
 * ends on one: a part that began wherever a window of bytes happened to begin dropped the line cut
 * in two there as a broken one, and the part before it — which ended at the same place — dropped it
 * too, so each "show earlier messages" lost the line at its edge (found 2026-09-28: three task
 * notifications gone in twelve reads of one chat).
 */
async function lineAtOrAfter(file: string, pos: number): Promise<number> {
  return pos <= 0 ? 0 : lineEndAt(file, pos - 1)
}

/** How far back from a read's edge a step start is looked for. */
const STEP_SCAN = 4 * 1024 * 1024

/**
 * Where a part of the chat to read should begin, at or before line start `pos`: the start of a step
 * of the conversation — a prompt or note (a user entry that is not a tool result), or the first
 * line of an answer (Claude Code writes each block of an answer as a line of its own, and may write
 * a tool's result between two of them). A part that
 * began between a tool call and its result had the call without its result and the result without
 * its call, so the card showed no result (found 2026-09-28 in one of twelve reads of a chat). Looked
 * for in the STEP_SCAN bytes before `pos`; where there is none, `pos` itself.
 */
async function stepStartAtOrBefore(file: string, pos: number): Promise<number> {
  if (pos <= 0) return 0
  const start = Math.max(0, pos - STEP_SCAN)
  const fh = await fs.promises.open(file, 'r')
  let text: string
  try {
    const buf = Buffer.alloc(pos - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    text = buf.subarray(0, bytesRead).toString('latin1')
  } finally {
    await fh.close().catch(() => undefined)
  }
  // Whole lines only; latin1 keeps one character per byte, so positions are file offsets.
  const lines: Array<{ at: number; line: string }> = []
  let i = start === 0 ? 0 : text.indexOf('\n') + 1
  if (start > 0 && i === 0) return pos
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    const end = nl === -1 ? text.length : nl
    lines.push({ at: start + i, line: text.slice(i, end) })
    i = end + 1
  }
  const answerId = (line: string) => (line.includes('"type":"assistant"') ? /"message":\{[^]*?"id":"([^"]+)"/.exec(line)?.[1] : undefined)
  for (let k = lines.length - 1; k >= 0; k--) {
    const { at, line } = lines[k]
    if (line.includes('"isSidechain":true')) continue
    if (line.includes('"type":"user"') && !line.includes('"tool_result"')) return at
    const id = answerId(line)
    if (!id) continue
    // The first line of an answer: the answer line before it is another answer's. Tool results can
    // stand between two lines of the same answer (a tool runs while the answer goes on), so they do
    // not count as the answer's start.
    let prev: string | undefined
    for (let j = k - 1; j >= 0 && prev === undefined; j--) prev = answerId(lines[j].line)
    if (prev !== undefined && prev !== id) return at
  }
  return pos
}

/** The conversation held by the whole lines from line start `from` to line start `to`. */
function foldLines(sessionId: string, dir: string, file: string, from: number, to: number): Promise<SessionMessage[]> {
  // entriesInRange drops everything up to the first newline of a range that does not start the
  // file; starting one byte early makes that the newline ending the line before.
  return foldRange(sessionId, dir, file, from > 0 ? from - 1 : 0, to)
}

export interface SliceRead {
  messages: SessionMessage[]
  /** Where this read started in the file; what the chat is now loaded from. */
  from: number
}

/**
 * What comes before the part of a chat that is loaded: the `EARLIER_WINDOW` bytes below it, reaching
 * further back in the same way while that brings back less than a screenful — so that one "show
 * earlier messages" is always worth a click, even where a few messages fill a whole window.
 */
export function readSessionSlice(sessionId: string, dir: string, file: string, before: number): Promise<SliceRead> {
  return oneAtATime(async () => {
    // A place that is not a line start (kept by a session host of 1.0.54 or older) has the line cut
    // there on neither side yet: it belongs here.
    const to = await lineAtOrAfter(file, before)
    let window = EARLIER_WINDOW
    let from = await stepStartAtOrBefore(file, await lineAtOrAfter(file, Math.max(0, to - window)))
    let messages = await foldLines(sessionId, dir, file, from, to)
    while (from > 0 && window < MAX_WINDOW && messages.length < ENOUGH_MESSAGES) {
      window = Math.min(window * 2, MAX_WINDOW)
      from = await stepStartAtOrBefore(file, await lineAtOrAfter(file, Math.max(0, to - window)))
      messages = await foldLines(sessionId, dir, file, from, to)
    }
    return { messages, from }
  })
}

/**
 * Where the line holding byte `pos` begins: just past the newline before it, or 0. Lines of a
 * transcript can be megabytes long (a tool that returned pictures), so the file is read backwards
 * in blocks rather than guessed at.
 */
export async function lineStartAt(file: string, pos: number): Promise<number> {
  if (pos <= 0) return 0
  const fh = await fs.promises.open(file, 'r')
  try {
    const block = Buffer.allocUnsafe(64 * 1024)
    for (let end = pos; end > 0; ) {
      const start = Math.max(0, end - block.length)
      const { bytesRead } = await fh.read(block, 0, end - start, start)
      const nl = block.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (nl !== -1) return start + nl + 1
      end = start
    }
    return 0
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Where the line holding byte `pos` ends: just past its newline, or the end of the file. */
export async function lineEndAt(file: string, pos: number): Promise<number> {
  const size = sizeOf(file)
  if (pos >= size) return size
  const fh = await fs.promises.open(file, 'r')
  try {
    const block = Buffer.allocUnsafe(64 * 1024)
    for (let start = Math.max(0, pos); start < size; ) {
      const { bytesRead } = await fh.read(block, 0, Math.min(block.length, size - start), start)
      if (!bytesRead) break
      const nl = block.subarray(0, bytesRead).indexOf(0x0a)
      if (nl !== -1) return start + nl + 1
      start += bytesRead
    }
    return size
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * The conversation held by the whole lines from `from` to `to`, both of which are line starts (or
 * the ends of the file). Unlike a slice below the loaded part, which begins wherever a window of
 * bytes happens to begin, nothing is cut here: the range starts on a line of its own, so the first
 * line is kept rather than dropped as the tail of the one before it.
 */
export function readSessionLines(sessionId: string, dir: string, file: string, from: number, to: number): Promise<SessionMessage[]> {
  // entriesInRange drops everything up to the first newline of a range that does not start the
  // file; starting one byte early makes that the newline ending the line before.
  return oneAtATime(() => foldRange(sessionId, dir, file, from > 0 ? from - 1 : 0, to))
}

/**
 * Where the last occurrence of `needle` is in the file, read backwards from its end in blocks, or
 * null when it is not in the last `maxScan` bytes.
 */
async function findBackwards(file: string, needle: string, maxScan = Number.POSITIVE_INFINITY): Promise<number | null> {
  const size = sizeOf(file)
  const pattern = Buffer.from(needle, 'utf8')
  const fh = await fs.promises.open(file, 'r')
  try {
    const block = Buffer.allocUnsafe(4 * 1024 * 1024)
    // Blocks overlap by the length of the needle, so one lying across two blocks is still found.
    for (let end = size; end > 0 && size - end < maxScan; ) {
      const start = Math.max(0, end - block.length)
      const { bytesRead } = await fh.read(block, 0, end - start, start)
      const at = block.subarray(0, bytesRead).lastIndexOf(pattern)
      if (at !== -1) return start + at
      if (start === 0) break
      end = start + pattern.length - 1
    }
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * Where the lines of a transcript are from byte `from` (a line start) to its end: each entry by its
 * uuid, each answer's first and last line by its message id, each tool result by its call. One pass
 * over the part of a chat that is held, when older rows are about to be let go of (shared/rows.ts).
 * Lines are not parsed: a line can be megabytes of pictures, and the fields are found by their
 * unescaped keys, which is how the entry's own fields are told from text inside it.
 */
export async function readLineIndex(file: string, from: number): Promise<LineIndex> {
  const idx: LineIndex = { uuid: new Map(), answerFirst: new Map(), answerLast: new Map(), result: new Map() }
  const size = sizeOf(file)
  const fh = await fs.promises.open(file, 'r')
  try {
    const block = Buffer.allocUnsafe(8 * 1024 * 1024)
    let carry: Buffer = Buffer.alloc(0)
    let carryAt = from
    for (let pos = from; pos < size; ) {
      const { bytesRead } = await fh.read(block, 0, Math.min(block.length, size - pos), pos)
      if (!bytesRead) break
      const buf = carry.length ? Buffer.concat([carry, block.subarray(0, bytesRead)]) : block.subarray(0, bytesRead)
      let lineStart = 0
      for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, lineStart)) {
        indexLine(buf.subarray(lineStart, nl), carryAt + lineStart, idx)
        lineStart = nl + 1
      }
      carry = Buffer.from(buf.subarray(lineStart))
      carryAt += lineStart
      pos += bytesRead
    }
    // The last line is left out while it has no newline: it may be being written.
  } finally {
    await fh.close().catch(() => undefined)
  }
  return idx
}

const UUID_KEY = Buffer.from('"uuid":"')
const TIMESTAMP_NEXT = Buffer.from('","timestamp":"')
const RESULT_KEY = Buffer.from('"tool_use_id":"')
const ANSWER_ID = /"message":\{[^]*?"id":"([^"]+)"/
const UUID_RE = /^[0-9a-f-]{36}$/

/**
 * The entry's own uuid: the one followed by its timestamp (prompts, answers, tool results, notes),
 * or else the first one (a compaction notice has other fields after it). Keys inside the text of a
 * message are escaped (\"uuid\"), so they are not mistaken for it.
 */
function entryUuid(line: Buffer): string | undefined {
  let first: string | undefined
  for (let i = line.indexOf(UUID_KEY); i !== -1; i = line.indexOf(UUID_KEY, i + 1)) {
    const v = line.subarray(i + 8, i + 44).toString('latin1')
    if (!UUID_RE.test(v)) continue
    if (line.subarray(i + 44, i + 44 + TIMESTAMP_NEXT.length).equals(TIMESTAMP_NEXT)) return v
    first ??= v
  }
  return first
}

function indexLine(line: Buffer, at: number, idx: LineIndex): void {
  if (line.includes('"isSidechain":true')) return
  const uuid = entryUuid(line)
  if (uuid) idx.uuid.set(uuid, at)
  // Who wrote the message is said at its start ("role"); structured tool output further on may hold
  // anything, so it is not looked at for this.
  const head = line.subarray(0, 8192).toString('latin1')
  if (head.includes('"role":"assistant"')) {
    const id = ANSWER_ID.exec(head)?.[1]
    if (id) {
      if (!idx.answerFirst.has(id)) idx.answerFirst.set(id, at)
      idx.answerLast.set(id, at)
    }
    return
  }
  // Every call named in a result line; one named that is not its own only makes the line count as
  // later than it is, which makes a cut more careful, never less.
  for (let i = line.indexOf(RESULT_KEY); i !== -1; i = line.indexOf(RESULT_KEY, i + 1)) {
    const end = line.indexOf(34, i + RESULT_KEY.length)
    if (end !== -1) idx.result.set(line.subarray(i + RESULT_KEY.length, end).toString('latin1'), at)
  }
}

/**
 * The transcript line holding the result of one tool call, parsed, or null. For the pictures of a
 * row the session host no longer holds: the window leaves them out of its rows and asks for them
 * when a card is opened, which may be long after the host let go of the row, and the row may be
 * from anywhere in the chat (scrolled back to), so the whole file is searched if need be — about a
 * second for the largest transcripts here, once, when the card is opened.
 */
export async function readToolResultLine(file: string, toolUseId: string): Promise<Record<string, unknown> | null> {
  const at = await findBackwards(file, `"tool_use_id":"${toolUseId}"`)
  if (at === null) return null
  const from = await lineStartAt(file, at)
  const to = await lineEndAt(file, at)
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    await fh.read(buf, 0, buf.length, from)
    return JSON.parse(buf.toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** One subagent's messages. Their files are small, but the end is read first here as well. */
export function readSubagentHistory(sessionId: string, agentId: string, dir: string, file: string): Promise<SessionMessage[]> {
  const size = sizeOf(file)
  const from = Math.max(0, size - MAX_WINDOW)
  return oneAtATime(async () =>
    from === 0
      ? getSubagentMessages(sessionId, agentId, { dir })
      : getSubagentMessages(sessionId, agentId, { dir, sessionStore: storeOf(await entriesInRange(file, from, size)) })
  )
}
