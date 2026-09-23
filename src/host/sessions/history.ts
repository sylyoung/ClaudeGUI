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
 * A chat opens on the last `FIRST_WINDOW` bytes, widened while that keeps bringing more of the
 * conversation into view, and scrolling up asks for the range before it.
 */
import fs from 'fs'
import { getSessionMessages, getSubagentMessages, type SessionMessage, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

/** What a chat is opened on: enough for the whole current conversation of every chat measured here. */
const FIRST_WINDOW = 8 * 1024 * 1024
/** How far the first read may be widened while more of the conversation keeps appearing. */
const MAX_WINDOW = 64 * 1024 * 1024
/** How much further back one "show earlier messages" reaches. */
export const EARLIER_WINDOW = 8 * 1024 * 1024

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

/** A store that answers Claude Code's reader with one range of one file, and nothing else. */
function rangeStore(file: string, from: number, to: number): SessionStore {
  return {
    async append() {
      /* nothing is written through this store */
    },
    async load() {
      return entriesInRange(file, from, to)
    },
    async listSubkeys() {
      return []
    }
  }
}

export interface HistoryRead {
  messages: SessionMessage[]
  /** Size of the transcript file, in megabytes, rounded. */
  fileMB: number
  /** Where the read started in the file. 0 means the chat is loaded from its very beginning. */
  from: number
}

/**
 * The end of a chat's transcript: the last `FIRST_WINDOW` bytes, doubled while that keeps bringing
 * more messages back, so that a chat whose current conversation is unusually long still opens whole.
 */
export function readSessionHistory(sessionId: string, dir: string, file: string): Promise<HistoryRead> {
  const size = sizeOf(file)
  return oneAtATime(async () => {
    let window = FIRST_WINDOW
    let from = Math.max(0, size - window)
    let messages = await getSessionMessages(sessionId, { dir, includeSystemMessages: true, sessionStore: rangeStore(file, from, size) })
    while (from > 0 && window < MAX_WINDOW) {
      window = Math.min(window * 2, MAX_WINDOW)
      const wider = Math.max(0, size - window)
      const more = await getSessionMessages(sessionId, { dir, includeSystemMessages: true, sessionStore: rangeStore(file, wider, size) })
      if (more.length <= messages.length) break
      messages = more
      from = wider
    }
    return { messages, fileMB: Math.round(size / 1048576), from }
  })
}

/** The messages of one earlier range of the same transcript, for "show earlier messages". */
export function readSessionSlice(sessionId: string, dir: string, file: string, from: number, to: number): Promise<SessionMessage[]> {
  return oneAtATime(() => getSessionMessages(sessionId, { dir, includeSystemMessages: true, sessionStore: rangeStore(file, from, to) }))
}

/** One subagent's messages. Their files are small, but the end is read first here as well. */
export function readSubagentHistory(sessionId: string, agentId: string, dir: string, file: string): Promise<SessionMessage[]> {
  const size = sizeOf(file)
  const from = Math.max(0, size - MAX_WINDOW)
  return oneAtATime(() =>
    from === 0
      ? getSubagentMessages(sessionId, agentId, { dir })
      : getSubagentMessages(sessionId, agentId, { dir, sessionStore: rangeStore(file, from, size) })
  )
}
