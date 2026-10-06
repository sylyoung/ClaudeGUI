import React, { useMemo } from 'react'
import { diffLines } from 'diff'

interface Row {
  kind: 'add' | 'del' | 'ctx' | 'hunk'
  text: string
  oldNo?: number
  newNo?: number
}

/** Side-by-side-free unified diff of two strings. */
export function DiffView({ before, after, context = 3 }: { before: string; after: string; context?: number }) {
  const rows = useMemo(() => buildRows(before, after, context), [before, after, context])
  return (
    <div className="diff">
      {rows.map((r, i) => (
        <div className={`dl ${r.kind}`} key={i}>
          {r.kind === 'hunk' ? (
            <span>{r.text}</span>
          ) : (
            <>
              <span className="ln">{r.kind === 'add' ? '' : r.oldNo ?? ''}</span>
              <span className="ln">{r.kind === 'del' ? '' : r.newNo ?? ''}</span>
              <span className="dt">
                {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}
                {r.text}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function buildRows(before: string, after: string, context: number): Row[] {
  const parts = diffLines(before, after)
  const all: Row[] = []
  let oldNo = 1
  let newNo = 1
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n')
    for (const line of lines) {
      if (p.added) all.push({ kind: 'add', text: line, newNo: newNo++ })
      else if (p.removed) all.push({ kind: 'del', text: line, oldNo: oldNo++ })
      else all.push({ kind: 'ctx', text: line, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  // collapse long unchanged regions
  const keep = new Array(all.length).fill(false)
  all.forEach((r, i) => {
    if (r.kind !== 'ctx') for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true
  })
  if (!all.some((r) => r.kind !== 'ctx')) return all.slice(0, 200)
  const out: Row[] = []
  let skipping = 0
  all.forEach((r, i) => {
    if (keep[i]) {
      if (skipping) {
        out.push({ kind: 'hunk', text: `… ${skipping} unchanged lines …` })
        skipping = 0
      }
      out.push(r)
    } else skipping++
  })
  if (skipping) out.push({ kind: 'hunk', text: `… ${skipping} unchanged lines …` })
  return out
}
