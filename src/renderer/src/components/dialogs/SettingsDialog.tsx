import React, { useEffect, useState } from 'react'
import type { AppSettings, PermissionMode, EffortLevel } from '@shared/types'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)!
  const appInfo = useStore((s) => s.appInfo)
  const setSettings = useStore((s) => s.setSettings)
  const [draft, setDraft] = useState<AppSettings>({ ...settings })
  const [envInfo, setEnvInfo] = useState<{ count: number; proxy: string[]; path: string } | null>(null)
  useEffect(() => {
    window.api.app.envInfo().then(setEnvInfo).catch(() => setEnvInfo(null))
  }, [])
  const upd = (patch: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...patch }))
  const save = async () => {
    await setSettings(draft)
    onClose()
  }
  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="field">
        <label>Claude executable (leave empty for the SDK-bundled binary, v{appInfo?.sdkVersion})</label>
        <input className="input" value={draft.claudeExecutable} onChange={(e) => upd({ claudeExecutable: e.target.value })} placeholder={appInfo?.claudeExecutable} spellCheck={false} />
        <span className="faint" style={{ fontSize: 11.5 }}>Your CLI install: ~/.nvm/versions/node/v24.15.0/bin/claude — settings, skills and MCP servers from ~/.claude are used either way. Changes apply to newly started processes.</span>
      </div>
      <div className="field">
        <label>Editor command for "open in editor" ({'{path}'} and {'{line}'} placeholders)</label>
        <input className="input" value={draft.editorCommand} onChange={(e) => upd({ editorCommand: e.target.value })} placeholder="subl {path}:{line}" spellCheck={false} />
      </div>
      <div className="grid2">
        <div className="field">
          <label>Default model for new sessions</label>
          <input className="input" value={draft.defaultModel} onChange={(e) => upd({ defaultModel: e.target.value })} placeholder="(use settings.json model)" spellCheck={false} />
        </div>
        <div className="field">
          <label>Default permission mode</label>
          <select className="select" style={{ maxWidth: 'none' }} value={draft.defaultPermissionMode} onChange={(e) => upd({ defaultPermissionMode: e.target.value as PermissionMode })}>
            {['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Default effort</label>
          <select className="select" style={{ maxWidth: 'none' }} value={draft.defaultEffort} onChange={(e) => upd({ defaultEffort: e.target.value as EffortLevel | '' })}>
            {['', 'low', 'medium', 'high', 'xhigh', 'max'].map((m) => (
              <option key={m} value={m}>{m || 'default'}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Chat font size</label>
          <input className="input" type="number" min={11} max={20} value={draft.fontSize} onChange={(e) => upd({ fontSize: Number(e.target.value) })} />
        </div>
      </div>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.notifications} onChange={(e) => upd({ notifications: e.target.checked })} /> macOS notifications when a background session finishes or needs input
      </label>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.showHiddenFiles} onChange={(e) => upd({ showHiddenFiles: e.target.checked })} /> Show hidden files in the file tree
      </label>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={draft.sendWithEnter} onChange={(e) => upd({ sendWithEnter: e.target.checked })} /> Enter sends the message (Shift+Enter for a newline). Off: ⌘Enter sends.
      </label>
      <div className="field">
        <label>Extra environment variables for Claude processes (one KEY=VALUE per line; applied on top of your shell's `claude` environment)</label>
        <textarea className="input" rows={3} value={draft.extraEnv} onChange={(e) => upd({ extraEnv: e.target.value })} placeholder={'HTTPS_PROXY=http://127.0.0.1:18118\nANTHROPIC_MODEL=…'} spellCheck={false} />
        <span className="faint" style={{ fontSize: 11.5 }}>
          Captured from your login shell via the `claude` wrapper: {envInfo ? `${envInfo.count} variables` : '…'}
          {envInfo?.proxy.length ? ` · proxy: ${envInfo.proxy.join(', ')}` : envInfo ? ' · no proxy variables detected' : ''}
          {' '}
          <button className="btn ghost sm" onClick={async () => { await window.api.app.reloadEnv(); setEnvInfo(await window.api.app.envInfo()) }}>reload</button>
        </span>
      </div>
      <div className="faint" style={{ fontSize: 11.5 }}>
        App data: {appInfo?.userDataPath} · Electron {appInfo?.electron} · Node {appInfo?.node}
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  )
}
