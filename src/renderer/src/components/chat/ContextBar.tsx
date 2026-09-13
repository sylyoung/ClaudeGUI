import React, { useEffect, useRef, useState } from 'react'
import { Cpu, RefreshCw, Shrink } from 'lucide-react'
import type { SessionLiveState } from '@shared/types'
import { useStore } from '@/store'
import { Popover } from '../common/Popover'
import { formatDuration, formatTokens, relativeTime } from '@/lib/format'
import { barScale, CONTEXT_COLOUR_RULE, contextLevel, contextPercent, contextWindowOf } from '@/lib/tasks'

/** Context-window usage bar for the chat toolbar; click for the /context breakdown. */
export function ContextBar({ sessionId, live }: { sessionId: string; live: SessionLiveState | undefined }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const send = useStore((s) => s.send)
  const toast = useStore((s) => s.toast)
  const pct = contextPercent(live)
  const level = contextLevel(live)
  const used = live?.contextUsage?.totalTokens ?? live?.contextTokens
  const window = contextWindowOf(live)
  const cu = live?.contextUsage
  // A compaction reports nothing at all while it runs — measured 2026-09-13: "compacting" at 0 s,
  // the same word again at 30 s (Claude Code repeating itself), and the boundary 41.8 s in, with
  // no output in between. So the bar times the wait instead of showing a percentage nobody sends;
  // the real, smaller measurement arrives with the turn's result and replaces it.
  const compacting = live?.activity === 'compacting'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!compacting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [compacting])
  const waitedMs = compacting && live?.activitySince ? Math.max(0, now - live.activitySince) : 0
  const waited = waitedMs >= 1000 ? formatDuration(waitedMs) : ''
  const before = used != null && window != null ? `${formatTokens(used)} of ${formatTokens(window)} tokens` : 'the context'
  const recount = async () => {
    setBusy(true)
    try {
      const r = await window_api().sessions.contextUsage(sessionId, true)
      if (!r) toast('Start the session first (send a message) to measure its context.', 'info')
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const title = compacting
    ? `Claude Code is compacting this chat's context — ${before}${waited ? `, ${waited} so far` : ''}.\nIt sends nothing while it works, so there is no percentage to show; the bar returns with the new measurement when the compaction finishes.`
    : pct == null
      ? 'Context usage is known once the session has answered once'
      : `Context: ${formatTokens(used)} of ${formatTokens(window)} tokens (${pct}%)\n${CONTEXT_COLOUR_RULE}`
  return (
    <>
      <button ref={ref} className={`ctx-bar level-${level} ${open ? 'open' : ''} ${compacting ? 'is-compacting' : ''}`} onClick={() => setOpen((o) => !o)} data-tip={title}>
        <Cpu size={12} />
        <span className="ctx-track">
          {compacting ? <span className="ctx-sweep" /> : <span className="ctx-fill" style={{ width: `${Math.min(100, pct ?? 0)}%` }} />}
        </span>
        <span className="ctx-text">
          {compacting ? `compacting…${waited ? ` ${waited}` : ''}` : pct == null ? 'context –' : `${formatTokens(used)} / ${formatTokens(window)} · ${pct}%`}
        </span>
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={420} align="left">
          <div className="ctx-details">
            <div className="pop-head">
              <Cpu size={14} />
              <b>Context window</b>
              <span className="spacer" />
              <button className="btn sm" onClick={recount} disabled={busy || !live?.processAlive} data-tip="Re-count every category with the token-count API">
                <RefreshCw size={12} className={busy ? 'spin' : ''} /> Recount
              </button>
              <button
                className="btn sm"
                onClick={() => void send(sessionId, '/compact')}
                disabled={!live?.processAlive || compacting}
                data-tip={compacting ? 'This chat is being compacted already' : 'Summarize the conversation to free context (/compact)'}
              >
                <Shrink size={12} /> Compact
              </button>
            </div>
            <div className={`ctx-summary level-${level}`}>
              <span className="big">{pct == null ? '–' : `${pct}%`}</span>
              <span>
                {formatTokens(used)} of {formatTokens(window)} tokens{cu?.model ? ` · ${cu.model}` : ''}
                <br />
                <span className="faint">{cu ? `measured ${relativeTime(cu.checkedAt)}` : 'estimated from the last response'}</span>
              </span>
            </div>
            {cu?.categories?.length ? (
              <div className="cat-list">
                {cu.categories
                  .filter((c) => c.tokens > 0)
                  .map((c) => (
                    <div className="cat-row" key={c.name} data-tip={`${c.name}: ${c.tokens.toLocaleString()} tokens`}>
                      <span className="cat-name">{c.name}</span>
                      <span className="cat-track">
                        <span className="cat-fill" style={{ width: `${Math.min(100, (c.tokens / barScale(cu.categories)) * 100)}%`, background: c.color || 'var(--accent)' }} />
                      </span>
                      <span className="cat-val">{formatTokens(c.tokens)}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="faint">The per-category breakdown appears once the session process is running.</div>
            )}
            <div className="u-footer faint">Claude Code compacts automatically when the window fills up; the bar turns amber above 60% and red above 85%.</div>
          </div>
        </Popover>
      )}
    </>
  )
}

function window_api() {
  return globalThis.window.api
}
