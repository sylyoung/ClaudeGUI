import React, { useEffect, useMemo, useState } from 'react'
import type { CliSessionSummary } from '@shared/types'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import { formatBytes, shortenPath, timeAgo } from '@/lib/format'

export function ImportSessionDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<CliSessionSummary[] | null>(null)
  const [q, setQ] = useState('')
  const [dir, setDir] = useState('')
  const appInfo = useStore((s) => s.appInfo)
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

  return (
    <Modal title="Import a Claude Code CLI session" onClose={onClose} width={720}>
      <div className="row">
        <input className="input" placeholder="Filter by title, folder or id…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <button className="btn" onClick={async () => { const d = await window.api.dialog.chooseDirectory(); if (d) setDir(d) }}>
          {dir ? shortenPath(dir, appInfo?.homeDir) : 'All projects'}
        </button>
        {dir && <button className="btn ghost" onClick={() => setDir('')}>clear</button>}
      </div>
      <div className="list">
        {items === null && <div className="faint" style={{ padding: 12 }}>Scanning ~/.claude/projects…</div>}
        {items && filtered.length === 0 && <div className="faint" style={{ padding: 12 }}>No sessions found.</div>}
        {filtered.slice(0, 300).map((i) => (
          <div className="list-item" key={i.sessionId} onClick={() => !i.alreadyImported && importOne(i)} style={i.alreadyImported ? { opacity: 0.5, cursor: 'default' } : undefined}>
            <div className="li-title">
              {i.summary.slice(0, 140)} {i.alreadyImported && <span className="pill">already in ClaudeGUI</span>}
            </div>
            <div className="li-sub">
              {timeAgo(i.lastModified)} · {shortenPath(i.cwd ?? '?', appInfo?.homeDir)} · {i.fileSize ? formatBytes(i.fileSize) : ''} · {i.sessionId.slice(0, 8)}
            </div>
          </div>
        ))}
      </div>
      <div className="faint" style={{ fontSize: 12 }}>Importing does not start a process; the transcript is shown and the session resumes when you send a message. A session currently open in a terminal should be closed there first.</div>
      <div className="actions">
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}
