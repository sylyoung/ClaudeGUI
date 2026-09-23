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
 * One byte range of a transcript, read as the conversation it holds: every piece folded by Claude
 * Code and put back in the order of the file. An entry that appears in two pieces — a transcript
 * written twice over the same conversation — is kept once, where it first stands.
 */
async function foldRange(sessionId: string, dir: string, file: string, from: number, to: number): Promise<SessionMessage[]> {
  const entries = await entriesInRange(file, from, to)
  const messages: SessionMessage[] = []
  const seen = new Set<string>()
  for (const piece of piecesOf(entries)) {
    const folded = await getSessionMessages(sessionId, { dir, includeSystemMessages: true, sessionStore: storeOf(piece) })
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
    let from = Math.max(0, size - window)
    let messages = await foldRange(sessionId, dir, file, from, size)
    while (from > 0 && window < MAX_WINDOW && messages.length < ENOUGH_MESSAGES) {
      window = Math.min(window * 2, MAX_WINDOW)
      from = Math.max(0, size - window)
      messages = await foldRange(sessionId, dir, file, from, size)
    }
    return { messages, fileMB: Math.round(size / 1048576), from }
  })
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
export function readSessionSlice(sessionId: string, dir: string, file: string, to: number): Promise<SliceRead> {
  return oneAtATime(async () => {
    let window = EARLIER_WINDOW
    let from = Math.max(0, to - window)
    let messages = await foldRange(sessionId, dir, file, from, to)
    while (from > 0 && window < MAX_WINDOW && messages.length < ENOUGH_MESSAGES) {
      window = Math.min(window * 2, MAX_WINDOW)
      from = Math.max(0, to - window)
      messages = await foldRange(sessionId, dir, file, from, to)
    }
    return { messages, from }
  })
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
