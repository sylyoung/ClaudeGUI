/**
 * Finding text in the part of a chat that is not loaded (see host/sessions/transcriptSearch.ts),
 * and reading the rows around what was found. The window asks for these directly; the session host
 * is not involved, so an updated app has them straight away.
 */
import path from 'path'
import type { ChatFileRef, ChatFileRows, ChatFileSearch, ChatRowsRequest, ChatSearchProgress } from '@shared/types'
import { projectDirFor } from '../host/sessions/paths'
import { setToolResultMaxChars } from '../host/sessions/transcript'
import { SearchCancelled, loadedPartStart, readRowsAfter, readRowsAround, readRowsBefore, searchTranscript, type SearchControl } from '../host/sessions/transcriptSearch'

function fileOf(ref: ChatFileRef): string {
  if (!/^[0-9a-f-]{36}$/.test(ref.claudeSessionId)) throw new Error('Not a Claude Code session id')
  return path.join(projectDirFor(ref.cwd), `${ref.claudeSessionId}.jsonl`)
}

/** The search running for each chat; a new one for the same chat stops it. */
const running = new Map<string, SearchControl>()

export async function searchChatFile(
  req: ChatFileRef & { searchId: number; query: string; historyFrom: number },
  progress: (p: ChatSearchProgress) => void
): Promise<ChatFileSearch> {
  const previous = running.get(req.claudeSessionId)
  if (previous) previous.cancelled = true
  const control: SearchControl = { cancelled: false }
  running.set(req.claudeSessionId, control)
  const file = fileOf(req)
  let sentAt = 0
  try {
    const to = await loadedPartStart(file, req.historyFrom)
    const { hits, truncated } = await searchTranscript(file, req.query, to, control, (done, total) => {
      if (Date.now() - sentAt < 150) return
      sentAt = Date.now()
      progress({ searchId: req.searchId, done, total })
    })
    return { searchId: req.searchId, hits, truncated, cancelled: false }
  } catch (err) {
    if (err instanceof SearchCancelled) return { searchId: req.searchId, hits: [], truncated: false, cancelled: true }
    throw err
  } finally {
    if (running.get(req.claudeSessionId) === control) running.delete(req.claudeSessionId)
  }
}

export function stopChatSearch(ref: ChatFileRef): void {
  const control = running.get(ref.claudeSessionId)
  if (control) control.cancelled = true
}

export async function readChatRows(ref: ChatFileRef, req: ChatRowsRequest, toolResultMaxChars: number): Promise<ChatFileRows & { limit: number }> {
  setToolResultMaxChars(toolResultMaxChars)
  const file = fileOf(ref)
  switch (req.kind) {
    case 'around': {
      const limit = await loadedPartStart(file, req.historyFrom)
      return { ...(await readRowsAround(file, ref, { offset: req.offset, end: req.end }, limit)), limit }
    }
    case 'before':
      return { ...(await readRowsBefore(file, ref, req.to)), limit: req.to }
    case 'after': {
      const limit = await loadedPartStart(file, req.historyFrom)
      return { ...(await readRowsAfter(file, ref, req.from, limit)), limit }
    }
  }
}
