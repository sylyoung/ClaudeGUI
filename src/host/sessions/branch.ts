/**
 * Forking a chat exactly the way Claude Code's own /branch does.
 *
 * The Agent SDK's forkSession() — what this app used before — is not /branch: it reads the whole
 * transcript in one readFile (which Node refuses past 2 GB, and the error comes back as "Session …
 * not found"), copies every line of the session's history under fresh ids, and names the copy after
 * the chat. /branch is a different, interactive-only command, so it is reproduced here from Claude
 * Code's own code (version 2.1.280, the CLI bundled with this app), step by step and in the same
 * order. sandbox/tools/run-cli-branch-on-copy.py runs the real /branch on a copy of a chat to check
 * the result against.
 *
 * What /branch does with a chat that has been opened from its transcript:
 *
 * 1. The conversation it copies is the one Claude Code holds after loading the transcript to resume
 *    it (loadConversationForResume): the newest line of the conversation is chosen from the "last
 *    prompt" markers and the links between entries, the parent links are walked back from it to the
 *    last compaction (whose summary and preserved messages come first), parallel tool calls that
 *    the single parent link leaves out are put back, and the resume filters drop what Claude Code
 *    would not send again (transient attachments, unreadable rows, tool calls that never got a
 *    result, whitespace-only or orphaned-thinking replies, retracted messages).
 * 2. createFork streams the transcript once and, for every message of that conversation, writes the
 *    transcript's own entry again — same uuid — with the new session id, the parent set to the entry
 *    before it (the copy is one straight line), `isSidechain: false` and a `forkedFrom` note. Then
 *    one record of all the session's content replacements, its memory-mode records, its relocation,
 *    and its "atis" latch.
 * 3. The copy is named after its first prompt — "<first prompt> (Branch)", or "(Branch 2)", "(Branch
 *    3)"… when that name is taken in the project — unless /branch was given a name; the name is
 *    written as a custom title and an agent name, and into <project>/<new id>/custom-title.json.
 *
 * Reading: Claude Code loads a transcript over 5 MB in two passes — the first only looks at each
 * line's bytes to find ids and parent links, the second parses the lines the conversation can be
 * made of. Here the same, with one shortcut: of the part Claude Code parses, its own loader
 * (pqRelink below) deletes again everything before the last compaction except the messages that
 * compaction preserved, so only those and the lines from the last compaction on are parsed — for a
 * 3.5 GB chat a few megabytes instead of all of it (13 s, about 260 MB at the peak). When Claude
 * Code would give up on that relink and keep everything, everything is read here too.
 *
 * Where Claude Code's behaviour hangs on a feature flag it fetches (the order of the entries after
 * the newest message, how old an unanswered API error may be), the flag's default is used. Checked
 * against the real /branch on 13 chats and hand-made variants (sandbox/tools/check-branch-port.mts):
 * identical, line for line.
 */
import fsp from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------------------------
// Entries

type Entry = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const DR_TYPES = new Set(['user', 'assistant', 'attachment', 'system'])
/** A plain object, as Claude Code checks before trusting any parsed line. */
const isObject = (e: unknown): e is Entry => typeof e === 'object' && e !== null && !Array.isArray(e)
/** A conversation entry: what goes into the message map. */
const isMessage = (e: unknown): boolean => isObject(e) && typeof e.type === 'string' && DR_TYPES.has(e.type)
/** A progress line: not kept, but children that name it as parent are re-linked past it. */
const isProgress = (e: unknown): boolean => isObject(e) && e.type === 'progress' && typeof e.uuid === 'string'
const isBoundary = (e: Entry | undefined): boolean => e?.type === 'system' && e.subtype === 'compact_boundary'
const hasBlock = (content: unknown, type: string): boolean =>
  Array.isArray(content) && content.some((b) => isObject(b) && b.type === type)
const isUserOrAssistant = (e: Entry): boolean => e.type === 'user' || e.type === 'assistant'

// ---------------------------------------------------------------------------------------------
// Reading lines with their offsets, a megabyte at a time (Claude Code's own reader does the same).

type LineFn = (buf: Buffer, start: number, len: number, offset: number) => void

async function scanLines(fh: fsp.FileHandle, size: number, onLine: LineFn, want?: (offset: number) => boolean): Promise<void> {
  const CHUNK = 1 << 20
  const chunk = Buffer.allocUnsafe(CHUNK)
  let spill = Buffer.allocUnsafe(1 << 16)
  let pending = -1
  let pos = 0
  while (pos < size) {
    const { bytesRead } = await fh.read(chunk, 0, Math.min(CHUNK, size - pos), pos)
    if (bytesRead === 0) break
    let i = 0
    while (i < bytesRead) {
      const nl = chunk.indexOf(10, i)
      if (nl < 0 || nl >= bytesRead) break
      if (pending >= 0) {
        if (want === undefined || want(pending)) {
          const len = pos + nl - pending
          if (len > spill.length) spill = Buffer.allocUnsafe(len)
          await fh.read(spill, 0, len, pending)
          onLine(spill, 0, len, pending)
        }
        pending = -1
      } else if (nl > i) {
        if (want === undefined || want(pos + i)) onLine(chunk, i, nl - i, pos + i)
      }
      i = nl + 1
    }
    if (i < bytesRead && pending < 0) pending = pos + i
    pos += bytesRead
  }
  if (pending >= 0 && (want === undefined || want(pending))) {
    const len = size - pending
    if (len > spill.length) spill = Buffer.allocUnsafe(len)
    await fh.read(spill, 0, len, pending)
    onLine(spill, 0, len, pending)
  }
}

