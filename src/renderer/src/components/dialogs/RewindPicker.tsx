import React, { useEffect, useMemo, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import { formatTime, timeAgo } from '@/lib/format'
import { isComposing } from '@/lib/keys'

/**
 * The list the double tap on Escape opens, the same step the terminal takes: it shows the prompts
 * you have sent in this chat, newest first, and asks which one to go back to. Picking one opens the
 * rewind window, which is where the choice between "the conversation only" and "the conversation and
 * the files" is made — nothing is changed from this list itself.
 */
export function RewindPicker({ sessionId, onPick, onClose }: { sessionId: string; onPick: (messageId: string) => void; onClose: () => void }) {
  const messages = useStore((s) => s.messages[sessionId])
  const queued = useStore((s) => s.live[sessionId]?.queuedIds)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const lastKeyAt = useRef(0)

  // Your own prompts, newest first. A prompt Claude Code has not taken yet cannot be rewound to —
  // there is nothing after it to remove — so the waiting ones are left out.
  const prompts = useMemo(() => {
    const waiting = new Set(queued ?? [])
    const list = (messages ?? [])
      .filter((m) => m.kind === 'user' && !m.synthetic && m.text.trim() && !waiting.has(m.id))
      .map((m) => ({ id: m.id, text: (m as { text: string }).text.trim(), ts: m.ts }))
    list.reverse()
    const needle = q.trim().toLowerCase()
    return needle ? list.filter((p) => p.text.toLowerCase().includes(needle)) : list
  }, [messages, queued, q])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e)) return
    const last = prompts.length - 1
    lastKeyAt.current = Date.now()
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => Math.min(last, n + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => Math.max(0, n - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setSel(0) }
    else if (e.key === 'End') { e.preventDefault(); setSel(Math.max(0, last)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const p = prompts[sel]
      if (p) onPick(p.id)
    }
  }

  return (
    <Modal title="Rewind: go back to one of your earlier prompts" onClose={onClose} width={720} tall>
      <div className="import-panel" onKeyDown={onKeyDown}>
        <div className="row">
          <input className="input" placeholder="Filter your prompts…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {prompts.length} prompt{prompts.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="list grow" ref={listRef}>
          {prompts.length === 0 && <div className="faint" style={{ padding: 12 }}>{q ? 'No prompt matches.' : 'This chat has no prompt to go back to yet.'}</div>}
          {prompts.map((p, idx) => (
            <div
              key={p.id}
              data-idx={idx}
              className={`list-item ${idx === sel ? 'sel' : ''}`}
              onMouseEnter={() => { if (Date.now() - lastKeyAt.current > 400) setSel(idx) }}
              onClick={() => onPick(p.id)}
            >
              <div className="li-title">
                <span className="li-text">{p.text.replace(/\s+/g, ' ').slice(0, 240)}</span>
              </div>
              <div className="li-sub">{formatTime(p.ts)} · {timeAgo(p.ts)}</div>
            </div>
          ))}
        </div>
        <div className="faint" style={{ fontSize: 12 }}>
          <History size={12} style={{ verticalAlign: -2 }} /> ↑ ↓ walk the list, Enter picks the highlighted prompt. Everything after it is removed from the chat and the prompt goes back into the input box; the next window asks whether the files should be put back as well.
        </div>
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}
