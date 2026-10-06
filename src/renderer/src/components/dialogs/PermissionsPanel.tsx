import React, { useEffect, useState } from 'react'
import { CheckCircle2, CircleHelp, ExternalLink, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import type { PermissionInfo, PermissionState } from '@shared/types'
import { useStore } from '@/store'

const STATE_LABEL: Record<PermissionState, string> = {
  granted: 'granted',
  denied: 'not granted',
  'not-determined': 'not asked yet',
  restricted: 'restricted by policy',
  unknown: 'unknown',
  unsupported: 'not applicable'
}

function StateIcon({ state }: { state: PermissionState }) {
  if (state === 'granted') return <CheckCircle2 size={14} style={{ color: 'var(--green)' }} />
  if (state === 'denied' || state === 'restricted') return <XCircle size={14} style={{ color: 'var(--red)' }} />
  return <CircleHelp size={14} style={{ color: 'var(--text-faint)' }} />
}

/**
 * Settings → Permissions: macOS privacy grants for ClaudeGUI. Claude's tools run as child processes
 * of the app, so macOS attributes their file, automation and device access to ClaudeGUI.
 */
export function PermissionsPanel() {
  const toast = useStore((s) => s.toast)
  const appInfo = useStore((s) => s.appInfo)
  const [items, setItems] = useState<PermissionInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = async () => {
    try {
      setItems(await window.api.permissions.list())
    } catch (err) {
      toast(`Permissions: ${(err as Error).message}`, 'error')
    }
  }
  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const request = async (key: string) => {
    setBusy(key)
    try {
      setItems(await window.api.permissions.request(key))
    } catch (err) {
      toast(`Request failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(null)
    }
  }
  const requestAll = async () => {
    setBusy('*')
    try {
      setItems(await window.api.permissions.requestAll())
      toast('Every permission the app can ask for was requested. Manual ones need a toggle in System Settings.', 'info')
    } catch (err) {
      toast(`Request failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const granted = items?.filter((i) => i.state === 'granted').length ?? 0
  return (
    <>
      <div className="settings-section">
        <h3>macOS privacy permissions</h3>
        <div className="faint" style={{ fontSize: 11.5 }}>
          Claude's tools (shell commands, file edits, AppleScript…) run as child processes of ClaudeGUI, so macOS asks <b>ClaudeGUI</b> for
          access to protected folders, other apps and devices. Grant what you want Claude to be able to use. Prompts appear as system dialogs;
          items marked "manual" can only be switched on in System Settings → Privacy &amp; Security (the app is listed there as ClaudeGUI
          {appInfo?.packaged ? '' : ' — or as Electron while running in development mode'}).
        </div>
        <div className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn sm primary" disabled={busy !== null} onClick={() => void requestAll()} data-tip="Trigger every system prompt the app can trigger, one after the other">
            <ShieldCheck size={13} /> {busy === '*' ? 'Requesting…' : 'Request all'}
          </button>
          <button className="btn sm" onClick={() => void refresh()} data-tip="Probe the current state again">
            <RefreshCw size={12} /> Refresh
          </button>
          <button className="btn sm ghost" onClick={() => void window.api.permissions.openPane('')} data-tip="Open System Settings → Privacy & Security">
            <ExternalLink size={12} /> Privacy &amp; Security settings
          </button>
          {items && (
            <span className="faint" style={{ alignSelf: 'center', fontSize: 11.5 }}>
              {granted} of {items.filter((i) => i.state !== 'unsupported').length} granted
            </span>
          )}
        </div>
        {!items && <div className="faint">Checking…</div>}
        {items && (
          <div className="perm-list">
            {items.map((p) => (
              <div key={p.key} className={`perm-row st-${p.state}`}>
                <StateIcon state={p.state} />
                <div className="perm-main">
                  <div className="perm-title">
                    {p.label} <span className={`perm-state st-${p.state}`}>{STATE_LABEL[p.state]}</span>
                    {p.manual && <span className="perm-manual" data-tip="macOS only lets you switch this on in System Settings; the button opens the right pane">manual</span>}
                  </div>
                  <div className="perm-desc">{p.description}</div>
                  {p.detail && <div className="perm-detail">{p.detail}</div>}
                </div>
                <div className="perm-actions">
                  {p.canRequest && p.state !== 'granted' && (
                    <button className="btn sm" disabled={busy !== null} onClick={() => void request(p.key)} data-tip="Ask macOS now (a system dialog may appear)">
                      {busy === p.key ? '…' : 'Request'}
                    </button>
                  )}
                  {p.hasPane && (
                    <button className="btn sm ghost" onClick={() => void window.api.permissions.openPane(p.key)} data-tip="Open the matching pane in System Settings">
                      <ExternalLink size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="faint" style={{ fontSize: 11.5 }}>
          Grants are tied to the app's code signature. Builds signed with your Apple Development certificate keep them across updates; unsigned builds may have to be granted again after an update.
        </div>
      </div>
    </>
  )
}
