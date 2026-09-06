import React from 'react'
import { STATE_MARKER, type VisualKey } from '@/lib/sessionState'

/**
 * The visible marker of a session state: "..." while Claude works (the three dots run one after
 * the other), "!" for a permission request, red "Q" for a question, "N" for unread, and so on.
 * It replaces the coloured dot used before, which was too easy to overlook.
 */
export function StateMark({ state, small }: { state: VisualKey; small?: boolean }): React.ReactElement {
  const cls = `mark vs-${state}${small ? ' sm' : ''}`
  if (state === 'working' || state === 'starting') {
    return (
      <span className={cls}>
        <i>.</i>
        <i>.</i>
        <i>.</i>
      </span>
    )
  }
  return <span className={cls}>{STATE_MARKER[state]}</span>
}
