import React, { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { EffortLevel, PermissionMode } from '@shared/types'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import { shortenPath } from '@/lib/format'

import { EFFORTS, EFFORT_LABELS, MODES } from '@/lib/options'

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const appInfo = useStore((s) => s.appInfo)
  const records = useStore((s) => s.records)
  const groups = useStore((s) => s.groups)
  const activeId = useStore((s) => s.activeId)
  const selectSession = useStore((s) => s.selectSession)
  const toast = useStore((s) => s.toast)
  const [cwd, setCwd] = useState(activeId ? records[activeId]?.cwd ?? '' : '')
  const [title, setTitle] = useState('')
  const [model, setModel] = useState(settings?.defaultModel ?? '')
  const [mode, setMode] = useState<PermissionMode>(settings?.defaultPermissionMode ?? 'default')
  const [effort, setEffort] = useState<EffortLevel | ''>(settings?.defaultEffort ?? '')
  const [prompt, setPrompt] = useState('')
  const [groupId, setGroupId] = useState<string>(() => (activeId ? records[activeId]?.groupId ?? '' : ''))
  const [busy, setBusy] = useState(false)

  const recent = Array.from(new Set([...(settings?.recentDirectories ?? []), ...Object.values(records).map((r) => r.cwd)])).slice(0, 12)
  useEffect(() => {
    if (!cwd && (settings?.defaultCwd || recent[0])) setCwd(settings?.defaultCwd || recent[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const browse = async () => {
    const dir = await window.api.dialog.chooseDirectory(cwd || undefined)
    if (dir) setCwd(dir)
  }

  const create = async () => {
    if (!cwd.trim()) return
    setBusy(true)
    try {
      const record = await window.api.sessions.create({ cwd: cwd.trim(), title: title || undefined, model: model || undefined, permissionMode: mode, effort, groupId: groupId || undefined })
      await selectSession(record.id)
      onClose()
      if (prompt.trim()) await window.api.sessions.send(record.id, prompt.trim())
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="New session" onClose={onClose}>
      <div className="field">
        <label>Working directory</label>
        <div className="row">
          <input className="input" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" autoFocus spellCheck={false} />
          <button className="btn" onClick={browse}>
            <FolderOpen size={14} /> Browse
          </button>
        </div>
        {recent.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {recent.map((d) => (
              <span key={d} className={`chip ${d === cwd ? 'active' : ''}`} onClick={() => setCwd(d)} data-tip={d}>
                {shortenPath(d, appInfo?.homeDir)}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="grid2">
        <div className="field">
          <label>Title (optional, otherwise auto-generated)</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Refactor data loader" />
        </div>
        <div className="field">
          <label>Model</label>
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="default from settings.json (e.g. claude-opus-5)" list="model-suggestions" />
          <datalist id="model-suggestions">
            <option value="claude-fable-5-1" />
            <option value="claude-fable-5-1[1m]" />
            <option value="claude-opus-5" />
            <option value="claude-sonnet-5" />
            <option value="claude-haiku-4-5" />
          </datalist>
        </div>
        <div className="field">
          <label>Permission mode</label>
          <select className="select" style={{ maxWidth: 'none' }} value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value} title={m.hint}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Effort</label>
          <select className="select" style={{ maxWidth: 'none' }} value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')}>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>{EFFORT_LABELS[e] ?? e}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Group</label>
          <select className="select" style={{ maxWidth: 'none' }} value={groupId} onChange={(e) => setGroupId(e.target.value)} data-tip="Sidebar category for this session (create groups with the folder-plus button in the sidebar)">
            <option value="">No group</option>
            {[...groups].sort((a, b) => a.order - b.order).map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>First message (optional)</label>
        <textarea className="input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Start the session with this prompt…" />
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={create} disabled={!cwd.trim() || busy}>
          Create session
        </button>
      </div>
    </Modal>
  )
}
