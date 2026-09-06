import React, { useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, FolderOpen, RefreshCw, RotateCw, XCircle } from 'lucide-react'
import type { AppSettings, HostStatus } from '@shared/types'
import { useStore } from '@/store'
import { formatDateTime, relativeTime } from '@/lib/format'

/**
 * Settings → About: one-click updates (check → build in the background → restart into the new
 * version) and the state of the session host that keeps Claude processes alive across restarts.
 */
export function UpdatesPanel({ draft, upd }: { draft: AppSettings; upd: (patch: Partial<AppSettings>) => void }) {
  const update = useStore((s) => s.update)
  const appInfo = useStore((s) => s.appInfo)
  const toast = useStore((s) => s.toast)
  const [host, setHost] = useState<HostStatus | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const refreshHost = () => window.api.host.status().then(setHost).catch(() => setHost(null))
  useEffect(() => {
    void refreshHost()
    const t = setInterval(() => void refreshHost(), 5000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [update.log])

  const run = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn()
    } catch (err) {
      toast(`${label}: ${(err as Error).message}`, 'error')
    }
  }
  const busy = update.status === 'checking' || update.status === 'building' || update.status === 'applying'
  const showLog = update.status === 'building' || update.status === 'applying' || (update.status === 'error' && update.log.length > 0)
  const progress = update.stepIndex && update.stepCount ? Math.round(((update.stepIndex - 1) / update.stepCount) * 100) : 0

  let statusText: React.ReactNode
  switch (update.status) {
    case 'unsupported':
      statusText = <span className="faint">{update.error}</span>
      break
    case 'checking':
      statusText = (
        <span>
          <RefreshCw size={12} className="spin" /> Checking for updates…
        </span>
      )
      break
    case 'up-to-date':
      statusText = (
        <span>
          <CheckCircle2 size={13} style={{ color: 'var(--green)' }} /> You are on the latest version ({update.currentVersion}).
          {update.checkedAt ? <span className="faint"> Checked {relativeTime(update.checkedAt)}.</span> : null}
        </span>
      )
      break
    case 'available':
      statusText = (
        <span>
          <ArrowUpCircle size={13} style={{ color: 'var(--accent)' }} /> <b>ClaudeGUI {update.latestVersion}</b> is available (you have {update.currentVersion}).
        </span>
      )
      break
    case 'building':
      statusText = (
        <span>
          <RefreshCw size={12} className="spin" /> Building {update.latestVersion}… the app stays usable meanwhile.
        </span>
      )
      break
    case 'ready':
      statusText = (
        <span>
          <CheckCircle2 size={13} style={{ color: 'var(--green)' }} /> ClaudeGUI {update.latestVersion} is built. {update.autoRestart ? 'Restarting…' : 'Restart to apply it.'}
        </span>
      )
      break
    case 'applying':
      statusText = (
        <span>
          <RotateCw size={12} className="spin" /> Restarting into {update.latestVersion}…
        </span>
      )
      break
    case 'error':
      statusText = (
        <span style={{ color: 'var(--red)' }}>
          <XCircle size={13} /> {update.error}
        </span>
      )
      break
    default:
      statusText = <span className="faint">Not checked yet.</span>
  }

  return (
    <>
      <div className="settings-section">
        <h3>Updates</h3>
        <div className="update-box">
          <div className="update-status">{statusText}</div>
          {update.status === 'building' && update.step && (
            <div className="update-step">
              <span>
                Step {update.stepIndex}/{update.stepCount}: {update.step}
              </span>
              <span className="bar">
                <span style={{ width: `${progress}%` }} />
              </span>
            </div>
          )}
          {update.notes && (update.status === 'available' || update.status === 'building' || update.status === 'ready') && <div className="update-notes">{update.notes}</div>}
          {showLog && (
            <div className="update-log" ref={logRef}>
              {update.log.slice(-60).join('\n')}
            </div>
          )}
          <div className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {update.status !== 'unsupported' && !busy && (
              <button className="btn sm" onClick={() => run(() => window.api.update.check(), 'Check for updates')}>
                <RefreshCw size={12} /> Check for updates
              </button>
            )}
            {update.status === 'available' && (
              <button className="btn sm primary" onClick={() => run(() => window.api.update.install(), 'Update')}>
                <ArrowUpCircle size={12} /> {update.autoRestart ? 'Update and restart' : 'Download and build'}
              </button>
            )}
            {update.status === 'error' && update.latestVersion && (
              <button className="btn sm primary" onClick={() => run(() => window.api.update.install(), 'Update')}>
                <ArrowUpCircle size={12} /> Retry update to {update.latestVersion}
              </button>
            )}
            {update.status === 'ready' && (
              <button className="btn sm primary" onClick={() => run(() => window.api.update.apply(), 'Restart')}>
                <RotateCw size={12} /> Restart now
              </button>
            )}
            {(update.status === 'building' || update.status === 'checking') && (
              <button className="btn sm" onClick={() => run(() => window.api.update.cancel(), 'Cancel')}>
                Cancel
              </button>
            )}
            <button className="btn sm ghost" onClick={() => run(() => window.api.update.openLog(), 'Open log')}>
              Open update log
            </button>
            <button className="btn sm ghost" onClick={() => run(() => window.api.update.openWorkDir(), 'Open folder')}>
              <FolderOpen size={12} /> Build folder
            </button>
          </div>
        </div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          Releases are the tags of the repository below. Updating checks the newest tag out into the build folder, installs dependencies, builds
          the app bundle and swaps it in at {appInfo?.bundlePath || 'the current app location'} before reopening ClaudeGUI. Settings, sessions and
          window layout are kept; running Claude sessions and their background tasks continue because they live in the session host process.
        </div>
        <label className="check">
          <input type="checkbox" checked={draft.updateAutoRestart} onChange={(e) => upd({ updateAutoRestart: e.target.checked })} />
          <span>
            <span>Restart automatically once the new version is built</span>
            <span className="hint">Otherwise a "Restart now" button appears here and in the top-right corner.</span>
          </span>
        </label>
        <div className="field">
          <label>Update repository (git URL or local path)</label>
          <input className="input" value={draft.updateRepo} onChange={(e) => upd({ updateRepo: e.target.value })} spellCheck={false} />
        </div>
        <div className="field">
          <label>Build folder (empty = ~/Library/Caches/ClaudeGUI/update)</label>
          <input className="input" value={draft.updateWorkDir} onChange={(e) => upd({ updateWorkDir: e.target.value })} placeholder="~/Library/Caches/ClaudeGUI/update" spellCheck={false} />
          <span className="hint">Holds the source checkout with its node_modules (about 0.5 GB) so later updates only rebuild what changed. Requires git, node and npm on your shell PATH.</span>
        </div>
      </div>

      <div className="settings-section">
        <h3>Session host</h3>
        <div className="kv" style={{ fontSize: 12.5 }}>
          <span className="k">Status</span>
          <span className="v">
            {host?.connected ? `running · pid ${host.pid} · started by ClaudeGUI ${host.version}${host.stale ? ' (older than this app; replaced once its sessions stop)' : ''}` : 'not connected'}
          </span>
          <span className="k">Live sessions</span>
          <span className="v">{host?.aliveSessions ?? '–'}</span>
          <span className="k">Since</span>
          <span className="v">{host?.startedAt ? `${formatDateTime(host.startedAt)} (${relativeTime(host.startedAt)})` : '–'}</span>
        </div>
        <div className="row" style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn sm"
            disabled={!host?.connected || (host?.aliveSessions ?? 0) > 0}
            title={(host?.aliveSessions ?? 0) > 0 ? 'Stop all sessions first' : 'Start a fresh session host process'}
            onClick={() => run(() => window.api.host.restart().then(refreshHost), 'Restart host')}
          >
            <RotateCw size={12} /> Restart session host
          </button>
          {host?.logFile && (
            <button className="btn sm ghost" onClick={() => window.api.shell.showInFolder(host.logFile!)}>
              Reveal host log
            </button>
          )}
        </div>
        <div className="faint" style={{ fontSize: 11.5 }}>
          The session host is a separate background process that owns every Claude process. Closing or restarting this window (for example
          to apply an update) leaves it running; quitting ClaudeGUI stops it together with all sessions.
        </div>
      </div>
    </>
  )
}
