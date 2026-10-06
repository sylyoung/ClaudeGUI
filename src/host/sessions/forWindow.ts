import type { AssistantBlockView, ChatMessage, ImageAttachment, KeptChild, ToolUseBlockView } from '@shared/types'
import type { RowChanges } from './transcript'

/**
 * A chat's rows as the window gets them: the pictures tools returned stay in the session host.
 *
 * Reading a PDF returns every page as a picture of about 200 KB, so a chat that read a few PDFs
 * carries megabytes of them — 7.3 MB of the 9.1 MB one long chat opened with. The window shows a
 * tool's pictures only inside its card, once the card is opened, so they are left out here and the
 * card asks for them (SessionRuntime.toolImages) when it is opened. Rows without such pictures are
 * handed on as they are.
 */
export function messagesForWindow(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(messageForWindow)
}

export function messageForWindow(m: ChatMessage): ChatMessage {
  if (m.kind !== 'assistant' || !m.blocks.some(holdsPictures)) return m
  return { ...m, blocks: m.blocks.map(blockForWindow) }
}

/**
 * A row as an update to the window: like messageForWindow, but the subagent steps (the children of
 * its tool calls) that did not change since the last update are sent as references to the copy the
 * window already has. A subagent's whole run is one row, re-sent on each of its steps; without this
 * a run of 700 steps sent all of them again 700 times, each time as new objects the window had to
 * build and draw again (up to 950 KB a time measured on the user's chats, 2026-09-28).
 *
 * `keeps` is set when there is at least one reference; the window puts its own copies back in (and
 * asks for the whole row when it has not got one of them).
 */
export function updateForWindow(m: ChatMessage, changes: RowChanges | undefined): { message: ChatMessage; keeps: boolean } {
  if (!changes || changes === 'all' || m.kind !== 'assistant' || !m.blocks.some((b) => b.type === 'tool_use' && b.children?.length)) {
    return { message: messageForWindow(m), keeps: false }
  }
  let keeps = false
  const blocks = m.blocks.map((b): AssistantBlockView => {
    if (b.type !== 'tool_use' || !b.children?.length) return blockForWindow(b)
    const children = b.children.map((c): ChatMessage => {
      if (changes.has(c.id)) return messageForWindow(c)
      keeps = true
      return { kind: 'kept', id: c.id } satisfies KeptChild as unknown as ChatMessage
    })
    return { ...b, result: resultForWindow(b.result), children }
  })
  return { message: { ...m, blocks }, keeps }
}

function holdsPictures(b: AssistantBlockView): boolean {
  if (b.type !== 'tool_use') return false
  if (b.result?.images?.some((i) => i.data)) return true
  return b.children?.some((c) => c.kind === 'assistant' && c.blocks.some(holdsPictures)) ?? false
}

function blockForWindow(b: AssistantBlockView): AssistantBlockView {
  if (!holdsPictures(b)) return b
  const t = b as ToolUseBlockView
  return { ...t, result: resultForWindow(t.result), children: t.children?.map(messageForWindow) }
}

function resultForWindow(r: ToolUseBlockView['result']): ToolUseBlockView['result'] {
  return r?.images?.some((i) => i.data) ? { ...r, images: r.images.map(placeholder) } : r
}

function placeholder(i: ImageAttachment): ImageAttachment {
  if (!i.data) return i
  return { mediaType: i.mediaType, name: i.name, data: '', bytes: Math.floor((i.data.length * 3) / 4) }
}

/** The pictures of one tool call, wherever in the chat (or inside a subagent's rows) it is. */
export function findToolImages(messages: ChatMessage[], toolUseId: string): ImageAttachment[] | null {
  for (const m of messages) {
    if (m.kind !== 'assistant') continue
    for (const b of m.blocks) {
      if (b.type !== 'tool_use') continue
      if (b.id === toolUseId) return b.result?.images ?? []
      if (b.children?.length) {
        const found = findToolImages(b.children, toolUseId)
        if (found) return found
      }
    }
  }
  return null
}
