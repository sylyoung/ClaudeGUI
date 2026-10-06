/**
 * The timestamps and recaps of a Claude Code transcript, read straight from its file. Used by the
 * session host when it loads a chat, and by the app itself when it shows an older part of a chat
 * that a search found (see transcriptSearch.ts).
 */
import fs from 'fs'

/** A recap the CLI wrote into the transcript: its note about what happened while the user was away. */
export interface TranscriptRecap {
  /** uuid of the transcript entry, which is what the chat row is keyed by. */
  id: string
  text: string
  ts: number
}

export interface TranscriptIndex {
  /** uuid → the entry's own timestamp. */
  stamps: Map<string, number>
  /** The recaps in the file, oldest first. */
  recaps: TranscriptRecap[]
}

/** A line longer than this can only be an answer or a tool result, never a recap or a compaction
 *  notice, so the middle of it is thrown away as the file is read instead of being held in one
 *  piece: it is the length of the lines, not the length of the file, that costs the memory. */
const INDEX_LINE_MAX = 1024 * 1024
/** How much of such a line is kept: its end, which is where the uuid and the timestamp are. */
const INDEX_LINE_TAIL = 16 * 1024

/**
 * The timestamp of each entry of a transcript, and the recaps in it, in one pass over the file.
 * Claude Code hands a chat's history back without the entries' own timestamps and without the
 * recaps at all (a recap arrives as a system message whose file entry carries the text, which the
 * history reader does not pass on), so both are read from the transcript itself.
 *
 * Only the part of the file the chat is loaded from is read — `from` to `to` in bytes, the same
 * range the messages themselves came from — because the times are wanted for those messages and no
 * others. A pass over the whole of a large transcript is not free: 5.6 s for a 2 GB one.
 *
 * The file is read in pieces and no line is ever held whole beyond a megabyte, so a range of any
 * size can be indexed at a cost of a few megabytes of memory.
 */
export async function readTranscriptIndex(file: string, from = 0, to?: number): Promise<TranscriptIndex> {
  const stamps = new Map<string, number>()
  const recaps: TranscriptRecap[] = []
  try {
    fs.statSync(file)
  } catch {
    return { stamps, recaps }
  }
  const re = /"uuid":"([0-9a-f-]{36})"[^\n]*?"timestamp":"([^"]+)"|"timestamp":"([^"]+)"[^\n]*?"uuid":"([0-9a-f-]{36})"/
  const takeLine = (line: string, whole: boolean): void => {
    if (whole && line.includes('"subtype":"away_summary"')) {
      try {
        const entry = JSON.parse(line) as { uuid?: string; content?: string; timestamp?: string }
        const t = Date.parse(entry.timestamp ?? '')
        if (entry.uuid && entry.content?.trim() && !Number.isNaN(t)) recaps.push({ id: entry.uuid, text: entry.content, ts: t })
      } catch {
        // Transcripts are appended line by line, so the last line can be half written.
      }
    }
    if (!line.includes('"timestamp"')) return
    const m = re.exec(line)
    if (!m) return
    const uuid = m[1] ?? m[4]
    const t = Date.parse(m[2] ?? m[3])
    if (uuid && !Number.isNaN(t)) stamps.set(uuid, t)
  }
  let rest = Buffer.alloc(0)
  // A range that starts inside a line starts with the tail of that line, which belongs to the
  // entry before it: it is dropped rather than parsed as an entry of its own.
  let whole = from === 0
  let first = from > 0
  for await (const chunk of fs.createReadStream(file, { start: from, end: to === undefined ? undefined : Math.max(from, to - 1) }) as AsyncIterable<Buffer>) {
    let at = 0
    for (let nl = chunk.indexOf(10, at); nl !== -1; nl = chunk.indexOf(10, at)) {
      const part = chunk.subarray(at, nl)
      if (first) first = false
      else takeLine((rest.length ? Buffer.concat([rest, part]) : part).toString('utf8'), whole)
      rest = Buffer.alloc(0)
      whole = true
      at = nl + 1
    }
    rest = Buffer.concat([rest, chunk.subarray(at)])
    if (rest.length > INDEX_LINE_MAX) {
      rest = Buffer.from(rest.subarray(rest.length - INDEX_LINE_TAIL))
      whole = false
    }
  }
  if (rest.length && !first) takeLine(rest.toString('utf8'), whole)
  return { stamps, recaps }
}
