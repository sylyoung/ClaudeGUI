/**
 * The prompts a chat has ever had, read straight from its Claude Code transcript.
 *
 * The chat's history is loaded through Claude Code, which — for a transcript larger than 5 MB —
 * hands back only the conversation since the last compaction, and always hands back only the
 * segment a compaction last started. That is fine for the chat itself, but it is not what the
 * rewind list is supposed to be: Claude Code's own rewind lists the prompts of the whole session,
 * and so must this app. Reading the transcript here keeps the list complete, and gives the byte
 * offset a rewind cuts at when the prompt is older than the loaded history.
 *
 * A pass over the file in order is enough, because that is the order the prompts were sent in: a
 * compaction writes a boundary as a fresh root and repairs the links between segments when it
 * loads, so the parent links in the file are not a reliable way to walk it. Only the header of a
 * line is looked at, and a user entry is parsed only when its bytes say it is a prompt, so a
 * gigabyte of tool output costs a pass and no memory.
 */
import fs from 'fs'
import fsp from 'fs/promises'
import { looksSynthetic } from './transcript'

export interface IndexedPrompt {
  /** uuid of the user entry in the transcript: the id a rewind names. */
  id: string
  text: string
  /** When it was sent, from the entry's own timestamp (0 when the entry has none). */
  ts: number
  /** The answer before it, which a rewind keeps and Claude Code resumes at. */
  forkAt: string | null
  /** Where the transcript is cut to keep the conversation up to that answer. */
  cutAt: number
}

export interface PromptIndex {
  prompts: IndexedPrompt[]
  /** Size and mtime of the transcript it came from, so a grown file invalidates it. */
  size: number
  mtimeMs: number
  /** Lines read, for the log. */
  scanned: number
  /** Offset after the last complete line read: a transcript only ever grows, so the next read can
   * start there instead of reading the whole file again. */
  offset: number
  /** The answer before the oldest prompt of the next read, carried between reads. */
  forkAt: string | null
  cutAt: number
}

const NEWLINE = 0x0a
const UUID_RE = /^[0-9a-f-]{36}$/

/**
 * The header of a transcript entry: its uuid and what it is. The fields are searched for along the
 * whole line because their order varies with the writer — an entry can put its content before them.
 * Mentions inside content are escaped (\"uuid\"), so an unescaped match is always the entry's own
 * field, never a transcript pasted into a message.
 */
function entryHeader(line: Buffer): { uuid: string; kind: 'user' | 'assistant' | 'other'; sidechain: boolean } | null {
  const at = line.indexOf('"uuid":"')
  if (at === -1) return null
  const uuid = line.subarray(at + 8, at + 44).toString('latin1')
  if (!UUID_RE.test(uuid)) return null
  let kind: 'user' | 'assistant' | 'other' = 'other'
  if (line.includes('"type":"user"')) kind = 'user'
  else if (line.includes('"type":"assistant"')) kind = 'assistant'
  return { uuid, kind, sidechain: line.includes('"isSidechain":true') }
}

/**
 * The text of a user entry that is a prompt the user typed, or null. Tool results are written as
 * user entries too, and the CLI writes notices of its own as user entries; neither belongs in the
 * rewind list. The cheap tests run on the raw bytes so no tool output is ever parsed.
 */
function promptOf(line: Buffer): { text: string; ts: number } | null {
  if (!line.includes('"type":"user"') || line.includes('"tool_result"')) return null
  if (line.includes('"isMeta":true') || line.includes('"isSidechain":true')) return null
  if (line.includes('"isCompactSummary":true') || line.includes('"teamName"')) return null
  let entry: { message?: { content?: unknown }; timestamp?: string }
  try {
    entry = JSON.parse(line.toString('utf8')) as typeof entry
  } catch {
    // Transcripts are appended line by line, so the last line can be half written.
    return null
  }
  const content = entry.message?.content
  const parts: string[] = []
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content as { type?: string; text?: string }[]) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  const text = parts.join('\n\n').trim()
  if (!text || looksSynthetic(text)) return null
  const ts = Date.parse(entry.timestamp ?? '')
  return { text, ts: Number.isNaN(ts) ? 0 : ts }
}

