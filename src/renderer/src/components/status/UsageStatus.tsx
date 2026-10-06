import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpCircle, Gauge, KeyRound, RefreshCw, RotateCw } from 'lucide-react'
import type { UsageProviderId, UsageProviderState, UsageSnapshot, UsageWindow } from '@shared/types'
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

/** Where the numbers come from, per subscription: the same wording for both would be misleading. */
const SOURCE_LABEL: Record<UsageProviderId, Partial<Record<UsageSnapshot['source'], string>>> = {
  claude: {
    endpoint: 'claude.ai usage endpoint (same data as /usage)',
    session: 'a running Claude session (/usage)',
    event: 'rate-limit headers of API responses',
    none: 'nothing yet'
  },
  codex: {
    endpoint: "ChatGPT's usage endpoint, the one the Codex CLI reads",
    none: 'nothing yet'
  }
}

/** Where the numbers turn red. Matches CRITICAL_PERCENT in the main process's usage service. */
const CRITICAL = 90

const NO_SNAPSHOT: UsageSnapshot = { fetchedAt: 0, source: 'none', windows: [] }

/** The subscription the corner shows; the setting is written by the switch below. */
function useSubscription(): { id: UsageProviderId; label: string; snapshot: UsageSnapshot; providers: UsageProviderState[] } {
  const providers = useStore((s) => s.usage.providers)
  const wanted = useStore((s) => s.settings?.usageSubscription)
  const provider = providers.find((p) => p.id === wanted) ?? providers[0]
  return { id: provider?.id ?? 'claude', label: provider?.label ?? 'Plan', snapshot: provider?.snapshot ?? NO_SNAPSHOT, providers }
}

/** The scale in words, each word in its own colour, so the red is on screen at any level of use. */
function ScaleLegend({ warn }: { warn: number }) {
  return (
    <div className="u-legend">
      A number is <span className="ok">green</span> below {warn} %, <span className="warn">amber</span> from {warn} % and{' '}
      <span className="high">red</span> from {CRITICAL} % of the limit.
    </div>
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
  const { id, label, snapshot: usage, providers } = useSubscription()
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
      <button
        ref={ref}
        className={`usage-cluster no-drag ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        data-tip={`Plan usage limits — ${label}${providers.length > 1 ? ' (click to switch subscription or see details)' : ' (click for details)'}`}
      >
        {shown.length === 0 && (
          <span className={`usage-pill sev-${usage.error ? 'warning' : 'unknown'}`}>
            <Gauge size={11} /> {usage.checking ? 'checking limits…' : usage.error ? 'limits unavailable' : 'limits'}
          </span>
        )}
        {shown.map((w) => (
          <span
            key={w.key}
            className={`usage-pill sev-${w.severity}`}
            data-tip={`${label} · ${w.label}: ${formatPercent(w.percent)} used${w.resetsAt ? ` · resets ${timeUntil(w.resetsAt)}` : ''}. The number is green below ${warn} %, amber from ${warn} % and red from ${CRITICAL} %.`}
          >
            <span className="u-label">{shortLabel(w)}</span>
            <span className="u-pct">{formatPercent(w.percent)}</span>
          </span>
        ))}
        <span className="usage-checked" data-tip={usage.fetchedAt ? `${label}: last check ${formatDateTime(usage.fetchedAt)}` : `${label}: not checked yet`}>
          {usage.checking ? <RefreshCw size={10} className="spin" /> : usage.error ? <AlertTriangle size={10} /> : <span>✓</span>}
          <span>{checked}</span>
        </span>
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={470}>
          <UsageDetails />
        </Popover>
      )}
    </>
  )
}

/** Claude's plan, or the ChatGPT one Codex signs into; both are checked, this only picks the view. */
function SubscriptionSwitch({ value, onChange }: { value: UsageProviderId; onChange: (id: UsageProviderId) => void }) {
  const providers = useStore((s) => s.usage.providers)
  if (providers.length < 2) return null
  return (
    <span className="seg sm" data-tip="Which subscription these limits describe">
      {providers.map((p) => (
        <button key={p.id} className={p.id === value ? 'active' : ''} onClick={() => onChange(p.id)} data-tip={p.snapshot.error ?? `Show ${p.label}'s plan limits`}>
          {p.label}
        </button>
      ))}
    </span>
  )
}

