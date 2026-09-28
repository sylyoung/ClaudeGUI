/**
 * Marking what a find in a chat matched, on the chat as it is drawn.
 *
 * The matches are painted with the CSS Custom Highlight API: ranges over the text that is already on
 * screen, coloured by `::highlight(...)` rules in styles.css. Nothing is inserted into the rows, so
 * the rendered markdown, links and code are left exactly as React drew them, and the marks go away
 * by forgetting the ranges.
 *
 * Only prompts and Claude's replies are looked at: a row of the chat carries `data-mid` (its id) and
 * the parts of it that hold what was said carry `data-find`; tool cards and thinking do not.
 */

const ALL = 'chat-find'
const CURRENT = 'chat-find-current'

/** The ranges each drawn row holds, keyed by row id, in the order the chat shows them. */
export function collectRanges(root: HTMLElement, re: RegExp): Map<string, Range[]> {
  const byRow = new Map<string, Range[]>()
  for (const row of root.querySelectorAll<HTMLElement>('[data-mid]')) {
    const id = row.dataset.mid
    if (!id) continue
    const ranges: Range[] = []
    for (const part of row.querySelectorAll<HTMLElement>('[data-find]')) rangesIn(part, re, ranges)
    if (ranges.length) byRow.set(id, ranges)
  }
  return byRow
}

/** The matches inside one element, which may run across the text nodes of bold, links or code. */
function rangesIn(el: HTMLElement, re: RegExp, out: Range[]): void {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    if (!t.data) continue
    nodes.push(t)
    starts.push(text.length)
    text += t.data
  }
  if (!text) return
  // The node a match starts in (the last one starting at or before it), or ends in (the last one
  // starting before its end, so an end on a boundary stays in the node before), and the offset there.
  const at = (i: number, end: boolean): [Text, number] => {
    let lo = 0
    let hi = nodes.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (end ? starts[mid] < i : starts[mid] <= i) lo = mid
      else hi = mid - 1
    }
    return [nodes[lo], i - starts[lo]]
  }
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0].length) {
      re.lastIndex++
      continue
    }
    const [sn, so] = at(m.index, false)
    const [en, eo] = at(m.index + m[0].length, true)
    const r = document.createRange()
    r.setStart(sn, so)
    r.setEnd(en, eo)
    out.push(r)
  }
  re.lastIndex = 0
}

function registry(): HighlightRegistry | undefined {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined
}

export function paintMatches(all: Range[], current: Range | null): void {
  const reg = registry()
  if (!reg) return
  reg.set(ALL, new Highlight(...all))
  const cur = new Highlight(...(current ? [current] : []))
  // The one you are on is drawn over the others.
  cur.priority = 1
  reg.set(CURRENT, cur)
}

export function clearMatches(): void {
  const reg = registry()
  reg?.delete(ALL)
  reg?.delete(CURRENT)
}

/**
 * Bring a match into view inside the chat's scrolling area, in the middle of it — unless it is on
 * screen already, when the chat is left where it is. A match inside a code block that scrolls
 * sideways is brought into view there too.
 */
export function revealRange(scroller: HTMLElement, range: Range): void {
  const pre = (range.startContainer.parentElement as HTMLElement | null)?.closest('pre')
  if (pre && pre.scrollWidth > pre.clientWidth) {
    const r = range.getBoundingClientRect()
    const p = pre.getBoundingClientRect()
    if (r.left < p.left || r.right > p.right) pre.scrollLeft += r.left - p.left - p.width / 2
  }
  const r = range.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  const margin = 48
  if (r.top >= box.top + margin && r.bottom <= box.bottom - margin) return
  scroller.scrollTop += r.top - box.top - box.height / 2 + r.height / 2
}

/** The first match at or below the top of what is on screen, or the last one when all are above. */
export function firstInView(scroller: HTMLElement, byRow: Map<string, Range[]>): { rowId: string; k: number } | null {
  const top = scroller.getBoundingClientRect().top
  let last: { rowId: string; k: number } | null = null
  for (const [rowId, ranges] of byRow) {
    for (let k = 0; k < ranges.length; k++) {
      if (ranges[k].getBoundingClientRect().bottom >= top) return { rowId, k }
      last = { rowId, k }
    }
  }
  return last
}
