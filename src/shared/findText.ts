import type { ChatMessage } from './types'

/**
 * What finding text in a chat means, shared by the window (the part of a chat that is loaded) and
 * the app's reading of the chat's file (the part that is not), so both count the same matches.
 *
 * A find looks at the prompts you typed and at what Claude wrote in reply — not at tool details or
 * thinking. Case is ignored, every character is taken literally, and a space matches any run of
 * white space, so words that a reply broke across lines are still found.
 */
export function findPattern(query: string): RegExp | null {
  if (!query.trim()) return null
  const source = query
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('\\s+')
  return new RegExp(source, 'giu')
}

/** The text of a chat row that a find looks at: a prompt you typed, or Claude's reply; null otherwise. */
export function findableText(m: ChatMessage): string | null {
  if (m.kind === 'user') return !m.synthetic && m.parentToolUseId === null && m.text ? m.text : null
  if (m.kind === 'assistant') {
    if (m.parentToolUseId !== null) return null
    const parts: string[] = []
    for (const b of m.blocks) if (b.type === 'text' && b.text) parts.push(b.text)
    return parts.length ? parts.join('\n\n') : null
  }
  return null
}

export function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0
  let n = 0
  while (re.exec(text)) n++
  re.lastIndex = 0
  return n
}

export interface FindSnippet {
  before: string
  match: string
  after: string
}

/** A line of text around the first match, for a list of results. */
export function snippetOf(text: string, re: RegExp): FindSnippet | null {
  re.lastIndex = 0
  const m = re.exec(text)
  re.lastIndex = 0
  if (!m) return null
  const flat = (s: string) => s.replace(/\s+/g, ' ')
  const start = Math.max(0, m.index - 60)
  let before = flat(text.slice(start, m.index))
  if (start > 0) before = `…${before.trimStart().slice(-50)}`
  const tailStart = m.index + m[0].length
  let after = flat(text.slice(tailStart, tailStart + 120))
  if (tailStart + 120 < text.length) after = `${after.trimEnd()}…`
  return { before, match: flat(m[0]), after }
}
