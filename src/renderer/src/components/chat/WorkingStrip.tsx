import React, { useEffect, useState } from 'react'
import type { SessionLiveState } from '@shared/types'
import { formatDuration } from '@/lib/format'
import { StateMark } from '../common/StateMark'

/**
 * The last row of the chat while a turn is running: the running dots, what Claude is doing right
 * now (generating, compacting, or the tool it is running), and how long it has been at it —
 * measured from your last prompt, which is why the tooltip says so. It sits in the message list,
 * directly under the answer being written, rather than in a band of its own above the composer.
 */
export function WorkingStrip({ live, since }: { live: SessionLiveState | undefined; since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const starting = live?.status === 'starting'
  const tool = live?.activeTools?.length ? live.activeTools[live.activeTools.length - 1] : undefined
  const what = starting ? 'starting the process' : live?.activity === 'compacting' ? 'compacting the context' : live?.activity === 'requesting' ? 'waiting for the model' : tool ? `running ${tool.toolName}` : 'generating'
  // Under a second there is nothing worth reading, and "122ms" next to the status looks like noise.
  const elapsedMs = since ? Math.max(0, now - since) : 0
  const elapsed = elapsedMs >= 1000 ? formatDuration(elapsedMs) : ''

  return (
    <div className="working-strip" data-tip={`This chat is working: ${what}${elapsed ? `, ${elapsed} since your last prompt` : ''}. ⌘. stops the turn.`}>
      <StateMark state="working" />
      <span className="ws-what">{what}</span>
      {tool && tool.elapsedSeconds > 0 && <span className="ws-tool">{tool.elapsedSeconds}s on this tool</span>}
      {elapsed && <span className="ws-time">{elapsed}</span>}
    </div>
  )
}
