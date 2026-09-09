import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpCircle, Gauge, RefreshCw, RotateCw } from 'lucide-react'
import type { UsageWindow } from '@shared/types'
import { useStore } from '@/store'
import { Popover } from '../common/Popover'
import { formatDateTime, formatPercent, relativeTime, timeUntil } from '@/lib/format'

/** Re-render every `ms` so "2m ago" style labels stay current. */
function useTick(ms = 30_000): void {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

function shortLabel(w: UsageWindow): string {
  switch (w.group) {
    case 'session': return '5h'
    case 'weekly': return 'Wk'
    case 'model': return w.label.replace(/^Weekly\s+/i, '').slice(0, 6)
    case 'monthly': return 'Cred'
    default: return w.label.slice(0, 10)
  }
}

const SOURCE_LABEL: Record<string, string> = {
  endpoint: 'claude.ai usage endpoint (same data as /usage)',
  session: 'a running Claude session (/usage)',
  event: 'rate-limit headers of API responses',
  none: 'nothing yet'
}

/**
 * The whole scale, always on screen: green from 0 to the amber threshold, amber up to 90 %, red
 * above it — the same cut-offs the status line in the terminal uses. Painting the full scale means
 * the red end is visible even when almost nothing is used, so a bar can be read at a glance
 * without remembering where the colours change.
 */
function scaleBackground(warn: number): string {
  const w = Math.min(85, Math.max(10, Math.round(warn)))
  return `linear-gradient(to right, var(--ctx-ok) 0 ${w}%, var(--ctx-warn) ${w}% ${CRITICAL}%, var(--ctx-high) ${CRITICAL}% 100%)`
}

/** Where the scale turns red. Matches CRITICAL_PERCENT in the main process's usage service. */
const CRITICAL = 90

/**
 * A bar showing the full scale with the part you have not reached dimmed and a needle at the
 * current percentage, so both "how much is used" and "how close to the red" are readable.
 */
function ScaleBar({ percent, warn, className }: { percent: number | null; warn: number; className: string }) {
  const p = Math.min(100, Math.max(0, percent ?? 0))
  return (
    <span className={className} style={{ background: scaleBackground(warn) }}>
      <span className="u-rest" style={{ left: `${p}%` }} />
      {percent != null && <span className="u-needle" style={{ left: `min(max(0%, calc(${p}% - 1px)), calc(100% - 2px))` }} />}
    </span>
  )
}

/** "Update 1.0.3" / "Building…" / "Restart to 1.0.3" pill shown next to the usage limits. */
export function UpdatePill() {
  const u = useStore((s) => s.update)
  const openSettings = useStore((s) => s.openSettings)
  if (u.status !== 'available' && u.status !== 'building' && u.status !== 'ready' && u.status !== 'applying') return null
  const label =
    u.status === 'available' ? `Update ${u.latestVersion}` : u.status === 'building' ? `Building ${u.latestVersion}…` : u.status === 'ready' ? `Restart to ${u.latestVersion}` : 'Restarting…'
  return (
    <button className={`update-pill no-drag st-${u.status}`} onClick={() => openSettings('about')} data-tip="Open the update details (Settings → About)">
      {u.status === 'building' || u.status === 'applying' ? <RotateCw size={11} className="spin" /> : <ArrowUpCircle size={11} />}
      <span>{label}</span>
    </button>
  )
}

/** Compact plan-usage pills for the top-right corner; click for the full breakdown. */
export function UsageStatus({ compact }: { compact?: boolean }) {
  const usage = useStore((s) => s.usage)
  const enabled = useStore((s) => s.settings?.showUsageStatus ?? true)
  const warn = useStore((s) => s.settings?.usageWarnPercent ?? 50)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  useTick()
  if (!enabled) return <UpdatePill />
  const shown = usage.windows.filter((w) => w.group !== 'other').slice(0, compact ? 3 : 5)
  const checked = usage.fetchedAt ? relativeTime(usage.fetchedAt).replace(' ago', '').replace('just now', 'now') : '—'
  return (
    <>
      <UpdatePill />
      <button ref={ref} className={`usage-cluster no-drag ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)} data-tip="Plan usage limits (click for details)">
        {shown.length === 0 && (
          <span className={`usage-pill sev-${usage.error ? 'warning' : 'unknown'}`}>
            <Gauge size={11} /> {usage.checking ? 'checking limits…' : usage.error ? 'limits unavailable' : 'limits'}
          </span>
        )}
        {shown.map((w) => (
          <span
            key={w.key}
            className={`usage-pill sev-${w.severity}`}
            data-tip={`${w.label}: ${formatPercent(w.percent)} used${w.resetsAt ? ` · resets ${timeUntil(w.resetsAt)}` : ''}. The bar is the whole scale: green to ${warn} %, amber to ${CRITICAL} %, red above; the mark is where you stand.`}
          >
            <span className="u-label">{shortLabel(w)}</span>
            <span className="u-pct">{formatPercent(w.percent)}</span>
            <ScaleBar className="u-bar" percent={w.percent} warn={warn} />
          </span>
        ))}
        <span className="usage-checked" data-tip={usage.fetchedAt ? `Last check ${formatDateTime(usage.fetchedAt)}` : 'Not checked yet'}>
          {usage.checking ? <RefreshCw size={10} className="spin" /> : usage.error ? <AlertTriangle size={10} /> : <span>✓</span>}
          <span>{checked}</span>
        </span>
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={420}>
          <UsageDetails />
        </Popover>
      )}
    </>
  )
}

export function UsageDetails() {
  const usage = useStore((s) => s.usage)
  const warn = useStore((s) => s.settings?.usageWarnPercent ?? 50)
  useTick(10_000)
  return (
    <div className="usage-details">
      <div className="pop-head">
        <Gauge size={14} />
        <b>Plan usage limits</b>
        {usage.subscription && <span className="pill">{usage.subscription}</span>}
        <span className="spacer" />
        <button className="btn sm" onClick={() => void window.api.usage.refresh()} disabled={usage.checking}>
          <RefreshCw size={12} className={usage.checking ? 'spin' : ''} /> Check now
        </button>
      </div>
      {usage.error && (
        <div className="msg-system warning">
          <AlertTriangle size={14} />
          <div className="body">{usage.error}</div>
        </div>
      )}
      {usage.windows.length === 0 && !usage.error && <div className="faint">No limit information yet. Limits appear after the first check or the first API response.</div>}
      {usage.windows.length > 0 && (
        <div className="u-legend">
          <span className="swatch" style={{ background: scaleBackground(warn) }} />
          <span>whole scale: green to {warn} %, amber to {CRITICAL} %, red above — the mark is where the limit stands</span>
        </div>
      )}
      {usage.windows.map((w) => (
        <div key={w.key} className={`usage-row sev-${w.severity}`}>
          <div className="u-row-head">
            <span className="u-name">
              {w.label}
              {w.isActive ? <span className="pill green" style={{ marginLeft: 6 }}>active</span> : null}
            </span>
            <span className="u-val">{formatPercent(w.percent)}</span>
          </div>
          <ScaleBar className="u-track" percent={w.percent} warn={warn} />
          <div className="u-sub">
            {w.resetsAt ? `resets ${timeUntil(w.resetsAt)} · ${formatDateTime(w.resetsAt)}` : 'no reset time reported'}
            {w.detail ? ` · ${w.detail}` : ''}
            {w.severity === 'locked' ? ' · limit reached' : w.severity === 'critical' ? ' · almost exhausted' : w.severity === 'warning' ? ' · above warning threshold' : ''}
            {w.updatedAt && w.updatedAt !== usage.fetchedAt ? ` · updated ${relativeTime(w.updatedAt)}` : ''}
          </div>
        </div>
      ))}
      <div className="u-footer faint">
        Last check: {usage.fetchedAt ? `${formatDateTime(usage.fetchedAt)} (${relativeTime(usage.fetchedAt)})` : 'never'}
        {usage.nextCheckAt ? ` · next ${timeUntil(usage.nextCheckAt)}` : ''}
        <br />
        Source: {SOURCE_LABEL[usage.source] ?? usage.source}. Limits also update from the rate-limit headers of every API response.
      </div>
    </div>
  )
}