async function readLine(fh: fsp.FileHandle, offset: number, length: number): Promise<Entry | null> {
  const buf = Buffer.allocUnsafe(length)
  await fh.read(buf, 0, length, offset)
  try {
    const e = JSON.parse(buf.toString('utf8'))
    return isObject(e) ? e : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Pass 1: the bytes of every line (Claude Code's loadTranscriptFile for files over 5 MB).

const BIG_FILE = 5 * 1024 * 1024
const B = (s: string): Buffer => Buffer.from(s)
const ATTRIBUTION = B('{"type":"attribution-snapshot"')
const LEDGER = B('{"type":"artifact-autoreact-ledger"')
const PARENT_FIRST = B('{"parentUuid":')
const PARENT_KEY = B('"parentUuid":')
const UUID_KEY = B('"uuid":"')
const AFTER_UUID = B('","timestamp":"')
const SIDECHAIN = B('"isSidechain":true')
const BOUNDARY = B('"compact_boundary"')
const LAST_PROMPT = B('"type":"last-prompt"')

/** Index of `key` at the top level of the JSON object in buf[from, to), outside strings. */
function topLevelKey(buf: Buffer, from: number, to: number, key: Buffer): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < to; i++) {
    const c = buf[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (c === 92) escaped = true
      else if (c === 34) inString = false
      continue
    }
    if (depth === 1 && c === key[0] && i + key.length <= to && buf.compare(key, 0, key.length, i, i + key.length) === 0) return i
    if (c === 34) inString = true
    else if (c === 123) depth++
    else if (c === 125) depth--
  }
  return -1
}

/** Of several candidate positions, the one at the top level of the object (else the last). */
function topLevelOf(buf: Buffer, from: number, candidates: number[]): number {
  let depth = 0
  let inString = false
  let escaped = false
  let k = 0
  for (let j = from; k < candidates.length; j++) {
    if (j === candidates[k]) {
      if (depth === 1 && !inString) return candidates[k]
      k++
    }
    const c = buf[j]
    if (escaped) escaped = false
    else if (inString) {
      if (c === 92) escaped = true
      else if (c === 34) inString = false
    } else if (c === 34) inString = true
    else if (c === 123) depth++
    else if (c === 125) depth--
  }
  return candidates[candidates.length - 1]
}

/** Where the entry's own "uuid" key is: the one followed by its timestamp, at the top level. */
function uuidKeyAt(buf: Buffer, start: number, end: number): number {
  let first = -1
  let firstStamped = -1
  let stamped: number[] | undefined
  let from = start
  for (;;) {
    const at = buf.indexOf(UUID_KEY, from)
    if (at < 0 || at >= end) break
    if (first < 0) first = at
    const after = at + UUID_KEY.length + 36
    if (after + AFTER_UUID.length <= end && buf.compare(AFTER_UUID, 0, AFTER_UUID.length, after, after + AFTER_UUID.length) === 0) {
      if (firstStamped < 0) firstStamped = at
      else (stamped ??= [firstStamped]).push(at)
    }
    from = at + UUID_KEY.length
  }
  return stamped ? topLevelOf(buf, start, stamped) : firstStamped >= 0 ? firstStamped : first
}

const includesIn = (buf: Buffer, start: number, len: number, limit: number, needle: Buffer): boolean =>
  buf.subarray(start, start + Math.min(len, limit)).includes(needle)

interface Pass1 {
  /** Offsets of the indexed lines (those with a parentUuid and a uuid) since the last plain compaction. */
  offsets: number[]
  parents: (string | null)[]
  sidechain: boolean[]
  slotOf: Map<string, number>
  /** Lines without a parent/uuid (titles, markers, …): always read in pass 2. */
  other: number[]
  /** Offsets of compactions that preserved nothing: the loader starts over at each. */
  plainBoundaries: Set<number>
  /** A compaction that preserved messages came after the last plain one. */
  preservedSince: boolean
  /** Leaf of the last "last-prompt" marker since the last plain compaction. */
  lastPromptLeaf: string | undefined
  /** Offset and length of the last compaction of either kind, and its entry. */
  lastBoundary: { offset: number; length: number; entry: Entry } | undefined
  /** uuid → offset of its first line, for uuids written more than once (a Map keeps the first place). */
  firstOfRepeated: Map<string, number>
}

async function pass1(fh: fsp.FileHandle, size: number): Promise<Pass1> {
  const p: Pass1 = {
    offsets: [],
    parents: [],
    sidechain: [],
    slotOf: new Map(),
    other: [],
    plainBoundaries: new Set(),
    preservedSince: false,
    lastPromptLeaf: undefined,
    lastBoundary: undefined,
    firstOfRepeated: new Map()
  }
  await scanLines(fh, size, (buf, start, len, offset) => {
    if (len >= ATTRIBUTION.length && buf.compare(ATTRIBUTION, 0, ATTRIBUTION.length, start, start + ATTRIBUTION.length) === 0) return
    let s = start
    while (s < start + len && buf[s] === 0) s++
    if (start + len - s >= LEDGER.length && buf.compare(LEDGER, 0, LEDGER.length, s, s + LEDGER.length) === 0) return
    if (len < 1024 && includesIn(buf, start, len, 64, LAST_PROMPT)) {
      let e: Entry
      try {
        e = JSON.parse(buf.toString('utf8', start, start + len))
      } catch {
        return
      }
      if (e?.type === 'last-prompt') {
        if (e.leafUuid) p.lastPromptLeaf = e.leafUuid
        p.other.push(offset)
        return
      }
    }
    if (includesIn(buf, start, len, 4096, BOUNDARY)) {
      let e: Entry | null = null
      try {
        e = JSON.parse(buf.toString('utf8', start, start + len))
      } catch {
        e = null
      }
      if (e?.type === 'system' && e.subtype === 'compact_boundary') {
        p.lastBoundary = { offset, length: len, entry: e }
        if (e.compactMetadata?.preservedSegment || e.compactMetadata?.preservedMessages) p.preservedSince = true
        else {
          p.plainBoundaries.add(offset)
          p.offsets.length = 0
          p.parents.length = 0
          p.sidechain.length = 0
          p.slotOf.clear()
          p.firstOfRepeated.clear()
          p.preservedSince = false
          p.lastPromptLeaf = undefined
        }
      }
    }
    let at: number
    if (len > PARENT_FIRST.length && buf.compare(PARENT_FIRST, 0, PARENT_FIRST.length, start, start + PARENT_FIRST.length) === 0) at = start + PARENT_FIRST.length
    else {
      at = topLevelKey(buf, start, start + len, PARENT_KEY)
      if (at < 0) {
        p.other.push(offset)
        return
      }
      at += PARENT_KEY.length
    }
    const parent = buf[at] === 34 ? buf.toString('latin1', at + 1, at + 37) : null
    const u = uuidKeyAt(buf, start, start + len)
    if (u < 0) {
      p.other.push(offset)
      return
    }
    const uuid = buf.toString('latin1', u + UUID_KEY.length, u + UUID_KEY.length + 36)
    const earlier = p.slotOf.get(uuid)
    if (earlier !== undefined && !p.firstOfRepeated.has(uuid)) p.firstOfRepeated.set(uuid, p.offsets[earlier])
    p.slotOf.set(uuid, p.offsets.length)
    p.offsets.push(offset)
    p.parents.push(parent)
    p.sidechain.push(includesIn(buf, start, len, 256, SIDECHAIN))
  })
  return p
}

// ---------------------------------------------------------------------------------------------
// The loader's per-entry state (Claude Code's processEntry and finish).

/** Rows Claude Code repairs or drops when it loads them: content it cannot read. */
function rowRepair(type: string, message: unknown): 'keep' | 'drop' | { content: unknown[] } {
  if (!isObject(message)) return 'drop'
  const content = message.content
  if (typeof content === 'string') {
    if (type !== 'assistant') return 'keep'
    if (content.trim() === '') return 'drop'
    return { content: [{ type: 'text', text: content }] }
  }
  if (!Array.isArray(content)) return 'drop'
  const ok = (b: unknown): boolean => isObject(b) && typeof b.type === 'string'
  if (content.every(ok)) return 'keep'
  const kept = content.filter(ok)
  return kept.length === 0 ? 'drop' : { content: kept }
}

class Loader {
  messages = new Map<string, Entry>()
  /** uuid → parent of rows dropped as unreadable, so their children can be re-linked past them. */
  private dropped = new Map<string, string | null>()
  /** uuid → parent of progress lines. */
  private progress = new Map<string, string | null>()
  private lastUuid: string | undefined
  private newestUuid: string | undefined
  private newestStamp = ''
  private promptLeaf: string | undefined
  private promptExplicit = false
  private promptRewound = false
  private cleared = false
  private sawPromptMarker = false
  historySuppressed = new Set<string>()
  atisLatches = new Map<string, string>()
  contentReplacements = new Map<string, unknown[]>()
  memoryModes = new Map<string, Entry[]>()
  relocated = new Map<string, string>()

  process(raw: unknown): void {
    if (!isObject(raw)) return
    const e = raw
    if (isProgress(e)) {
      const p = e.parentUuid
      this.progress.set(e.uuid, p && this.progress.has(p) ? (this.progress.get(p) ?? null) : p)
      return
    }
    if (isMessage(e)) {
      if (e.parentUuid && this.progress.has(e.parentUuid)) e.parentUuid = this.progress.get(e.parentUuid) ?? null
      if (!this.admit(e)) return
      this.messages.set(e.uuid, e)
      if (!e.isSidechain && !(e.type === 'attachment' && e.attachment?.type === 'fork_briefing')) {
        this.lastUuid = e.uuid
        if (typeof e.timestamp === 'string' && e.timestamp > this.newestStamp) {
          this.newestUuid = e.uuid
          this.newestStamp = e.timestamp
        }
        this.promptExplicit = false
        this.cleared = false
        this.promptRewound = false
      }
      if (isBoundary(e)) {
        this.promptLeaf = undefined
        this.promptExplicit = false
      }
      return
    }
    switch (e.type) {
      case 'last-prompt':
        if (e.leafUuid !== undefined) this.sawPromptMarker = true
        if (e.leafUuid) {
          this.promptExplicit = e.explicit === true || (this.promptExplicit && e.leafUuid === this.promptLeaf)
          this.promptRewound = e.rewound === true || (this.promptRewound && e.leafUuid === this.promptLeaf)
          this.promptLeaf = e.leafUuid
          this.cleared = false
        } else if (e.leafUuid === null && e.explicit === true) {
          this.cleared = true
          this.promptLeaf = undefined
          this.promptExplicit = false
          this.promptRewound = false
        }
        break
      case 'history-suppression':
        if (e.sessionId) this.historySuppressed.add(e.sessionId)
        break
      case 'atis-latch':
        if (e.sessionId && typeof e.atis === 'string' && /^[\x21-\x7e]*$/.test(e.atis)) this.atisLatches.set(e.sessionId, e.atis)
        break
      case 'relocated':
        if (e.sessionId) this.relocated.set(e.sessionId, e.relocatedCwd)
        break
      case 'memory-mode':
        if (e.sessionId && (e.mode === 'on' || e.mode === 'off') && (typeof e.afterUuid === 'string' || e.afterUuid === null) && typeof e.timestamp === 'string') {
          const list = this.memoryModes.get(e.sessionId) ?? []
          this.memoryModes.set(e.sessionId, list)
          list.push(e)
        }
        break
      case 'content-replacement':
        if (!e.agentId) {
          const list = this.contentReplacements.get(e.sessionId) ?? []
          this.contentReplacements.set(e.sessionId, list)
          list.push(...e.replacements)
        }
        break
    }
  }

  /** At a compaction that preserved nothing (big files only): what came before is not kept. */
  dropBeforeBoundary(): void {
    this.messages.clear()
    this.progress.clear()
  }

  private admit(e: Entry): boolean {
    try {
      if (e.type === 'system' || (e.type !== 'user' && e.type !== 'assistant')) return true
      const r = rowRepair(e.type, e.message)
      if (r === 'keep') return true
      if (r !== 'drop') {
        e.message.content = r.content
        return true
      }
      if (!this.messages.has(e.uuid)) this.dropped.set(e.uuid, e.parentUuid)
      return false
    } catch {
      return true
    }
  }

  /** Children of dropped rows hang off the nearest kept ancestor instead. */
  private relinkPastDropped(): void {
    if (this.dropped.size === 0) return
    const resolve = (start: string): string | null => {
      const seen = new Set<string>()
      let at: string | null = start
      while (at !== null && !this.messages.has(at) && this.dropped.has(at)) {
        if (seen.has(at)) {
          at = null
          break
        }
        seen.add(at)
        at = this.dropped.get(at) ?? null
      }
      for (const s of seen) this.dropped.set(s, at)
      return at
    }
    for (const e of this.messages.values()) {
      const p = e.parentUuid
      if (p !== null && !this.messages.has(p) && this.dropped.has(p)) e.parentUuid = resolve(p)
    }
  }

  /**
   * After the last line. `before` are uuids Claude Code holds at a place before the last compaction
   * although they were read after it; `relinked` runs after the relink, before the leaf is chosen.
   */
  finish(
    before: Set<string> = new Set(),
    relinked?: (tail: string) => void
  ): { leaves: Set<string>; cleared: boolean; rewindAnchor: string | undefined; complete: boolean } {
    this.relinkPastDropped()
    const r = pqRelink(this.messages, before)
    if (r.tail !== undefined && relinked) relinked(r.tail)
    return { leaves: this.chooseLeaves(r.tail), cleared: this.cleared, rewindAnchor: this.promptRewound ? this.promptLeaf : undefined, complete: r.complete }
  }

  /** Which conversation the chat is on: Claude Code's leaf choice after loading. */
  private chooseLeaves(tail: string | undefined): Set<string> {
    const n = this.messages
    if (this.cleared) return new Set()
    const leaves = new Set<string>()
    const explicitLeaf = this.promptExplicit && this.promptLeaf && n.has(this.promptLeaf) && !n.get(this.promptLeaf)?.isSidechain
    const newestReaching = (target: string): string => {
      const reaches = new Map<string, boolean>([[target, true]])
      const check = (start: string): boolean => {
        const walked: string[] = []
        let result = false
        let at: string | undefined = start
        while (at) {
          const known = reaches.get(at)
          if (known !== undefined) {
            result = known
            break
          }
          reaches.set(at, false)
          walked.push(at)
          at = n.get(at)?.parentUuid ?? undefined
        }
        for (const w of walked) reaches.set(w, result)
        return result
      }
      let best = target
      let bestStamp = ''
      for (const e of n.values())
        if (!e.isSidechain && e.uuid !== target && typeof e.timestamp === 'string' && e.timestamp >= bestStamp && check(e.uuid)) {
          best = e.uuid
          bestStamp = e.timestamp
        }
      return best
    }
    let last = this.lastUuid
    if (!this.sawPromptMarker && last && this.newestUuid && this.newestUuid !== last) last = newestReaching(last)
    if (!tail || explicitLeaf) {
      let leaf = this.promptLeaf && n.has(this.promptLeaf) ? this.promptLeaf : undefined
      if (leaf && !this.promptExplicit && this.lastUuid && n.has(this.lastUuid) && this.lastUuid !== leaf) {
        let at: string | undefined = this.lastUuid
        const seen = new Set<string>()
        while (at && !seen.has(at)) {
          if (at === leaf) {
            leaf = this.lastUuid
            break
          }
          seen.add(at)
          at = n.get(at)?.parentUuid ?? undefined
        }
      }
      if (!tail) leaf ??= last
      if (leaf && n.has(leaf)) {
        const seen = new Set<string>()
        let at = n.get(leaf)
        while (at) {
          if (seen.has(at.uuid)) break
          seen.add(at.uuid)
          if (isUserOrAssistant(at)) {
            leaves.add(at.uuid)
            break
          }
          at = at.parentUuid ? n.get(at.parentUuid) : undefined
        }
        if (leaves.size === 1) return leaves
      }
    }
    const parents = new Set<string | undefined>()
    const conversationalParents = new Set<string | undefined>()
    for (const e of n.values())
      if (e.parentUuid !== null) {
        parents.add(e.parentUuid)
        if (isUserOrAssistant(e)) conversationalParents.add(e.parentUuid)
      }
    for (const e of n.values()) {
      if (parents.has(e.uuid)) continue
      const seen = new Set<string>()
      let at: Entry | undefined = e
      while (at) {
        if (seen.has(at.uuid)) break
        seen.add(at.uuid)
        if (isUserOrAssistant(at)) {
          if (!conversationalParents.has(at.uuid)) leaves.add(at.uuid)
          break
        }
        at = at.parentUuid ? n.get(at.parentUuid) : undefined
      }
    }
    if (leaves.size > 1) {
      const from = this.promptLeaf && leaves.has(this.promptLeaf) ? this.promptLeaf : this.lastUuid
      if (!from || !n.has(from)) return leaves
      const seen = new Set<string>()
      let at = n.get(from)
      while (at) {
        if (seen.has(at.uuid)) break
        seen.add(at.uuid)
        if (isUserOrAssistant(at)) {
          leaves.clear()
          leaves.add(at.uuid)
          break
        }
        at = at.parentUuid ? n.get(at.parentUuid) : undefined
      }
    }
    return leaves
  }
}

/** The preserved messages of a compaction, in order: listed, or walked from tail to head. */
function preservedOf(meta: Entry, n: Map<string, Entry>): { anchorUuid: string; uuids: string[] } | undefined {
  if (meta.preservedMessages) return meta.preservedMessages
  const seg = meta.preservedSegment
  if (!seg) return undefined
  const seen = new Set<string>()
  const uuids: string[] = []
  let at = n.get(seg.tailUuid)
  while (at && !seen.has(at.uuid)) {
    seen.add(at.uuid)
    uuids.push(at.uuid)
    if (at.uuid === seg.headUuid) return { anchorUuid: seg.anchorUuid, uuids: uuids.reverse() }
    at = at.parentUuid ? n.get(at.parentUuid) : undefined
  }
  return undefined
}

/**
 * Claude Code's relink after loading: the last compaction's preserved messages are spliced in after
 * its anchor, and everything before the last compaction is dropped. Returns the last preserved uuid,
 * and `complete: false` when Claude Code gives up instead (the preserved messages are not all there)
 * and keeps everything it read.
 */
function pqRelink(n: Map<string, Entry>, before: Set<string>): { tail: string | undefined; complete: boolean } {
  let meta: Entry | undefined
  let metaAt = -1
  let lastAt = -1
  const index = new Map<string, number>()
  let i = 0
  for (const e of n.values()) {
    index.set(e.uuid, i)
    if (isBoundary(e)) {
      lastAt = i
      const m = e.compactMetadata
      if (m?.preservedMessages || m?.preservedSegment) {
        meta = m
        metaAt = i
      }
    }
    i++
  }
  if (!meta) return { tail: undefined, complete: true }
  const isLast = metaAt === lastAt
  const found = isLast ? preservedOf(meta, n) : undefined
  if (isLast && !found) return { tail: undefined, complete: false }
  const preserved = found && found.uuids.length > 0 ? found : undefined
  if (preserved?.uuids.some((u) => !n.has(u))) return { tail: undefined, complete: false }
  const kept = preserved?.uuids ?? []
  const keptSet = new Set(kept)
  if (preserved) {
    const tail = kept[kept.length - 1]
    let prev = preserved.anchorUuid
    for (const u of kept) {
      n.set(u, { ...n.get(u), parentUuid: prev })
      prev = u
    }
    for (const [u, e] of n) if (e.parentUuid === preserved.anchorUuid && u !== kept[0]) n.set(u, { ...e, parentUuid: tail })
  }
  const gone: string[] = []
  for (const [u] of n) {
    const at = index.get(u)
    if (at !== undefined && (at < lastAt || before.has(u)) && !keptSet.has(u)) gone.push(u)
  }
  for (const u of gone) n.delete(u)
  if (preserved && gone.length > 0) {
    const tail = kept[kept.length - 1]
    const goneSet = new Set(gone)
    for (const [u, e] of n) if (isUserOrAssistant(e) && e.parentUuid !== null && goneSet.has(e.parentUuid)) n.set(u, { ...e, parentUuid: tail })
  }
  return { tail: kept[kept.length - 1], complete: true }
}

// ---------------------------------------------------------------------------------------------
// Loading the transcript the way Claude Code does for a resume.

interface Loaded {
  loader: Loader
  leaves: Set<string>
  cleared: boolean
  rewindAnchor: string | undefined
}

async function loadSmall(fh: fsp.FileHandle, size: number): Promise<Loaded> {
  const loader = new Loader()
  await scanLines(fh, size, (buf, start, len) => {
    try {
      loader.process(JSON.parse(buf.toString('utf8', start, start + len)))
    } catch {
      /* a line Claude Code's reader skips too */
    }
  })
  return { loader, ...loader.finish() }
}

/** Claude Code's run-continuation test for lines outside the walked set (second pass). */
function continuesRun(e: Entry, runId: string | null): boolean {
  if (isProgress(e)) return true
  if (!isMessage(e)) return false
  switch (e.type) {
    case 'assistant':
      return runId !== null && e.message?.id === runId
    case 'user':
      return e.isMeta === true || hasBlock(e.message?.content, 'tool_result')
    case 'attachment':
      return true
    case 'system':
      return e.subtype !== 'compact_boundary'
  }
  return false
}
const runIdOf = (e: Entry, inherited: string | null): string | null => (isMessage(e) && e.type === 'assistant' ? (e.message?.id ?? null) : inherited)
const linksRun = (e: Entry): boolean =>
  isProgress(e) ||
  (isMessage(e) &&
    (e.type === 'attachment' || (e.type === 'system' ? e.subtype !== 'compact_boundary' : e.type === 'user' && e.isMeta === true && !hasBlock(e.message?.content, 'tool_result'))))

async function loadBig(fh: fsp.FileHandle, size: number): Promise<Loaded> {
  const p = await pass1(fh, size)
  // The lines the conversation can be made of: walked from the last line and from the last
  // "last prompt" marker — unless a compaction that preserved messages came after the last plain
  // one, in which case Claude Code reads them all.
  let walked: Set<number> | null = null
  if (!p.preservedSince) {
    let last = -1
    for (let i = p.offsets.length - 1; i >= 0; i--)
      if (!p.sidechain[i]) {
        last = i
        break
      }
    if (last >= 0) {
      const set = new Set<number>()
      const visited = new Set<number>()
      let phantom = false
      const walk = (start: number | undefined): void => {
        let at = start
        while (at !== undefined && !visited.has(at)) {
          visited.add(at)
          set.add(p.offsets[at])
          const parent = p.parents[at]
          if (parent == null) break
          const slot = p.slotOf.get(parent)
          if (slot === undefined) {
            phantom = true
            break
          }
          at = slot
        }
      }
      walk(last)
      walk(p.lastPromptLeaf ? p.slotOf.get(p.lastPromptLeaf) : undefined)
      if (!phantom) walked = set
    }
  }
  if (walked !== null) return loadWalked(fh, size, p, walked)

  // Claude Code reads every line after the last plain compaction, and its relink then drops again
  // everything before the last compaction of any kind except what that compaction preserved. So
  // read only those preserved lines and the lines from the last compaction on (plus the small
  // records without a parent, which carry the "last prompt" markers). If Claude Code would give up
  // on the relink — a preserved message is not there — it keeps everything, and so must this.
  const reduced = await loadFrom(fh, size, p, p.lastBoundary?.offset ?? 0, true)
  if (reduced.complete) return reduced
  return loadFrom(fh, size, p, p.offsets[0] ?? 0, false)
}

async function loadFrom(fh: fsp.FileHandle, size: number, p: Pass1, from: number, reduced: boolean): Promise<Loaded & { complete: boolean }> {
  const loader = new Loader()
  const keep = new Set<number>()
  const meta = reduced ? p.lastBoundary?.entry.compactMetadata : undefined
  const preservedUuids = new Set<string>()
  if (meta?.preservedMessages) for (const u of meta.preservedMessages.uuids ?? []) preservedUuids.add(u)
  for (const u of preservedUuids) {
    const slot = p.slotOf.get(u)
    if (slot !== undefined) keep.add(p.offsets[slot])
    const first = p.firstOfRepeated.get(u)
    if (first !== undefined) keep.add(first)
  }
  if (meta?.preservedSegment && !meta.preservedMessages) {
    // Walked from tail to head through the parent links, as preservedOf will.
    let slot = p.slotOf.get(meta.preservedSegment.tailUuid)
    const seen = new Set<number>()
    while (slot !== undefined && !seen.has(slot)) {
      seen.add(slot)
      keep.add(p.offsets[slot])
      const parent = p.parents[slot]
      if (parent == null || p.slotOf.get(meta.preservedSegment.headUuid) === slot) break
      slot = p.slotOf.get(parent)
    }
  }
  const other = new Set(p.other)
  // uuids read after the last compaction whose first line was before it: Claude Code holds them at
  // that first place, so its relink drops them.
  const before = new Set<string>()
  await scanLines(
    fh,
    size,
    (buf, start, len, offset) => {
      if (p.plainBoundaries.has(offset)) loader.dropBeforeBoundary()
      let e: unknown
      try {
        e = JSON.parse(buf.toString('utf8', start, start + len))
      } catch {
        return
      }
      const uuid = isMessage(e) ? (e as Entry).uuid : undefined
      if (reduced && offset >= from && typeof uuid === 'string') {
        const first = p.firstOfRepeated.get(uuid)
        if (first !== undefined && first < from && !keep.has(first)) before.add(uuid)
      }
      loader.process(e)
    },
    (offset) => offset >= from || keep.has(offset) || other.has(offset)
  )
  const result = loader.finish(before, (tail) => {
    if (!reduced) return
    // A message after the last compaction whose parent was dropped before it is re-linked to the
    // last preserved message. Those parents were never read here; the index knows them.
    for (const [u, e] of loader.messages) {
      if (!isUserOrAssistant(e) || e.parentUuid === null || e.parentUuid === undefined) continue
      if (loader.messages.has(e.parentUuid)) continue
      const slot = p.slotOf.get(e.parentUuid)
      if (slot !== undefined && p.offsets[slot] < from) loader.messages.set(u, { ...e, parentUuid: tail })
    }
  })
  return { loader, ...result }
}

/** Claude Code's second pass when it could walk the conversation's lines: those, line for line. */
async function loadWalked(fh: fsp.FileHandle, size: number, p: Pass1, walked: Set<number>): Promise<Loaded> {
  const loader = new Loader()
  const slotAt = new Map<number, number>()
  for (let i = 0; i < p.offsets.length; i++) slotAt.set(p.offsets[i], i)
  const readSet = new Set<number>(walked)
  for (const o of p.other) readSet.add(o)
  const runs = new Map<number, string | null>()
  const linkSlots = new Set<number>()
  const parentSlot = (slot: number): number | undefined => {
    const parent = p.parents[slot]
    return parent == null ? undefined : p.slotOf.get(parent)
  }
  await scanLines(
    fh,
    size,
    (buf, start, len, offset) => {
      if (p.plainBoundaries.has(offset)) loader.dropBeforeBoundary()
      let s = start
      while (s < start + len && buf[s] === 0) s++
      if (s === start + len) return
      const slot = slotAt.get(offset) ?? -1
      const pslot = slot >= 0 ? parentSlot(slot) : undefined
      const runId = pslot === undefined ? null : (runs.get(pslot) ?? null)
      let e: Entry | null = null
      try {
        e = JSON.parse(buf.toString('utf8', s, start + len))
      } catch {
        e = null
      }
      if (!e) {
        if (slot >= 0 && readSet.has(offset)) runs.set(slot, runId)
        return
      }
      if (slot >= 0) {
        if (!readSet.has(offset)) {
          if (isMessage(e) && isUserOrAssistant(e) && !isObject(e.message)) return
          if (!continuesRun(e, runId)) {
            if (pslot !== undefined && linkSlots.has(pslot)) loader.process(e)
            return
          }
        }
        runs.set(slot, runIdOf(e, runId))
        if (linksRun(e)) linkSlots.add(slot)
      }
      loader.process(e)
    },
    (offset) => {
      if (readSet.has(offset)) return true
      const slot = slotAt.get(offset)
      if (slot === undefined) return false
      const ps = parentSlot(slot)
      return ps !== undefined && runs.has(ps)
    }
  )
  return { loader, ...loader.finish() }
}

// ---------------------------------------------------------------------------------------------
// From the loaded messages to the conversation (Claude Code's resume: buildConversationChain and
// the resume filters).

/** The latest-timestamped entry passing `test` (the first of equals). */
function newest(entries: Iterable<Entry>, test: (e: Entry) => boolean): Entry | undefined {
  let best: Entry | undefined
  let bestTime = -Infinity
  for (const e of entries) {
    if (!test(e)) continue
    const t = Date.parse(e.timestamp)
    if (t > bestTime) {
      bestTime = t
      best = e
    }
  }
  return best
}

/** A parent that is missing: the nearest earlier entry within 5 s on the same side of the chat. */
function timestampFallback(n: Map<string, Entry>, from: Entry, seen: Set<string>): Entry | undefined {
  const t = new Date(from.timestamp).getTime()
  if (Number.isNaN(t)) return undefined
  let best: Entry | undefined
  let gap = Infinity
  for (const e of n.values()) {
    if (seen.has(e.uuid)) continue
    if (e.isSidechain !== from.isSidechain) continue
    const et = new Date(e.timestamp).getTime()
    if (Number.isNaN(et)) continue
    const d = t - et
    if (d >= 0 && d <= 5000 && d < gap) {
      gap = d
      best = e
    }
  }
  return best
}

const isRunLinkEntry = (e: Entry): boolean =>
  e.type === 'attachment' || (e.type === 'system' ? e.subtype !== 'compact_boundary' : e.type === 'user' && e.isMeta === true && !hasBlock(e.message?.content, 'tool_result'))

function continuesTurn(e: Entry, id: string): boolean {
  switch (e.type) {
    case 'assistant':
      return id !== null && e.message?.id === id
    case 'user':
      return e.isMeta === true || hasBlock(e.message?.content, 'tool_result')
    case 'attachment':
      return true
    case 'system':
      return e.subtype !== 'compact_boundary'
  }
  return false
}

/** Parallel tool calls and their results that the single parent link leaves out, put back. */
function recoverParallel(n: Map<string, Entry>, chain: Entry[], seen: Set<string>): Entry[] {
  const assistants = chain.filter((e) => e.type === 'assistant')
  if (assistants.length === 0) return chain
  const byMessageId = new Map<string, Entry[]>()
  const resultsByParent = new Map<string, Entry[]>()
  for (const e of n.values())
    if (e.type === 'assistant' && e.message?.id) {
      const l = byMessageId.get(e.message.id)
      if (l) l.push(e)
      else byMessageId.set(e.message.id, [e])
    } else if (e.type === 'user' && e.parentUuid && hasBlock(e.message?.content, 'tool_result')) {
      const l = resultsByParent.get(e.parentUuid)
      if (l) l.push(e)
      else resultsByParent.set(e.parentUuid, [e])
    }
  const position = new Map<string, number>()
  for (let i = 0; i < chain.length; i++) position.set(chain[i].uuid, i)
  let childrenOf: Map<string, Entry[]> | undefined
  let order: Map<string, number> | undefined
  const orderOf = (e: Entry): number => order!.get(e.uuid) ?? Number.MAX_SAFE_INTEGER
  const done = new Set<string>()
  const spans: { start: number; end: number; recovered: Entry[] }[] = []
  for (const a of assistants) {
    const id = a.message.id
    if (!id || done.has(id)) continue
    done.add(id)
    const group = byMessageId.get(id) ?? [a]
    const missing = group.filter((g) => !seen.has(g.uuid))
    const results: Entry[] = []
    for (const g of group) for (const r of resultsByParent.get(g.uuid) ?? []) if (!seen.has(r.uuid)) results.push(r)
    const recovered = [...missing, ...results]
    for (const r of recovered) seen.add(r.uuid)
    if (group.some((g) => g.type === 'assistant' && hasBlock(g.message?.content, 'tool_use'))) {
      if (!childrenOf) {
        childrenOf = new Map()
        for (const e of n.values()) {
          if (!e.parentUuid) continue
          const l = childrenOf.get(e.parentUuid)
          if (l) l.push(e)
          else childrenOf.set(e.parentUuid, [e])
        }
      }
      const heads = [...group, ...group.flatMap((g) => resultsByParent.get(g.uuid) ?? [])]
      for (const h of heads)
        for (const child of childrenOf.get(h.uuid) ?? []) {
          const tailRun: Entry[] = []
          let at: Entry | undefined = child
          let ok = true
          while (at !== undefined) {
            if (seen.has(at.uuid) || !(at.isSidechain === h.isSidechain && isRunLinkEntry(at))) {
              ok = false
              break
            }
            tailRun.push(at)
            const next: Entry[] = (childrenOf.get(at.uuid) ?? []).filter((x) => !seen.has(x.uuid))
            if (next.length > 1) {
              ok = false
              break
            }
            at = next[0]
          }
          if (!ok) continue
          for (const r of tailRun) {
            seen.add(r.uuid)
            recovered.push(r)
          }
        }
    }
    if (recovered.length === 0) continue
    const start = position.get(a.uuid)!
    let end = start + 1
    for (const g of group) {
      const at = position.get(g.uuid)
      if (at !== undefined && at >= end) end = at + 1
    }
    while (end < chain.length && continuesTurn(chain[end], id)) end++
    if (!order) {
      order = new Map()
      let k = 0
      for (const u of n.keys()) order.set(u, k++)
    }
    recovered.sort((x, y) => orderOf(x) - orderOf(y))
    spans.push({ start, end, recovered })
  }
  if (spans.length === 0) return chain
  spans.sort((x, y) => x.start - y.start)
  const merged: typeof spans = []
  for (const s of spans) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && s.start < prev.end) {
      prev.end = Math.max(prev.end, s.end)
      prev.recovered = [...prev.recovered, ...s.recovered].sort((x, y) => orderOf(x) - orderOf(y))
    } else merged.push(s)
  }
  const out: Entry[] = []
  let from = 0
  for (const { start, end, recovered } of merged) {
    out.push(...chain.slice(from, start + 1))
    let k = 0
    for (let i = start + 1; i < end; i++) {
      const at = orderOf(chain[i])
      while (k < recovered.length && orderOf(recovered[k]) < at) out.push(recovered[k++])
      out.push(chain[i])
    }
    while (k < recovered.length) out.push(recovered[k++])
    from = end
  }
  out.push(...chain.slice(from))
  return out
}