/** How long a login still has, in the plain words used elsewhere in this panel. */
function validFor(expiresAt: number | undefined): string {
  if (!expiresAt) return 'no expiry reported'
  return expiresAt <= Date.now() ? 'expired' : `valid ${timeUntil(expiresAt)}`.replace('valid in', 'valid for')
}

/**
 * The two ChatGPT logins a GPT chat rests on. They are separate: the plan limits above are read
 * with the one the Codex CLI stores, while the chats themselves talk to the local bridge, which
 * keeps a login of its own. The app renews the first by itself; the second renews itself and can
 * only be repaired by its own sign-in, so each row carries the action that belongs to it.
 */
function ChatGptLogins() {
  const login = useStore((s) => s.usage.chatgpt)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<'codex' | 'bridge' | null>(null)
  useTick(10_000)
  if (!login) return null
  const { codex, bridge } = login
  const renew = (): void => {
    setBusy('codex')
    setNote(null)
    void window.api.usage
      .renewChatGpt()
      .then(() => setNote('The Codex login was renewed.'))
      .catch((err: Error) => setNote(err.message))
      .finally(() => setBusy(null))
  }
  const signIn = (): void => {
    setBusy('bridge')
    setNote(null)
    void window.api.usage
      .signInBridge()
      .then((r) => setNote(r.message))
      .catch((err: Error) => setNote(err.message))
      .finally(() => setBusy(null))
  }
  const stale = (at: number | undefined): boolean => !!at && at - Date.now() < 60 * 60_000
  return (
    <div className="logins">
      <div className="logins-head">
        <KeyRound size={12} />
        <b>ChatGPT logins</b>
        <span className="faint">the limits and the chats use different ones</span>
      </div>
      <div className={`login-row ${codex.error || stale(codex.expiresAt) ? 'attention' : ''}`}>
        <span className="l-name">
          Codex login <span className="faint">— what the limits above are read with, and what the Codex CLI uses</span>
        </span>
        <span className="l-state">
          {codex.present ? validFor(codex.expiresAt) : 'none stored'}
          {codex.lastRefresh ? ` · renewed ${relativeTime(codex.lastRefresh)}` : ''}
          {codex.renewing ? ' · renewing…' : ''}
          {codex.error ? ` · ${codex.error}` : ''}
        </span>
        <button className="btn sm" onClick={renew} disabled={busy !== null || codex.renewing || !codex.present} data-tip="Renew this login now. The app also does it by itself a day before it would expire, and again if ChatGPT refuses it.">
          <RefreshCw size={11} className={busy === 'codex' || codex.renewing ? 'spin' : ''} /> Renew now
        </button>
      </div>
      <div className={`login-row ${bridge.error || stale(bridge.expiresAt) ? 'attention' : ''}`}>
        <span className="l-name">
          GPT bridge <span className="faint">— its own login, which the GPT chats themselves talk through</span>
        </span>
        <span className="l-state">
          {bridge.error ? bridge.error : validFor(bridge.expiresAt)}
          {bridge.storage && !bridge.error ? ` · kept in the ${bridge.storage}` : ''}
          {bridge.signingIn ? ' · signing in…' : ''}
        </span>
        <button className="btn sm" onClick={signIn} disabled={busy !== null || bridge.signingIn} data-tip="Sign the bridge in again in the browser. It renews itself while it runs; this is for when it no longer can.">
          Sign in…
        </button>
      </div>
      {note && <div className="l-note faint">{note}</div>}
    </div>
  )
}

