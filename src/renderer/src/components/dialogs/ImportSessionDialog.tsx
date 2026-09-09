import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { CliSessionSummary } from '@shared/types'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import { formatBytes, shortenPath, timeAgo } from '@/lib/format'
import { isComposing } from '@/lib/keys'

export function ImportSessionDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<CliSessionSummary[] | null>(null)
  const [q, setQ] = useState('')
  const [dir, setDir] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const lastKeyAt = useRef(0)
  const appInfo = useStore((s) => s.appInfo)
  const records = useStore((s) => s.records)
  const selectSession = useStore((s) => s.selectSession)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    setItems(null)
    window.api.sessions.listCli(dir || undefined).then(setItems).catch((err) => { toast(err.message, 'error'); setItems([]) })
  }, [dir, toast])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (items ?? []).filter((i) => !s || i.summary.toLowerCase().includes(s) || (i.cwd ?? '').toLowerCase().includes(s) || i.sessionId.startsWith(s))
  }, [items, q])

  // keep the highlighted row valid while typing, and always visible while walking the list
  useEffect(() => setSel(0), [q, dir, items])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const importOne = async (i: CliSessionSummary) => {
    if (!i.cwd) {
      toast('This session has no working directory recorded', 'error')
      return
    }
    try {
      const rec = await window.api.sessions.importCli(i.sessionId, i.cwd, i.customTitle || i.summary)
      await selectSession(rec.id)
      onClose()
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  /** Import, or — for a session that is already in ClaudeGUI — just open the chat it became. */
  const activate = async (i: CliSessionSummary | undefined) => {
    if (!i) return
    if (i.alreadyImported) {
      const existing = Object.values(records).find((r) => r.claudeSessionId === i.sessionId)
      if (existing) {
        await selectSession(existing.id)
        onClose()
        return
      }
      toast('This session is already in ClaudeGUI', 'info')
      return
    }
    await importOne(i)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e)) return
    const last = filtered.length - 1
    lastKeyAt.current = Date.now()
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => Math.min(last, n + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => Math.max(0, n - 1)) }
    else if (e.key === 'PageDown') { e.preventDefault(); setSel((n) => Math.min(last, n + 10)) }
    else if (e.key === 'PageUp') { e.preventDefault(); setSel((n) => Math.max(0, n - 10)) }
    else if (e.key === 'Home') { e.preventDefault(); setSel(0) }
    else if (e.key === 'End') { e.preventDefault(); setSel(Math.max(0, last)) }
    else if (e.key === 'Enter') { e.preventDefault(); void activate(filtered[sel]) }
  }

  return (
    <Modal title="Import a Claude Code CLI session" onClose={onClose} width={880} tall>
      <div className="import-panel" onKeyDown={onKeyDown}>
        <div className="row">
          <input className="input" placeholder="Filter by title, folder or id…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <button className="btn" data-tip="Show only sessions from one folder" onClick={async () => { const d = await window.api.dialog.chooseDirectory(); if (d) setDir(d) }}>
            {dir ? shortenPath(dir, appInfo?.homeDir) : 'All projects'}
          </button>
          {dir && <button className="btn ghost" onClick={() => setDir('')}>clear</button>}
          <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {items === null ? 'scanning…' : `${filtered.length}${filtered.length !== items.length ? ` of ${items.length}` : ''} session${filtered.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="list grow" ref={listRef}>
          {items === null && <div className="faint" style={{ padding: 12 }}>Scanning ~/.claude/projects…</div>}
          {items && filtered.length === 0 && <div className="faint" style={{ padding: 12 }}>No sessions found.</div>}
          {filtered.map((i, idx) => (
            <div
              className={`list-item ${idx === sel ? 'sel' : ''} ${i.alreadyImported ? 'done' : ''}`}
              key={i.sessionId}
              data-idx={idx}
              onMouseEnter={() => { if (Date.now() - lastKeyAt.current > 400) setSel(idx) }}
              onClick={() => void activate(i)}
            >
              <div className="li-title">
                <span className="li-text">{i.summary.slice(0, 200)}</span>
                {i.alreadyImported && <span className="pill">already in ClaudeGUI</span>}
              </div>
              <div className="li-sub">
                {timeAgo(i.lastModified)} · {shortenPath(i.cwd ?? '?', appInfo?.homeDir)} · {i.fileSize ? formatBytes(i.fileSize) : ''} · {i.sessionId.slice(0, 8)}
              </div>
            </div>
          ))}
        </div>
        <div className="faint" style={{ fontSize: 12 }}>
          ↑ ↓ walk the list, Enter imports the highlighted session (one that is already in ClaudeGUI opens instead). The 300 most recent terminal sessions are listed; importing starts no process, and a session still open in a terminal should be closed there first.
        </div>
        <div className="actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  )
}