/** The entries hanging off the newest message that are not messages themselves, depth first. */
function appendTrailing(leaf: Entry, chain: Entry[], seen: Set<string>, n: Map<string, Entry>): void {
  const children = new Map<string, Entry[]>()
  for (const e of n.values())
    if (e.parentUuid && !isUserOrAssistant(e)) {
      const l = children.get(e.parentUuid)
      if (l) l.push(e)
      else children.set(e.parentUuid, [e])
    }
  const byTime = (x: Entry, y: Entry): number => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0)
  const stack: Entry[] = [leaf]
  while (stack.length > 0) {
    const e = stack.pop()!
    if (e !== leaf) {
      if (seen.has(e.uuid)) continue
      seen.add(e.uuid)
      chain.push(e)
    }
    const kids = children.get(e.uuid) ?? []
    const sorted = kids.length > 1 ? [...kids].sort(byTime) : kids
    for (let j = sorted.length - 1; j >= 0; j--) if (!seen.has(sorted[j].uuid)) stack.push(sorted[j])
  }
}

function buildChain(n: Map<string, Entry>, leaf: Entry): Entry[] {
  const chain: Entry[] = []
  const seen = new Set<string>()
  let at: Entry | undefined = leaf
  while (at) {
    if (seen.has(at.uuid)) break
    seen.add(at.uuid)
    chain.push(at)
    const p = at.parentUuid
    if (!p) break
    let next = n.get(p)
    if (!next || seen.has(next.uuid)) next = timestampFallback(n, at, seen)
    at = next
  }
  chain.reverse()
  const out = recoverParallel(n, chain, seen)
  appendTrailing(leaf, out, seen, n)
  return out
}

