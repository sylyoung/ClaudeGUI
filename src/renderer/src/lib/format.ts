export function timeAgo(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 45) return 'now'
  const m = Math.max(1, Math.floor(s / 60))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Time of day for something that happened today, date + time otherwise ("Sep 5, 21:04"). */
export function formatStamp(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? formatTime(ts) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m - h * 60}m`
}

export function formatTokens(n: number | undefined): string {
  if (n == null) return '–'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCost(usd: number | undefined): string {
  if (usd == null) return '–'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export function shortenPath(p: string, home?: string): string {
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

export function modelLabel(model: string | undefined): string {
  if (!model) return 'default model'
  if (model === '<synthetic>') return 'Claude Code'
  const m = model.replace(/\[1m\]$/, ' (1M)')
  const nice: Record<string, string> = {
    'claude-fable-5-1': 'Fable 5.1',
    'claude-fable-5': 'Fable 5',
    'claude-opus-5': 'Opus 5',
    'claude-opus-4-8': 'Opus 4.8',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-haiku-4-5': 'Haiku 4.5'
  }
  const base = m.replace(/ \(1M\)$/, '')
  return (nice[base] ?? base) + (m.endsWith('(1M)') ? ' (1M)' : '')
}

/** "just now", "2m ago", "3h ago", "2d ago". */
export function relativeTime(ts: number): string {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m ago`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h ago`
}

/** "in 2h 15m", "in 3d 4h"; "now" once the moment has passed. */
export function timeUntil(ts: number | undefined): string {
  if (!ts) return ''
  const s = Math.floor((ts - Date.now()) / 1000)
  if (s <= 0) return 'now'
  const m = Math.floor(s / 60)
  if (m < 1) return `in ${s}s`
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `in ${d}d ${h % 24}h`
}

export function formatDateTime(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatPercent(p: number | null | undefined): string {
  if (p == null) return '–'
  return `${Math.round(p)}%`
}

/**
 * Model name to show for a session: the running process's model, else the one chosen for the
 * session, else the model its last process reported, else the default from Settings → Claude.
 */
export function sessionModelName(record: { model?: string; lastModel?: string }, live: { model?: string } | undefined, defaultModel: string | undefined): string {
  const id = live?.model || record.model || record.lastModel || defaultModel || ''
  return id ? modelLabel(id) : 'default'
}
