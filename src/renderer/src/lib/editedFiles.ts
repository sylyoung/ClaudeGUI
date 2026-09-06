import type { ChatMessage } from '@shared/types'

/** Tools that change a file; their `file_path` is what Claude touched in this session. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function collect(messages: ChatMessage[], cwd: string, out: Set<string>): void {
  for (const m of messages) {
    if (m.kind !== 'assistant') continue
    for (const b of m.blocks) {
      if (b.type !== 'tool_use') continue
      if (b.children?.length) collect(b.children, cwd, out)
      if (!EDIT_TOOLS.has(b.name)) continue
      const raw = b.input.file_path ?? b.input.notebook_path
      if (typeof raw !== 'string' || !raw) continue
      out.add(raw.startsWith('/') ? raw : `${cwd.replace(/\/$/, '')}/${raw}`)
    }
  }
}

/**
 * Absolute paths of the files Claude edited or wrote in this chat (subagents included), used to
 * mark them in the file tree. Read from the transcript, so it also covers earlier launches.
 */
export function editedFiles(messages: ChatMessage[] | undefined, cwd: string): Set<string> {
  const out = new Set<string>()
  if (messages?.length) collect(messages, cwd, out)
  return out
}