// The resume filters. Constants and tests as in Claude Code.
const INTERRUPTED = '[Request interrupted by user]'
const INTERRUPTED_TOOL = '[Request interrupted by user for tool use]'
const TOOL_NOT_COMPLETED =
  '[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]'
const NO_CONTENT = '(no content)'
const EMPTY_TEXT_REMOVED = '[Empty text removed]'
const TRANSIENT_ATTACHMENTS = new Set([
  'compaction_reminder',
  'companion_intro',
  'echo_activities',
  'pen_mode_enter',
  'pen_mode_exit',
  'verify_plan_reminder',
  'fold_nudge',
  'context_tip',
  'new_file',
  'new_directory'
])
const TURN_ENDING_TOOLS = new Set(['SendUserMessage', 'Brief', 'SendUserFile'])

function attachmentReadable(a: unknown): boolean {
  if (!isObject(a) || typeof a.type !== 'string') return false
  switch (a.type) {
    case 'invoked_skills':
      return Array.isArray(a.skills) && a.skills.every((s: unknown) => typeof s === 'object' && s !== null)
    case 'hook_success':
      return typeof a.content === 'string'
    case 'skill_listing':
      return !('names' in a) || a.names === undefined || (Array.isArray(a.names) && a.names.length <= 4096 && a.names.every((s: unknown) => typeof s === 'string' && s.length <= 512))
    case 'hook_additional_context':
      return Array.isArray(a.content) && a.content.every((s: unknown) => typeof s === 'string')
    case 'task_reminder':
    case 'todo_reminder':
      return Array.isArray(a.content) && a.content.every(isObject)
    case 'file':
    case 'already_read_file':
      return isObject(a.content)
  }
  return true
}

