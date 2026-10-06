import React from 'react'
import { findPaths } from '@/lib/paths'
import { useChatCtx } from './ChatContext'

const URL_RE = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g

/** Plain text with clickable URLs and file paths (used for user messages and tool output). */
export function LinkifiedText({ text }: { text: string }) {
  const ctx = useChatCtx()
  const nodes: React.ReactNode[] = []
  let key = 0
  const pushPaths = (segment: string) => {
    const matches = findPaths(segment)
    let cursor = 0
    for (const m of matches) {
      if (m.start > cursor) nodes.push(segment.slice(cursor, m.start))
      nodes.push(
        <span
          key={key++}
          className="file-link"
          onClick={(e) => ctx?.openPath(m.path, m.line, { inEditor: e.metaKey || e.altKey })}
          onContextMenu={(e) => {
            e.preventDefault()
            ctx?.showPathMenu(m.path, m.line, e.clientX, e.clientY)
          }}
        >
          {m.raw}
        </span>
      )
      cursor = m.end
    }
    if (cursor < segment.length) nodes.push(segment.slice(cursor))
  }
  let last = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) pushPaths(text.slice(last, m.index))
    const url = m[0]
    nodes.push(
      <a key={key++} href={url} onClick={(e) => { e.preventDefault(); window.api.shell.openExternal(url) }}>
        {url}
      </a>
    )
    last = m.index + url.length
  }
  if (last < text.length) pushPaths(text.slice(last))
  return <>{nodes}</>
}