/**
 * The full breakdown. Rendered in the popover and in Settings → Usage; the settings dialog passes
 * its draft through the optional props so the switch there is saved with the rest of the page.
 */
export function UsageDetails({
  subscription,
  onSelect,
  showSwitch = true
}: {
  subscription?: UsageProviderId
  onSelect?: (id: UsageProviderId) => void
  /** Settings has its own labelled control for the same setting, so the header one is left out there. */
  showSwitch?: boolean
} = {}) {
  const selected = useSubscription()
  const id = subscription ?? selected.id
  const setSettings = useStore((s) => s.setSettings)
  const usage = useStore((s) => s.usage).providers.find((p) => p.id === id)?.snapshot ?? NO_SNAPSHOT
  const label = useStore((s) => s.usage).providers.find((p) => p.id === id)?.label ?? 'Plan'
  const warn = useStore((s) => s.settings?.usageWarnPercent ?? 50)
  const signedOut = useStore((s) => s.auth.status === 'signed-out')
  const setDialog = useStore((s) => s.setDialog)
  const pick = onSelect ?? ((next: UsageProviderId) => void setSettings({ usageSubscription: next }))
  useTick(10_000)
  return (
    <div className="usage-details">
      <div className="pop-head">
        <Gauge size={14} />
        <b>Plan usage limits</b>
        {showSwitch && <SubscriptionSwitch value={id} onChange={pick} />}
        <span className="spacer" />
        <button className="btn sm" onClick={() => void window.api.usage.refresh()} disabled={usage.checking}>
          <RefreshCw size={12} className={usage.checking ? 'spin' : ''} /> Check now
        </button>
      </div>
      {usage.error && (
        <div className="msg-system warning">
          <AlertTriangle size={14} />
          <div className="body">{usage.error}</div>
          {signedOut && id === 'claude' && (
            <button className="btn sm primary" onClick={() => setDialog('sign-in')} data-tip="Runs claude auth login, the same as in a terminal">
              Sign in…
            </button>
          )}
        </div>
      )}
      {id === 'codex' && <ChatGptLogins />}
      {usage.windows.length === 0 && !usage.error && <div className="faint">No limit information yet. Limits appear after the first check or the first API response.</div>}
      {usage.windows.length > 0 && <ScaleLegend warn={warn} />}
      {usage.windows.map((w) => (
        <div key={w.key} className={`usage-row sev-${w.severity}`}>
          <div className="u-row-head">
            <span className="u-name">
              {w.label}
              {w.isActive ? <span className="pill green" style={{ marginLeft: 6 }}>active</span> : null}
            </span>
            <span className="u-val">{formatPercent(w.percent)}</span>
          </div>
          <div className="u-sub">
            {w.resetsAt ? `resets ${timeUntil(w.resetsAt)} · ${formatDateTime(w.resetsAt)}` : 'no reset time reported'}
            {w.detail ? ` · ${w.detail}` : ''}
            {w.severity === 'locked' ? ' · limit reached' : w.severity === 'critical' ? ' · almost exhausted' : w.severity === 'warning' ? ' · above warning threshold' : ''}
            {w.updatedAt && w.updatedAt !== usage.fetchedAt ? ` · updated ${relativeTime(w.updatedAt)}` : ''}
          </div>
        </div>
      ))}
      <div className="u-footer faint">
        {label}
        {usage.subscription ? ` (${usage.subscription})` : ''} · last check: {usage.fetchedAt ? `${formatDateTime(usage.fetchedAt)} (${relativeTime(usage.fetchedAt)})` : 'never'}
        {usage.nextCheckAt ? ` · next ${timeUntil(usage.nextCheckAt)}` : ''}
        <br />
        Source: {SOURCE_LABEL[id][usage.source] ?? usage.source}.
        {id === 'claude' ? ' Limits also update from the rate-limit headers of every API response.' : ' ChatGPT’s plan covers the models reached through Codex.'}
      </div>
    </div>
  )
}
