import React, { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { EffortLevel, PermissionMode } from '@shared/types'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import { modelLabel, shortenPath } from '@/lib/format'
import { decodeModelChoice, encodeModelChoice } from '@/lib/providers'

import { EFFORTS, EFFORT_LABELS, MODES } from '@/lib/options'

const CLAUDE_MODELS = ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']
/** Picker value meaning "type a model id yourself". */
const CUSTOM = '__custom__'

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
  const providers = useStore((s) => s.providers)
  const loadProviders = useStore((s) => s.loadProviders)
  /** '' = default, a Claude id, "provider::model" for another provider, or CUSTOM with the typed id. */
  const [choice, setChoice] = useState(() => (settings?.defaultModel && !CLAUDE_MODELS.includes(settings.defaultModel) ? CUSTOM : settings?.defaultModel ?? ''))
  const [customModel, setCustomModel] = useState(settings?.defaultModel ?? '')
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
  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  const browse = async () => {
    const dir = await window.api.dialog.chooseDirectory(cwd || undefined)
    if (dir) setCwd(dir)
  }

  const create = async () => {
    if (!cwd.trim()) return
    setBusy(true)
    try {
      const picked = choice === CUSTOM ? { model: customModel.trim(), provider: undefined } : decodeModelChoice(choice)
      const record = await window.api.sessions.create({ cwd: cwd.trim(), title: title || undefined, model: picked.model || undefined, provider: picked.provider, permissionMode: mode, effort, groupId: groupId || undefined })
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
          <select className="select" style={{ maxWidth: 'none' }} value={choice} onChange={(e) => setChoice(e.target.value)} data-tip="Claude models, or the models of the other providers set up in Settings (Claude tab): GPT via Codex, DeepSeek, Kimi...">
            <optgroup label="Claude">
              <option value="">Default (from settings.json)</option>
              {CLAUDE_MODELS.map((m) => (
                <option key={m} value={m}>{modelLabel(m)} ({m})</option>
              ))}
              <option value={CUSTOM}>Other model id...</option>
            </optgroup>
            {providers.map((p) => (
              <optgroup key={p.id} label={p.available ? p.name : `${p.name}: not available (${p.reason ?? 'unknown reason'})`}>
                {p.models.map((m) => (
                  <option key={m.value} value={encodeModelChoice(p.id, m.value)} disabled={!p.available || Boolean(m.unavailable)} title={m.unavailable ?? m.description}>
                    {m.label}{m.unavailable ? ' (bridge update needed)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {choice === CUSTOM && (
            <input className="input" style={{ marginTop: 6 }} value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="model id, e.g. claude-opus-5" spellCheck={false} autoFocus />
          )}
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
