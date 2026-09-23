/**
 * Where a note about unfinished work goes in a chat's input box. The session host writes the note
 * into the chat's stored draft when it stops the chat, and the window does the same to the box in
 * front of the user when the chat is open at that moment, so both have to follow the same rule:
 * words the user wrote themselves are never lost — an older note is replaced only while it is still
 * exactly as the app wrote it, and anything else in the box keeps its place with the note below it.
 */
export function mergeHandoffNote(draft: string | undefined, previous: string | undefined, note: string): string {
  const text = draft ?? ''
  if (!text.trim()) return note
  if (text.includes(note)) return text
  if (previous && text.includes(previous)) return text.replace(previous, note)
  return `${text.replace(/\s+$/, '')}\n\n${note}`
}
