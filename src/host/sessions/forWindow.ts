import type { AssistantBlockView, ChatMessage, ImageAttachment, ToolUseBlockView } from '@shared/types'

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

function holdsPictures(b: AssistantBlockView): boolean {
  if (b.type !== 'tool_use') return false
  if (b.result?.images?.some((i) => i.data)) return true
  return b.children?.some((c) => c.kind === 'assistant' && c.blocks.some(holdsPictures)) ?? false
}

function blockForWindow(b: AssistantBlockView): AssistantBlockView {
  if (!holdsPictures(b)) return b
  const t = b as ToolUseBlockView
  return {
    ...t,
    result: t.result?.images ? { ...t.result, images: t.result.images.map(placeholder) } : t.result,
    children: t.children?.map(messageForWindow)
  }
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