const withoutRetracted = (list: Entry[]): Entry[] => {
  const gone = new Set(
    list.flatMap((e) => (e.type === 'system' && e.subtype === 'model_refusal_fallback' && e.retractedMessageUuids !== undefined ? e.retractedMessageUuids.map((u: string) => u.slice(0, 24)) : []))
  )
  return gone.size === 0 ? list : list.filter((e) => e.type === 'system' || !gone.has(e.uuid.slice(0, 24)))
}
const withReadableAttachments = (list: Entry[]): Entry[] => list.filter((e) => !(e.type === 'attachment' && !attachmentReadable(e.attachment)))
const withReadableRows = (list: Entry[]): Entry[] =>
  list.flatMap((e) => {
    if (e.type !== 'user' && e.type !== 'assistant') return [e]
    try {
      const r = rowRepair(e.type, e.message)
      if (r === 'keep') return [e]
      if (r === 'drop') return []
      return [{ ...e, message: { ...e.message, content: r.content } }]
    } catch {
      return [e]
    }
  })

const textOf = (content: unknown): string | undefined =>
  typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined

/** Drop assistant entries whose tool calls all went unanswered (Claude Code's resume filter). */
function withoutUnanswered(list: Entry[], answered: Set<string> | undefined, trailing?: Set<string>): Entry[] {
  const uses = new Set<string>()
  const results = new Set<string>()
  for (const e of list) {
    if (e.type !== 'user' && e.type !== 'assistant') continue
    const c = e.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b?.type === 'tool_use') uses.add(b.id)
      if (b?.type === 'tool_result') results.add(b.tool_use_id)
    }
  }
  const unanswered = new Set([...uses].filter((id) => !results.has(id) && !answered?.has(id)))
  if (unanswered.size === 0) return list
  if (trailing) {
    // The tool calls at the very end that went unanswered (what a resume may still keep).
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if (e.type === 'system' || e.type === 'progress' || e.type === 'attachment') continue
      if (e.type === 'user') {
        const c = e.message?.content
        if (Array.isArray(c) && c.some((b: Entry) => b?.type === 'tool_result')) continue
        if (e.interruptedByShutdown === true) continue
        break
      }
      if (e.type === 'assistant' && Array.isArray(e.message?.content)) for (const b of e.message.content) if (b?.type === 'tool_use' && unanswered.has(b.id)) trailing.add(b.id)
    }
  }
  return list.filter((e) => {
    if (e.type !== 'assistant') return true
    const c = e.message?.content
    if (!Array.isArray(c)) return true
    const ids = c.filter((b: Entry) => b?.type === 'tool_use').map((b: Entry) => b.id)
    if (ids.length === 0) return true
    return !ids.every((id: string) => unanswered.has(id))
  })
}

