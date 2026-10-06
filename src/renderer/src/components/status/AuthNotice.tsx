import { useState } from 'react'
import { AlertTriangle, LogIn, X } from 'lucide-react'
import { useStore } from '@/store'

/** How long before Claude Code's login ends the window starts to say so. */
const WARN_BEFORE_END_MS = 3 * 24 * 60 * 60_000

function inWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000)
  if (hours < 1) return 'within the hour'
  if (hours < 36) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  return `in ${Math.round(hours / 24)} days`
}

/**
 * One line above the chat when Claude Code cannot authenticate, or soon will not: it is signed out,
 * chats failed to authenticate, or the login's end date is close. It says what happened in plain
 * words and offers signing in again from the app.
 */
export function AuthNotice() {
  const auth = useStore((s) => s.auth)
  const since = auth.statusSince ?? 0
  const failedChats = useStore((s) => Object.values(s.live).filter((l) => (l.authFailedAt ?? 0) > since).length)
  const lastFailure = useStore((s) => Math.max(0, ...Object.values(s.live).map((l) => l.authFailedAt ?? 0)))
  const setDialog = useStore((s) => s.setDialog)
  const [dismissed, setDismissed] = useState<string[]>([])

  let key = ''
  let level: 'error' | 'warning' = 'warning'
  let text = ''
  if (auth.status === 'signed-out') {
    key = 'signed-out'
    level = 'error'
    text = 'Claude Code is signed out: its login has expired, so chats cannot run. Sign in again; the chats keep their history and continue with your next message.'
  } else if (failedChats > 0 && auth.status !== 'api-key') {
    key = `failed-${lastFailure}`
    text = `${failedChats === 1 ? 'A chat' : `${failedChats} chats`} could not authenticate, although Claude Code's login is still stored. That is most likely a network problem or a renewal of the login that was in progress: send the message again, and sign in again if it fails once more.`
  } else if (auth.status === 'signed-in' && auth.loginEndsAt && auth.loginEndsAt - Date.now() < WARN_BEFORE_END_MS) {
    key = `ending-${auth.loginEndsAt}`
    const left = auth.loginEndsAt - Date.now()
    text =
      left > 0
        ? `Claude Code's login ends ${inWords(left)} (${new Date(auth.loginEndsAt).toLocaleString()}). Sign in again before then so the chats keep working.`
        : "Claude Code's login has reached its end date. If chats fail to authenticate, sign in again."
  }
  if (!key || dismissed.includes(key)) return null
  return (
    <div className={`msg-system ${level} auth-notice`}>
      <AlertTriangle size={14} />
      <div className="body">{text}</div>
      <button className="btn sm primary" onClick={() => setDialog('sign-in')} data-tip="Runs claude auth login, the same as in a terminal: your browser opens Claude's sign-in page">
        <LogIn size={12} /> Sign in…
      </button>
      {key !== 'signed-out' && (
        <button className="btn ghost icon sm" onClick={() => setDismissed((d) => [...d, key])} data-tip="Hide this notice until something changes">
          <X size={12} />
        </button>
      )}
    </div>
  )
}
