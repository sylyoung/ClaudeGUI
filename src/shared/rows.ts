import type { ChatMessage, ToolUseBlockView } from './types'

/**
 * Letting go of a chat's older rows, in the session host and in the window alike.
 *
 * A chat that keeps running keeps adding rows — over a thousand an hour in the busiest chats measured
 * (2026-09-28) — and nothing used to let go of them, so a chat left running for days was carried
 * whole by both processes, and opening it handed all of it to the window at once. Both now keep only
 * the newest part of a chat, the part a chat is opened on; the rest is read back from Claude Code's
 * transcript when the chat is scrolled up, exactly as for a chat that was just opened.
 *
 * The part kept begins at a line of the transcript, and every row let go of must lie wholly before
 * that line — its own lines and the results of its tool calls — or reading "earlier" from there
 * would never bring it back. The order of a chat's rows is not always the order of their lines: the
 * conversation Claude Code rebuilds after a compaction or a rewind follows its own links, and in one
 * of the user's chats rows shown after a prompt had their lines 1.4 MB before it (2026-09-28). So the
 * lines of the rows are looked up in the file (LineIndex, read by the session host), and the cut is
 * made at the newest row that starts a step of the conversation — a prompt or note, or an answer —
 * with everything above it before its first line. A row still being written to is never let go of,
 * nor anything after it: an update to a row that is gone would have nowhere to land.
 */

/**
 * Which background tasks are running. The chat's live state has the list Claude Code keeps; a row's
 * own note of its task is only as current as the last message about it, and a task whose process
 * died never gets another one.
 */
export type TaskRunning = (taskId: string) => boolean

/** Whether a tool call is still waiting for its result or is running (a subagent included). */
function toolBusy(b: ToolUseBlockView, turnOpen: boolean, taskRunning: TaskRunning): boolean {
  if (b.task && taskRunning(b.task.taskId)) return true
  return turnOpen && (b.status === 'streaming' || b.status === 'pending' || b.status === 'running')
}

/**
 * Index of the first row that may still change, or `rows.length` when none may. A row may change
 * while it is streaming or has a tool call without its result, in the turn that is still open (a
 * call left without a result by an interrupted turn stays so for ever and does not count), and at
 * any time while it holds a background task that is running.
 */
export function firstBusyRow(rows: ChatMessage[], taskRunning: TaskRunning): number {
  let lastResult = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === 'result') {
      lastResult = i
      break
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]
    if (m.kind !== 'assistant') continue
    const turnOpen = i > lastResult
    if (turnOpen && m.streaming) return i
    for (const b of m.blocks) if (b.type === 'tool_use' && toolBusy(b, turnOpen, taskRunning)) return i
  }
  return rows.length
}

/**
 * The highest index a chat holding more than `max` rows may be cut at — keeping at least `keep`
 * rows and everything from the first busy row on — or -1 when it holds `max` or fewer.
 */
export function trimLimit(rows: ChatMessage[], keep: number, max: number, taskRunning: TaskRunning): number {
  if (rows.length <= max) return -1
  return Math.min(rows.length - keep, firstBusyRow(rows, taskRunning))
}

/** What the session host needs of a row to find its lines: small enough to send from the window. */
export interface RowPlace {
  id: string
  kind: ChatMessage['kind']
  /** Its tool calls, whose results are lines of their own. */
  toolIds?: string[]
}

export function rowPlace(m: ChatMessage): RowPlace {
  if (m.kind !== 'assistant') return { id: m.id, kind: m.kind }
  const toolIds = m.blocks.filter((b): b is ToolUseBlockView => b.type === 'tool_use').map((b) => b.id)
  return toolIds.length ? { id: m.id, kind: m.kind, toolIds } : { id: m.id, kind: m.kind }
}

/** Where lines are in a part of a transcript file (see readLineIndex in the session host). */
export interface LineIndex {
  /** Entry uuid → start of its line: prompts, notes, compaction notices. */
  uuid: Map<string, number>
  /** An answer's message id → start of its first line, and of its last (one line per block). */
  answerFirst: Map<string, number>
  answerLast: Map<string, number>
  /** Tool call id → start of the line holding its result. */
  result: Map<string, number>
}

/** A row's first and last line in the file, where they lie in the part indexed. */
function linesOf(p: RowPlace, idx: LineIndex): { first?: number; last?: number } {
  if (p.kind === 'assistant') {
    let last = idx.answerLast.get(p.id)
    for (const t of p.toolIds ?? []) {
      const r = idx.result.get(t)
      if (r !== undefined && (last === undefined || r > last)) last = r
    }
    return { first: idx.answerFirst.get(p.id), last }
  }
  const at = idx.uuid.get(p.id)
  return { first: at, last: at }
}

/**
 * Where to cut: the highest index up to `limit` whose row begins at a line at or after `from` with
 * every row above it lying wholly before that line, and that line; null when there is none. Rows
 * whose lines are not in the part indexed — before `from`, or not in the file at all (the app's own
 * notes, a turn's footer) — count as lying before it.
 */
export function cutAt(places: RowPlace[], limit: number, from: number, idx: LineIndex): { index: number; offset: number } | null {
  let above = -1
  let best: { index: number; offset: number } | null = null
  for (let k = 0; k <= Math.min(limit, places.length - 1); k++) {
    if (k > 0) {
      const last = linesOf(places[k - 1], idx).last
      if (last !== undefined && last > above) above = last
    }
    if (k === 0 || places[k].kind === 'result') continue
    const first = linesOf(places[k], idx).first
    if (first !== undefined && first >= from && above < first) best = { index: k, offset: first }
  }
  return best
}

/**
 * An update that names some subagent steps only by id (`keeps`, see updateForWindow in the host):
 * those are the window's own copies, put back in — the same objects, so what is drawn of them is
 * not drawn again. `missing` is true when the window does not have one of them; the whole row is
 * then asked for.
 */
export function withKeptChildren(prev: ChatMessage | undefined, msg: ChatMessage): { message: ChatMessage; missing: boolean } {
  if (msg.kind !== 'assistant') return { message: msg, missing: false }
  let missing = false
  const blocks = msg.blocks.map((b) => {
    if (b.type !== 'tool_use' || !b.children?.some((c) => (c as { kind: string }).kind === 'kept')) return b
    const before = prev?.kind === 'assistant' ? prev.blocks.find((x) => x.type === 'tool_use' && x.id === b.id) : undefined
    const have = new Map((before?.type === 'tool_use' ? (before.children ?? []) : []).map((c) => [c.id, c]))
    const children: ChatMessage[] = []
    for (const c of b.children) {
      if ((c as { kind: string }).kind !== 'kept') children.push(c)
      else if (have.has(c.id)) children.push(have.get(c.id)!)
      else missing = true
    }
    return { ...b, children }
  })
  return { message: { ...msg, blocks }, missing }
}