const isThinking = (b: Entry): boolean => b?.type === 'thinking' || b?.type === 'redacted_thinking'
function whitespaceOnly(content: Entry[]): boolean {
  let sawText = false
  for (const b of content) {
    if (!sawText && isThinking(b)) continue
    if (b?.type !== 'text') return false
    const t = b.text?.trim()
    if (t !== undefined && t !== '' && t !== NO_CONTENT && t !== EMPTY_TEXT_REMOVED) return false
    sawText = true
  }
  return sawText
}
const isNoise = (e: Entry): boolean => e.type === 'progress' || e.type === 'system' || (e.type === 'attachment' && e.attachment?.type === 'thinking_drop')
const unsignedThinkingOnly = (e: Entry): boolean =>
  e.type === 'assistant' &&
  Array.isArray(e.message?.content) &&
  e.message.content.length > 0 &&
  e.message.content.every(isThinking) &&
  e.message.content.some((b: Entry) => b.type === 'thinking' && !b.signature)

/** Whitespace-only replies and thinking-only replies with nothing after them, dropped until none are left. */
function withoutEmptyReplies(list: Entry[]): Entry[] {
  let cur = list
  for (;;) {
    const next = dropWhitespaceOnly(dropOrphanedThinking(cur))
    if (next.length === cur.length) return cur
    cur = next
  }
}
function dropOrphanedThinking(list: Entry[]): Entry[] {
  let withContent: Set<string> | undefined
  let withRealText: Set<string> | undefined
  const keep: boolean[] = []
  for (let w = list.length - 1; w >= 0; w--) {
    const e = list[w]
    const c = e.type === 'assistant' ? e.message?.content : undefined
    if (e.type !== 'assistant' || !Array.isArray(c) || c.length === 0 || c.some((b: Entry) => !isThinking(b))) {
      keep[w] = true
      continue
    }
    let k = w + 1
    while (k < list.length && (isNoise(list[k]) || unsignedThinkingOnly(list[k]))) k++
    const after = list[k]
    keep[w] =
      (e.message.id !== undefined && (withContent ??= idsWithNonThinking(list)).has(e.message.id)) ||
      (after?.type === 'assistant' &&
        after.resumedFromIncompleteThinking === true &&
        keep[k] === true &&
        !(Array.isArray(after.message?.content) && whitespaceOnly(after.message.content) && !(after.message.id !== undefined && (withRealText ??= idsWithRealText(list)).has(after.message.id))) &&
        !unsignedThinkingOnly(e))
  }
  let out: Entry[] | undefined
  for (let w = 0; w < list.length; w++) {
    const e = list[w]
    if (e.type !== 'assistant' || keep[w]) {
      out?.push(e)
      continue
    }
    if (!out) out = list.slice(0, w)
  }
  return out ?? list
}
function idsWithNonThinking(list: Entry[]): Set<string> {
  const s = new Set<string>()
  for (const e of list) if (e.type === 'assistant' && e.message?.id && Array.isArray(e.message.content) && e.message.content.some((b: Entry) => !isThinking(b))) s.add(e.message.id)
  return s
}
function idsWithRealText(list: Entry[]): Set<string> {
  const s = new Set<string>()
  for (const e of list) {
    if (e.type !== 'assistant' || !e.message?.id || !Array.isArray(e.message.content)) continue
    if (
      e.message.content.some((b: Entry) => {
        if (isThinking(b)) return false
        if (b?.type !== 'text') return true
        const t = (b.text ?? '').trim()
        return t !== '' && t !== NO_CONTENT && t !== EMPTY_TEXT_REMOVED
      })
    )
      s.add(e.message.id)
  }
  return s
}
function dropWhitespaceOnly(list: Entry[]): Entry[] {
  if (!list.some((e) => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.length > 0 && whitespaceOnly(e.message.content))) return list
  const real = idsWithRealText(list)
  return list.filter((e) => {
    if (e.type !== 'assistant') return true
    if (real.has(e.message?.id)) return true
    const c = e.message?.content
    if (!Array.isArray(c) || c.length === 0) return true
    return !whitespaceOnly(c)
  })
}

// Classification of how the chat's last turn ended (Claude Code's resume, for the one case where it
// decides which messages stay: tool calls left without a result at the very end).
function commandTagKind(e: Entry): 'record' | 'output' | 'caveat' | undefined {
  if (e.type !== 'user' || e.promptSource !== undefined) return undefined
  const c = e.message?.content
  const text = Array.isArray(c) ? c.findLast((b: Entry) => b?.type === 'text')?.text : typeof c === 'string' ? c : undefined
  if (typeof text !== 'string') return undefined
  const kind = text.startsWith('<command-name>')
    ? 'record'
    : text.startsWith('<local-command-stdout>') || text.startsWith('<local-command-stderr>')
      ? 'output'
      : text.startsWith('<local-command-caveat>')
        ? 'caveat'
        : undefined
  return kind === 'caveat' && e.isMeta !== true ? undefined : kind
}
function isLocalCommandTail(list: Entry[], at: number): boolean {
  if (commandTagKind(list[at]) === undefined) return false
  let sawRecord = false
  let allMeta = true
  for (let i = at; i >= 0; i--) {
    const e = list[i]
    if (e.type === 'system' || e.type === 'progress' || e.type === 'attachment') continue
    const k = commandTagKind(e)
    if (k === 'caveat') return true
    if (k === undefined || sawRecord) break
    sawRecord = k === 'record'
    allMeta &&= e.type === 'user' && e.isMeta === true
  }
  return allMeta
}
const isToolResultRow = (e: Entry): boolean => e.type === 'user' && ((Array.isArray(e.message?.content) && e.message.content[0]?.type === 'tool_result') || Boolean(e.toolUseResult))
const isTaskNotification = (e: Entry): boolean => e.origin?.kind === 'task-notification' && (textOf(e.message?.content)?.startsWith('<task-notification>') ?? false)
const isQueuedNotification = (e: Entry): boolean => e.type === 'user' && e.queueTranscriptOnly === true && isTaskNotification(e)
const isRefusalError = (e: Entry): boolean => e.message?.stop_reason === 'refusal' || e.apiError === 'dlp_request_denied' || e.apiError === 'safety_monitor_blocked'
const isRetryableApiError = (e: Entry): boolean => e.isApiErrorMessage === true && !isRefusalError(e)

function endsTurnTool(e: Entry, list: Entry[], at: number): boolean {
  const c = e.message?.content
  if (!Array.isArray(c)) return false
  const first = c[0]
  if (first?.type !== 'tool_result') return false
  for (let y = at - 1; y >= 0; y--) {
    const w = list[y]
    if (w.type !== 'assistant') continue
    for (const b of w.message?.content ?? []) if (b?.type === 'tool_use' && b.id === first.tool_use_id) return TURN_ENDING_TOOLS.has(b.name)
  }
  return false
}
const allDeliveredMessage = (e: Entry): boolean => Array.isArray(e.message?.content) && e.message.content.length > 0 && e.message.content.every((b: Entry) => b?.type === 'tool_result' && b.content === TOOL_NOT_COMPLETED)
function deniedEndsTurn(list: Entry[], at: number): boolean {
  for (let r = at; r >= 0; r--) {
    const s = list[r]
    if (s.type === 'assistant') return false
    if (s.type === 'user' && isToolResultRow(s) && s.toolDenialEndsTurn === true) return true
  }
  return false
}
const backgroundedByAbort = (e: Entry): boolean => isObject(e.toolUseResult) && e.toolUseResult.backgroundedByTurnAbort === true

type TurnState = 'none' | 'interrupted_turn' | 'interrupted_prompt'
function lastTurnState(list: Entry[]): { kind: TurnState; skippedApiError: Entry | undefined } {
  const skipped: Entry[] = []
  const kind = ((): TurnState => {
    if (list.length === 0) return 'none'
    let s = -1
    let sawQueued = false
    for (let w = list.length - 1; w >= 0; w--) {
      const m = list[w]
      if (m.type === 'system' || m.type === 'progress') continue
      if (isQueuedNotification(m)) {
        sawQueued = true
        continue
      }
      if (m.type === 'assistant' && isRetryableApiError(m)) {
        skipped.push(m)
        continue
      }
      s = w
      break
    }
    const h = s !== -1 ? list[s] : undefined
    if (!h) return 'none'
    if (h.type === 'assistant') return 'none'
    const attachmentLike = h.type === 'attachment'
    if (h.type === 'user' && !attachmentLike) {
      if (isLocalCommandTail(list, s)) return 'none'
      if (h.isMeta || h.isCompactSummary) return 'none'
      const t = textOf(h.message?.content)
      if (t === INTERRUPTED || t === INTERRUPTED_TOOL) return h.interruptedByShutdown ? 'interrupted_turn' : 'none'
      if (isToolResultRow(h)) {
        if (endsTurnTool(h, list, s) || allDeliveredMessage(h) || deniedEndsTurn(list, s) || backgroundedByAbort(h)) return 'none'
        return 'interrupted_turn'
      }
      if (isTaskNotification(h)) return 'interrupted_turn'
      if (sawQueued) return 'interrupted_turn'
      return 'interrupted_prompt'
    }
    if (attachmentLike) {
      let userSeen = false
      for (let M = s - 1; M >= 0; M--) {
        const D = list[M]
        if (D.type === 'system' || D.type === 'progress' || D.type === 'attachment') {
          userSeen ||= D.type === 'user'
          continue
        }
        if (isQueuedNotification(D)) continue
        if (D.type === 'assistant') {
          if (isRetryableApiError(D)) {
            skipped.push(D)
            continue
          }
          if (userSeen && !D.isApiErrorMessage) return 'none'
          return 'none'
        }
        if (D.type === 'user' && D.isCompactSummary) return 'none'
        const t = textOf(D.message?.content)
        if (D.type === 'user' && (t === INTERRUPTED || t === INTERRUPTED_TOOL)) return D.interruptedByShutdown ? 'interrupted_turn' : 'none'
        if (D.type === 'user' && isLocalCommandTail(list, M)) return 'none'
        if (D.type === 'user' && isToolResultRow(D) && (endsTurnTool(D, list, M) || allDeliveredMessage(D) || backgroundedByAbort(D) || deniedEndsTurn(list, M))) return 'none'
        return 'interrupted_turn'
      }
      return userSeen ? 'none' : 'interrupted_turn'
    }
    return 'none'
  })()
  return { kind, skippedApiError: skipped[0] }
}