/**
 * Every prompt of the chat, oldest first, each with the answer before it — the point Claude Code
 * resumes at, and the offset a cut keeps — or null for the first prompt, which has nothing before it.
 */
export async function readPromptIndex(file: string, previous?: PromptIndex): Promise<PromptIndex> {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    // A chat that has not written a transcript yet has no prompts to go back to.
    return { prompts: [], size: 0, mtimeMs: 0, scanned: 0, offset: 0, forkAt: null, cutAt: 0 }
  }
  // A transcript only grows while a chat is used, so a read that already covered the start of this
  // file can pick up where it stopped. A file that shrank was cut (a rewind), and one older than
  // the read was rewritten: both are read from the start again.
  const resume = previous && previous.size <= stat.size && previous.mtimeMs <= stat.mtimeMs ? previous : undefined
  const prompts: IndexedPrompt[] = resume ? [...resume.prompts] : []
  const seen = new Set<string>(resume ? prompts.map((p) => p.id) : [])
  let forkAt: string | null = resume ? resume.forkAt : null
  let cutAt = resume ? resume.cutAt : 0
  let scanned = 0
  let lastComplete = resume ? resume.offset : 0

  const fh = await fsp.open(file, 'r')
  try {
    const size = stat.size
    const chunkSize = 4 << 20
    let carry = Buffer.alloc(0)
    for (let pos = resume ? resume.offset : 0; pos < size; ) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, size - pos))
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos)
      if (!bytesRead) break
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const base = pos - carry.length
      let from = 0
      for (let nl = data.indexOf(NEWLINE); nl !== -1; nl = data.indexOf(NEWLINE, from)) {
        consider(data.subarray(from, nl), base + nl + 1)
        lastComplete = base + nl + 1
        from = nl + 1
      }
      carry = Buffer.from(data.subarray(from))
      pos += bytesRead
    }
    if (carry.length) consider(carry, size)
  } finally {
    await fh.close()
  }

  function consider(line: Buffer, end: number): void {
    if (!line.length) return
    scanned += 1
    const header = entryHeader(line)
    if (!header || header.sidechain || seen.has(header.uuid)) return
    if (header.kind === 'assistant') {
      // The answer a rewind keeps when it goes back to the prompt below it.
      seen.add(header.uuid)
      forkAt = header.uuid
      cutAt = end
      return
    }
    if (header.kind !== 'user') return
    const prompt = promptOf(line)
    if (!prompt) return
    seen.add(header.uuid)
    prompts.push({ id: header.uuid, text: prompt.text, ts: prompt.ts, forkAt, cutAt })
  }

  return { prompts, size: stat.size, mtimeMs: stat.mtimeMs, scanned, offset: lastComplete, forkAt, cutAt }
}

export interface CutResult {
  /** Where the removed part of the transcript was kept. */
  backup: string
  removedBytes: number
}

/**
 * Cut the transcript at the point a rewind goes back to, the way Claude Code's own rewind does:
 * everything after it goes, and the removed part is kept beside the transcript under a name that
 * does not end in .jsonl (which is all Claude Code looks at), so nothing is lost for good.
 */
export async function cutTranscript(file: string, cutAt: number): Promise<CutResult> {
  const size = fs.statSync(file).size
  if (!Number.isFinite(cutAt) || cutAt <= 0 || cutAt >= size) {
    throw new Error('There is nothing before that prompt to go back to.')
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.rewound-${stamp}`
  await new Promise<void>((resolve, reject) => {
    const from = fs.createReadStream(file, { start: cutAt })
    const to = fs.createWriteStream(backup)
    from.on('error', reject)
    to.on('error', reject)
    to.on('close', () => resolve())
    from.pipe(to)
  })
  await fsp.truncate(file, cutAt)
  return { backup, removedBytes: size - cutAt }
}
