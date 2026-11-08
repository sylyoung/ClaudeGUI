import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { copiedRanges, readLineIndex, readSessionHistory, readSessionSlice } from '../src/host/sessions/history'
import { readTranscriptIndex } from '../src/host/sessions/transcriptIndex'

const root = process.env.CONFIGURATION_TEST_ROOT!
assert.ok(root && path.basename(root).startsWith('configuration-tests-'), 'Run through the isolated test script')

/**
 * A transcript as Claude Code writes it for a chat compacted twice by one process: the first part,
 * a compaction, the second part, then the first part written again just before the second
 * compaction's notice, and the conversation after it. `pad` makes the copied part larger than the
 * part of a chat that is opened on, as in the chats where the last reply went missing.
 */
function transcript(opts: { pad: number; after: number }) {
  const sessionId = randomUUID()
  const dir = path.join(root, 'history-project')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  let clock = Date.parse('2026-01-01T00:00:00Z')
  const lines: string[] = []
  const write = (e: Record<string, unknown>) => lines.push(JSON.stringify(e))
  const base = (uuid: string, parentUuid: string | null) => ({ parentUuid, isSidechain: false, sessionId, cwd: dir, version: '2.1.301', timestamp: new Date((clock += 1000)).toISOString(), uuid })
  const prompt = (uuid: string, parent: string | null, text: string) => ({ ...base(uuid, parent), type: 'user', message: { role: 'user', content: text } })
  const reply = (uuid: string, parent: string, text: string) => ({ ...base(uuid, parent), type: 'assistant', message: { id: `msg_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } })
  const boundary = (uuid: string, logicalParentUuid: string) => ({ ...base(uuid, null), logicalParentUuid, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info', compactMetadata: { trigger: 'manual', preTokens: 1 } })
  const summary = (uuid: string, parent: string) => ({ ...base(uuid, parent), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary of the conversation so far.' } })
  const recap = (uuid: string, parent: string) => ({ ...base(uuid, parent), type: 'system', subtype: 'away_summary', content: 'While you were away: fixture recap.', isMeta: false, level: 'info' })
  const padding = 'x'.repeat(opts.pad)

  // The first part, which itself follows an earlier compaction (whose message is in the file).
  const z = randomUUID()
  write(prompt(z, null, 'Z: the start of the chat'))
  const first: Record<string, unknown>[] = []
  const a0 = randomUUID()
  first.push(boundary(a0, z))
  let parent = a0
  for (let i = 1; i <= 3; i++) {
    const p = randomUUID()
    const r = randomUUID()
    first.push(prompt(p, parent, `A${i} prompt ${padding}`))
    first.push(reply(r, p, `A${i} reply`))
    parent = r
  }
  // A recap is part of the conversation like any message: the compaction after it follows it.
  const recapId = randomUUID()
  first.push(recap(recapId, parent))
  const lastOfFirst = recapId
  for (const e of first) write(e)
  // The second part, after the first compaction; B3's reply is the chat's last reply before the second.
  const b0 = randomUUID()
  write(boundary(b0, lastOfFirst))
  write(summary(randomUUID(), b0))
  parent = b0
  for (let i = 1; i <= 3; i++) {
    const p = randomUUID()
    const r = randomUUID()
    write(prompt(p, parent, `B${i} prompt`))
    write(reply(r, p, `B${i} reply`))
    parent = r
  }
  const lastReply = parent
  // What lies between the last reply and the notice: Claude Code's note of the /compact, then the copies.
  const copyStartsAt = lines.length
  write({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(clock).toISOString(), sessionId, content: '/compact' })
  for (const e of first) write(e)
  const copyEndsAt = lines.length
  const c0 = randomUUID()
  write(boundary(c0, lastReply))
  write(summary(randomUUID(), c0))
  parent = c0
  for (let i = 1; i <= opts.after; i++) {
    const p = randomUUID()
    write(prompt(p, parent, `C${i} prompt`))
    parent = p
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const offsetOfLine = (n: number) => lines.slice(0, n).reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0)
  return { sessionId, dir, file, lastReply, firstUuids: first.map((e) => e.uuid as string), recapId, copy: { from: offsetOfLine(copyStartsAt), to: offsetOfLine(copyEndsAt) }, lines }
}

const texts = (messages: unknown[]) =>
  messages.map((m) => {
    const c = (m as { message?: { content?: unknown } }).message?.content
    return typeof c === 'string' ? c.slice(0, 12) : Array.isArray(c) ? String((c[0] as { text?: string }).text ?? '').slice(0, 12) : (m as { type: string }).type
  })

test('a chat opens on its last reply when Claude Code wrote copies of older parts before a compaction', async () => {
  // Copies of 3 × 1 MB prompts: more than the 2 MB a chat is opened on, with enough after them that
  // the part opened on is not widened.
  const t = transcript({ pad: 1024 * 1024, after: 220 })
  assert.deepEqual(await copiedRanges(t.file, 0), [t.copy])
  const read = await readSessionHistory(t.sessionId, t.dir, t.file)
  const uuids = read.messages.map((m) => (m as { uuid: string }).uuid)
  assert.ok(uuids.includes(t.lastReply), 'the last reply before the compaction is shown')
  assert.equal(new Set(uuids).size, uuids.length, 'no message is shown twice')
  const shown = texts(read.messages)
  assert.ok(!shown.slice(shown.indexOf('B3 reply')).some((s) => s.startsWith('A')), 'the copied older part is not shown after the newest messages')
  assert.deepEqual(shown.slice(shown.indexOf('B1 prompt'), shown.indexOf('B3 reply') + 1), ['B1 prompt', 'B1 reply', 'B2 prompt', 'B2 reply', 'B3 prompt', 'B3 reply'])
  assert.ok(read.from <= t.copy.from, 'the part opened on starts before the copies')

  // Scrolling up brings back the rest of the older part, once each, in its own place.
  const earlier = await readSessionSlice(t.sessionId, t.dir, t.file, read.from)
  const all = texts([...earlier.messages, ...read.messages])
  assert.deepEqual(all.filter((s) => /^A\d (prompt|reply)/.test(s)), ['A1 prompt xx', 'A1 reply', 'A2 prompt xx', 'A2 reply', 'A3 prompt xx', 'A3 reply'])
  assert.ok(all.indexOf('A3 reply') < all.indexOf('B1 prompt'))

  // The rows of the older part are where their own lines are; its recap is read once.
  const idx = await readLineIndex(t.file, 0)
  for (const u of t.firstUuids) assert.ok((idx.uuid.get(u) ?? Infinity) < t.copy.from, 'indexed at the original line')
  const { recaps } = await readTranscriptIndex(t.file, 0)
  assert.equal(recaps.filter((r) => r.id === t.recapId).length, 1)
})

test('copies written before their compaction notice are recognised once the notice is written', async () => {
  const t = transcript({ pad: 64, after: 3 })
  assert.deepEqual(await copiedRanges(t.file, 0), [t.copy])
  // A third compaction is written in two steps: the copies of the older parts first, the notice after.
  // In between, the copies cannot be told from the originals; the look taken then is remembered.
  const before = fs.statSync(t.file).size
  const copies = t.lines.slice(1, 1 + 8) // the first part: its notice, three prompts and replies, and the recap
  fs.appendFileSync(t.file, copies.join('\n') + '\n')
  await copiedRanges(t.file, 0)
  const lastLine = t.lines[t.lines.length - 1]
  const lastUuid = (JSON.parse(lastLine) as { uuid: string }).uuid
  const notice = JSON.stringify({ parentUuid: null, logicalParentUuid: lastUuid, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info', timestamp: '2026-01-02T00:00:00.000Z', uuid: randomUUID(), compactMetadata: { trigger: 'manual', preTokens: 1 } })
  fs.appendFileSync(t.file, notice + '\n')
  const after = await copiedRanges(t.file, 0)
  assert.deepEqual(after, [t.copy, { from: before, to: before + copies.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0) }])
  const read = await readSessionHistory(t.sessionId, t.dir, t.file)
  const shown = texts(read.messages)
  assert.equal(shown.filter((s) => s === 'A1 reply').length, 1, 'the older part is shown once')
  assert.ok(shown.indexOf('A1 reply') < shown.indexOf('B1 reply'), 'in its own place')
  assert.equal(shown.filter((s) => s === 'C3 prompt').length, 1)
})