function endsAt(list: Entry[], uuid: string | undefined): boolean {
  if (uuid === undefined) return false
  for (let r = list.length - 1; r >= 0; r--) {
    const s = list[r]
    if (s.type !== 'user' && s.type !== 'assistant') continue
    if (s.uuid === uuid) return true
    if (!isQueuedNotification(s)) return false
  }
  return false
}
const olderThan = (e: Entry, ms: number): boolean => {
  const t = Date.parse(e.timestamp ?? '')
  return !Number.isFinite(t) || Math.abs(Date.now() - t) >= ms
}
const laterOf = (a: Entry | undefined, b: Entry | undefined): Entry | undefined => {
  if (a === undefined || b === undefined) return a ?? b
  const r = Date.parse(a.timestamp ?? '')
  const s = Date.parse(b.timestamp ?? '')
  if (!Number.isFinite(r)) return a
  if (!Number.isFinite(s)) return b
  return s > r ? b : a
}

/** The membership effect of Claude Code's deserializeMessages on resume. */
function resumeFilters(list: Entry[], deferredToolUse: string | undefined, rewindAnchor: string | undefined, firstParty: boolean): Entry[] {
  let w = withReadableRows(list)
  w = withoutRetracted(w)
  w = withReadableAttachments(w)
  let stamped = 0
  w = w.map((e) => (e.type === 'assistant' && !e.message?.id && e.requestId === undefined ? { ...e, message: { ...e.message, id: `stamped_${++stamped}` } } : e))
  w = w
    .filter((e) => !(e.type === 'attachment' && TRANSIENT_ATTACHMENTS.has(e.attachment?.type)))
    .flatMap((e) => {
      if (e.type !== 'assistant' && e.type !== 'user') return [e]
      const c = e.message?.content
      if (!Array.isArray(c)) return [e]
      const kept = c.filter((b: Entry) => b?.type !== 'text' || typeof b.text === 'string')
      if (kept.length === c.length) return [e]
      return kept.length === 0 ? [] : [{ ...e, message: { ...e.message, content: kept } }]
    })
  w = withoutApiInvalidBlocks(w, firstParty)
  const answered = deferredToolUse ? new Set([deferredToolUse]) : undefined
  const trailing = new Set<string>()
  const atRewind = endsAt(w, rewindAnchor)
  let out = withoutEmptyReplies(withoutUnanswered(w, answered, trailing))
  const { kind, skippedApiError } = answered?.size ? { kind: 'none' as TurnState, skippedApiError: undefined } : lastTurnState(out)
  const rewound = kind !== 'none' && (atRewind || endsAt(out, rewindAnchor))
  const skippedRow = kind === 'none' ? skippedApiError : laterOf(skippedApiError, lastTurnState(w).skippedApiError)
  const stale = !rewound && kind !== 'none' && skippedRow !== undefined && olderThan(skippedRow, 21_600_000)
  if (!rewound && !stale && kind === 'interrupted_turn' && trailing.size > 0) out = withoutEmptyReplies(withoutUnanswered(w, new Set([...(answered ?? []), ...trailing])))
  return out
}

/** Claude Code drops assistant blocks the Anthropic API never produces — only on its own API. */
function withoutApiInvalidBlocks(list: Entry[], firstParty: boolean): Entry[] {
  const isResult = (b: unknown): boolean => isObject(b) && b.type === 'tool_result'
  const triggers = list.some((e) => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some((b: Entry) => isResult(b)))
  if (!triggers || !firstParty) return list
  // Only tool_result blocks inside an assistant entry are handled here (server tool calls of unknown
  // names, the other case Claude Code drops, do not occur in these chats); an entry left with no
  // blocks goes.
  return list.flatMap((e) => {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content) || !e.message.content.some(isResult)) return [e]
    const kept = e.message.content.filter((b: Entry) => !isResult(b))
    return kept.length === 0 ? [] : [{ ...e, message: { ...e.message, content: kept } }]
  })
}

/** A deferred hook tool call near the end of the transcript that has no result yet, if any. */
async function deferredToolUseOf(fh: fsp.FileHandle, size: number): Promise<string | undefined> {
  const take = Math.min(size, 1 << 20)
  const buf = Buffer.allocUnsafe(take)
  await fh.read(buf, 0, take, size - take)
  const lines = buf.toString('utf8').split('\n')
  if (take < size) lines.shift()
  let id: string | undefined
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.includes('"hook_deferred_tool"')) continue
    try {
      const e = JSON.parse(l)
      if (e?.type === 'attachment' && e.attachment?.type === 'hook_deferred_tool') {
        id = e.attachment.toolUseID
        at = i
        break
      }
    } catch {
      /* not a whole line */
    }
  }
  if (id === undefined) return undefined
  const mention = `"tool_use_id":"${id}"`
  for (let i = at + 1; i < lines.length; i++) if (lines[i].includes(mention)) return undefined
  return id
}

/** The conversation Claude Code resumes the chat with: the messages /branch copies, in order. */
async function conversation(fh: fsp.FileHandle, size: number, firstParty: boolean): Promise<{ list: Entry[]; loaded: Loaded }> {
  const loaded = size > BIG_FILE ? await loadBig(fh, size) : await loadSmall(fh, size)
  const n = loaded.loader.messages
  if (n.size === 0) return { list: [], loaded }
  const leaf =
    newest(n.values(), (e) => loaded.leaves.has(e.uuid) && !e.isSidechain && isUserOrAssistant(e)) ??
    (loaded.leaves.size === 0 && !loaded.cleared ? newest(n.values(), (e) => !e.isSidechain) : undefined)
  if (!leaf) return { list: [], loaded }
  let list = buildChain(n, leaf)
  list = withoutRetracted(list)
  list = withReadableAttachments(list)
  list = resumeFilters(list, await deferredToolUseOf(fh, size), loaded.rewindAnchor, firstParty)
  // The terminal drops these two kinds of status line when it restores a chat.
  list = list.filter((e) => !(e.type === 'system' && (e.subtype === 'bridge_status' || e.subtype === 'cloud_session_status')))
  return { list, loaded }
}

// ---------------------------------------------------------------------------------------------
// The name (Claude Code's deriveFirstPrompt and the "(Branch N)" numbering).

/** Pasted-content blocks folded back into the text they were pasted into. */
function expandPastes(text: string): string {
  const parts: { kind: 'text' | 'block'; text: string }[] = []
  let done = 0
  let from = 0
  for (;;) {
    const a = text.indexOf('<pasted_content id="', from)
    if (a === -1) break
    const s = a + 20
    const id = text.slice(s, s + 4)
    if (!/^[0-9a-f]{4}$/.test(id) || !text.startsWith('">\n', s + 4)) {
      from = s
      continue
    }
    const c = s + 4 + 3
    const close = `</pasted_content id="${id}">`
    const T = text.indexOf(`\n${close}`, c - 1) + 1
    if (T === 0) break
    let l = a
    for (let m = 0; m < 2 && l > done && text[l - 1] === '\n'; m++) l--
    if (l > done) parts.push({ kind: 'text', text: text.slice(done, l) })
    done = T + close.length
    for (let m = 0; m < 2 && text[done] === '\n'; m++) done++
    parts.push({ kind: 'block', text: text.slice(c, T - 1) })
    from = done
  }
  if (done < text.length) parts.push({ kind: 'text', text: text.slice(done) })
  if (parts.length === 1 && parts[0].kind === 'text') return text
  return parts.map((p) => p.text).join('')
}

const SKIPPED_PROMPT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/
const COMMAND_NAME = /<command-name>(.*?)<\/command-name>/

function promptText(e: Entry, state: { commandFallback: string }): string | undefined {
  if (e.type !== 'user' || e.isMeta === true || e.isCompactSummary === true) return undefined
  const m = e.message
  if (!m) return undefined
  const texts: string[] = []
  if (typeof m.content === 'string') texts.push(m.content)
  else if (Array.isArray(m.content))
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_result') return undefined
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    }
  for (const t of texts) {
    let n = expandPastes(t).replaceAll('\n', ' ').trim()
    if (!n) continue
    const cmd = COMMAND_NAME.exec(n)
    if (cmd) {
      if (!state.commandFallback) state.commandFallback = cmd[1]
      continue
    }
    const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(n)
    if (bash) return `! ${bash[1].trim()}`
    if (SKIPPED_PROMPT.test(n)) continue
    if (n.length > 200) n = n.slice(0, 200).trim() + '…'
    return n
  }
  return undefined
}

