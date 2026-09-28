import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { isComposing } from '@/lib/keys'
import { formatDateTime } from '@/lib/format'
import type { useChatFind } from './useChatFind'

/** Markdown marks read as noise in a one-line excerpt. */
const plain = (s: string) => s.replace(/\*\*|__|`/g, '')
/** Only a few words before the match, so the match itself is on the line and not cut off. */
function lead(before: string): string {
  const t = plain(before)
  return t.length > 24 ? `…${t.slice(-24).trimStart()}` : t
}

/**
 * The find box of a chat: a small box floating over the chat's top-right corner, as in Chrome and
 * VS Code, so the chat does not move when it opens. ⏎ goes to the next match, ⇧⏎ to the previous
 * one, Escape closes it. Below the field, while the chat has an older part that is not loaded, is
 * the way to search that part too, and then the list of what was found there.
 */
export function FindBox({ find }: { find: ReturnType<typeof useChatFind> }) {
  const [listOpen, setListOpen] = useState(true)
  const { whole, olderHits, inputRef, focusSeq } = find
  // When the box appears, and on every ⌘F after that: the cursor goes into the field.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [inputRef, focusSeq])
  const count =
    !find.query.trim() ? '' : find.total === 0 ? (whole?.state === 'running' ? '…' : 'No matches') : find.position >= 0 ? `${find.position + 1} of ${find.total}` : `${find.total} match${find.total === 1 ? '' : 'es'}`
  const countTip = find.hasOlderPart && whole?.state !== 'done'
    ? 'Matches in the part of this chat that is loaded. "Search whole chat" looks through the older part as well.'
    : 'Matches in your prompts and in Claude\'s replies, in the whole chat.'

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      find.step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      // The chat's own Escape stops a running turn; closing the box must not do that as well.
      e.preventDefault()
      e.stopPropagation()
      find.close()
    }
  }

  const percent = whole?.state === 'running' && whole.total > 0 ? Math.floor((whole.done / whole.total) * 100) : 0

  return (
    <div className="find-box no-drag" onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()}>
      <div className="find-row">
        <Search size={13} className="find-icon" />
        <input
          ref={find.inputRef}
          className="find-input"
          value={find.query}
          placeholder="Find in this chat"
          spellCheck={false}
          onChange={(e) => find.setQuery(e.target.value)}
          onKeyDown={onKey}
          data-tip="Find in your prompts and Claude's replies (not in tool details or thinking). Case does not matter. ⏎ next, ⇧⏎ previous, Esc closes."
        />
        <span className="find-count" data-tip={countTip}>{count}</span>
        <button className="btn ghost icon" disabled={!find.total} data-tip="Previous (older) match — ⇧⏎" onClick={() => find.step(-1)}>
          <ChevronUp size={14} />
        </button>
        <button className="btn ghost icon" disabled={!find.total} data-tip="Next (newer) match — ⏎ or ⌘G" onClick={() => find.step(1)}>
          <ChevronDown size={14} />
        </button>
        <button className="btn ghost icon" data-tip="Close (Esc)" onClick={find.close}>
          <X size={14} />
        </button>
      </div>
      {find.hasOlderPart && find.query.trim() && (
        <div className="find-older">
          {!find.wholeWanted ? (
            <button
              className="find-link"
              data-tip="Also search the older part of this chat, which is not loaded, by reading the chat's file on disk. In a very large chat this takes a few seconds. It then stays on for new words until this box is closed."
              onClick={find.searchWhole}
            >
              Search whole chat
            </button>
          ) : whole?.state === 'running' ? (
            <>
              <span className="faint">Searching the older part of the chat… {percent}%</span>
              <button className="find-link" data-tip="Stop searching the older part; only the loaded part is searched" onClick={find.stopWhole}>
                Stop
              </button>
            </>
          ) : whole?.state === 'error' ? (
            <span className="find-error" data-tip={whole.error}>Could not search the older part: {whole.error}</span>
          ) : whole?.state === 'done' ? (
            <>
              <button className="find-link" disabled={!olderHits.length} data-tip={olderHits.length ? 'Show or hide the list of matches in the older part' : undefined} onClick={() => setListOpen(!listOpen)}>
                {olderHits.length
                  ? `${listOpen ? '▾' : '▸'} ${olderHits.length}${whole.truncated ? '+' : ''} message${olderHits.length === 1 ? '' : 's'} in the older part`
                  : 'None in the older part of the chat'}
              </button>
              {whole.truncated && <span className="faint" data-tip="Only the newest 2,000 messages with a match in the older part are listed">(newest 2,000)</span>}
              {find.olderBusy && <span className="faint">reading…</span>}
            </>
          ) : null}
        </div>
      )}
      {whole?.state === 'done' && listOpen && olderHits.length > 0 && (
        <div className="find-hits">
          {olderHits.map((h, i) => (
            <button key={`${h.offset}`} className={`find-hit ${i === find.currentHit ? 'on' : ''}`} onClick={() => find.showHit(i)} data-tip="Show this part of the chat">
              <span className="find-hit-when">{formatDateTime(h.ts)}</span>
              <span className="find-hit-who">{h.role === 'user' ? 'You' : 'Claude'}</span>
              <span className="find-hit-text">
                {lead(h.snippet.before)}
                <mark>{plain(h.snippet.match)}</mark>
                {plain(h.snippet.after)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