function firstPrompt(entries: Entry[]): string {
  const state = { commandFallback: '' }
  let found: string | undefined
  for (const e of entries) if ((found = promptText(e, state)) !== undefined) break
  found ??= state.commandFallback
  return found.replace(/\s+/g, ' ').trim().slice(0, 100).trimEnd() || 'Branched conversation'
}

/**
 * The titles of the chats in a project folder, as Claude Code's search sees them: the custom title,
 * or else the AI title, lower-cased (to tell whether a name is taken), and the custom titles as
 * written (to number the next branch).
 */
async function titlesIn(projectDir: string): Promise<{ taken: Set<string>; custom: string[] }> {
  const titles = { taken: new Set<string>(), custom: [] as string[] }
  let names: string[] = []
  try {
    names = (await fsp.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return titles
  }
  for (const name of names) {
    const id = name.slice(0, -6)
    let custom: string | undefined
    let ai: string | undefined
    try {
      const side = JSON.parse(await fsp.readFile(path.join(projectDir, id, 'custom-title.json'), 'utf8'))
      if (typeof side?.customTitle === 'string') custom = side.customTitle
    } catch {
      /* no title file */
    }
    try {
      const fh = await fsp.open(path.join(projectDir, name), 'r')
      try {
        const { size } = await fh.stat()
        const take = Math.min(size, 256 * 1024)
        const buf = Buffer.allocUnsafe(take)
        await fh.read(buf, 0, take, size - take)
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue
          try {
            const e = JSON.parse(line)
            if (e.type === 'custom-title' && typeof e.customTitle === 'string') custom = e.customTitle
            if (e.type === 'ai-title' && typeof e.aiTitle === 'string') ai = e.aiTitle
          } catch {
            /* a cut line */
          }
        }
      } finally {
        await fh.close()
      }
    } catch {
      /* unreadable: not counted */
    }
    const t = (custom ?? ai)?.toLowerCase().trim()
    if (t) titles.taken.add(t)
    if (custom !== undefined) titles.custom.push(custom)
  }
  return titles
}

async function branchName(base: string, projectDir: string): Promise<string> {
  const titles = await titlesIn(projectDir)
  const first = `${base} (Branch)`
  if (!titles.taken.has(first.toLowerCase().trim())) return first
  const used = new Set([1])
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(Branch(?: (\\d+))?\\)$`)
  for (const t of titles.custom) {
    const m = t.match(pattern)
    if (m) used.add(m[1] ? parseInt(m[1], 10) : 1)
  }
  let n = 2
  while (used.has(n)) n++
  return `${base} (Branch ${n})`
}

// ---------------------------------------------------------------------------------------------
// The fork itself (Claude Code's createFork and branchAndResume).

export interface BranchResult {
  sessionId: string
  title: string
  file: string
  /** Messages copied. */
  messages: number
}

export async function branchChat(opts: {
  /** The chat's transcript. */
  file: string
  sessionId: string
  /** The name given to /branch, if any. */
  name?: string
  /** The chat runs on Claude's own API (not through a bridge): one resume filter depends on it. */
  firstParty: boolean
}): Promise<BranchResult> {
  const { file, sessionId: original } = opts
  const projectDir = path.dirname(file)
  const fh = await fsp.open(file, 'r').catch(() => {
    throw new Error('This chat has no conversation yet, so there is nothing to fork.')
  })
  let list: Entry[]
  let loaded: Loaded
  let size: number
  try {
    size = (await fh.stat()).size
    ;({ list, loaded } = await conversation(fh, size, opts.firstParty))
  } catch (err) {
    await fh.close()
    throw err
  }
  const forkId = randomUUID()
  const forkFile = path.join(projectDir, `${forkId}.jsonl`)
  try {
    // createFork: the transcript's own entries for the conversation's messages (the last copy of
    // each, as its Map keeps), and the session's records that travel with a fork.
    const wanted = new Set(list.map((e) => e.uuid))
    const found = new Map<string, Entry>()
    const replacements: unknown[] = []
    const memoryModes: Entry[] = []
    let relocatedCwd: string | undefined
    let suppressed = loaded.loader.historySuppressed.has(original)
    const UUID_OF = Buffer.from('"uuid":"')
    const MARKERS = ['"content-replacement"', '"relocated"', '"memory-mode"', '"history-suppression"'].map((s) => Buffer.from(s))
    const reads: { offset: number; length: number }[] = []
    await scanLines(fh, size, (buf, start, len, offset) => {
      const line = buf.subarray(start, start + len)
      if (MARKERS.some((m) => line.includes(m))) {
        let e: Entry
        try {
          e = JSON.parse(line.toString('utf8'))
        } catch {
          return
        }
        if (!isObject(e)) return
        if (e.type === 'content-replacement' && e.sessionId === original && Array.isArray(e.replacements)) return void replacements.push(...e.replacements)
        if (e.type === 'relocated' && e.sessionId === original && typeof e.relocatedCwd === 'string' && e.relocatedCwd !== '') return void (relocatedCwd = e.relocatedCwd)
        if (e.type === 'memory-mode' && e.sessionId === original) return void memoryModes.push(e)
        if (e.type === 'history-suppression') return void (suppressed = true)
      }
      // A message line of the conversation: its uuid is the one followed by its timestamp.
      for (let from = 0; ; ) {
        const at = line.indexOf(UUID_OF, from)
        if (at < 0) break
        const uuid = line.toString('latin1', at + 8, at + 44)
        if (wanted.has(uuid)) {
          reads.push({ offset, length: len })
          break
        }
        from = at + 8
      }
    })
    for (const r of reads) {
      const e = await readLine(fh, r.offset, r.length)
      if (!e || !isMessage(e) || e.isSidechain || !wanted.has(e.uuid)) continue
      found.set(e.uuid, e)
    }
    const out: string[] = []
    const now = new Date().toISOString()
    if (suppressed) out.push(JSON.stringify({ type: 'history-suppression', sessionId: forkId, cause: 'fork_inherit', ts: now }))
    const serialized: Entry[] = []
    let parent: string | null = null
    for (const e of list) {
      const m = found.get(e.uuid)
      if (!m) continue
      const neutral = m.type === 'system' && m.subtype === 'model_refusal_fallback' ? { neutralizedByFork: true } : undefined
      out.push(JSON.stringify({ ...m, ...neutral, sessionId: forkId, parentUuid: parent, isSidechain: false, sessionKind: undefined, forkedFrom: { sessionId: original, messageUuid: m.uuid } }))
      serialized.push({ ...m, ...neutral, sessionId: forkId })
      if (m.type !== 'progress') parent = m.uuid
    }
    if (serialized.length === 0) throw new Error('This chat has no conversation yet, so there is nothing to fork.')
    if (replacements.length > 0) out.push(JSON.stringify({ type: 'content-replacement', sessionId: forkId, replacements }))
    for (const m of memoryModes) out.push(JSON.stringify({ ...m, sessionId: forkId }))
    if (relocatedCwd) out.push(JSON.stringify({ type: 'relocated', sessionId: forkId, relocatedCwd }))
    // The session's latch as Claude Code holds it after resuming: the chat's last one, or the empty
    // value a session starts with when the chat has none (measured: always written).
    out.push(JSON.stringify({ type: 'atis-latch', sessionId: forkId, atis: loaded.loader.atisLatches.get(original) ?? '' }))
    // branchAndResume: the name, as a custom title and an agent name, and the title file.
    const given = opts.name?.trim() ? opts.name.trim().replace(/\s+/g, ' ').trim() : undefined
    const title = given ?? (await branchName(firstPrompt(serialized), projectDir))
    out.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: forkId }))
    out.push(JSON.stringify({ type: 'agent-name', agentName: title, sessionId: forkId }))
    await fsp.writeFile(forkFile, out.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
    await fsp.mkdir(path.join(projectDir, forkId), { recursive: true, mode: 0o700 })
    await fsp.writeFile(path.join(projectDir, forkId, 'custom-title.json'), JSON.stringify({ customTitle: title }), { mode: 0o600 })
    return { sessionId: forkId, title, file: forkFile, messages: serialized.length }
  } catch (err) {
    await fsp.rm(forkFile, { force: true }).catch(() => undefined)
    throw err
  } finally {
    await fh.close()
  }
}

/**
 * Where Claude Code's own rewind to this prompt leaves the conversation it resumes the chat with:
 * the nearest user or assistant entry before the prompt (the anchor its rewind_conversation keeps),
 * found in that conversation as it rebuilds it from the transcript. Null when the prompt is not in it
 * or nothing comes before it. Resuming at an entry outside that conversation fails ("No message found
 * with message.uuid"), as an answer from before the last compaction does unless the compaction kept it.
 */
export async function resumePointBefore(file: string, firstParty: boolean, promptUuid: string): Promise<string | null> {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const { list } = await conversation(fh, size, firstParty)
    for (let i = list.findIndex((e) => e.uuid === promptUuid) - 1; i >= 0; i--) {
      if (list[i].type === 'user' || list[i].type === 'assistant') return list[i].uuid
    }
    return null
  } finally {
    await fh.close()
  }
}

/** For checks against the real /branch: the uuids of the conversation /branch would copy. */
export async function conversationUuids(file: string, firstParty: boolean): Promise<string[]> {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    return (await conversation(fh, size, firstParty)).list.map((e) => e.uuid)
  } finally {
    await fh.close()
  }
}

