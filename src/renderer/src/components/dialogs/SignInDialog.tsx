import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useStore } from '@/store'

/**
 * Signing Claude Code in again without a terminal. It runs `claude auth login`, which opens the
 * browser on Claude's sign-in page; usually the page hands the login back by itself and this window
 * closes. When the page shows a code instead, the code is pasted here.
 */
export function SignInDialog({ onClose }: { onClose: () => void }) {
  const signIn = useStore((s) => s.auth.signIn)
  const toast = useStore((s) => s.toast)
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const active = useRef(false)
  const phase = signIn?.phase ?? 'starting'
  const running = phase === 'starting' || phase === 'waiting'

  const start = () => {
    active.current = true
    setSent(false)
    setCode('')
    // Forget how an earlier sign-in ended, so its "done" cannot close this one.
    useStore.setState((s) => ({ auth: { ...s.auth, signIn: { phase: 'starting' } } }))
    window.api.auth.signIn().catch((err) => {
      useStore.setState((s) => ({ auth: { ...s.auth, signIn: { phase: 'failed', message: (err as Error).message } } }))
    })
  }
  useEffect(() => {
    start()
  }, [])

  useEffect(() => {
    if (phase !== 'done' || !active.current) return
    active.current = false
    toast('Claude Code is signed in again. The chats continue with your next message.', 'success')
    onClose()
  }, [phase, onClose, toast])

  const close = () => {
    if (running) void window.api.auth.cancelSignIn()
    active.current = false
    onClose()
  }
  const submit = () => {
    if (!code.trim()) return
    void window.api.auth.submitCode(code.trim())
    setSent(true)
  }

  return (
    <Modal title="Sign Claude Code in again" onClose={close} width={580}>
      <div className="signin">
        {phase === 'starting' && (
          <p>
            Starting <span className="mono">claude auth login</span>…
          </p>
        )}
        {phase === 'waiting' && (
          <>
            <p>Your browser has opened Claude's sign-in page. Sign in there with the account you use for Claude Code; this window closes by itself once Claude Code has its login back.</p>
            {signIn?.url && (
              <p>
                <button className="btn sm" onClick={() => void window.api.shell.openExternal(signIn.url!)} data-tip="For when the browser did not open, or the tab was closed">
                  <ExternalLink size={12} /> Open the sign-in page again
                </button>
              </p>
            )}
            <div className="field">
              <label>If the page shows a code instead of returning here by itself, paste the whole code</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
                <button className="btn primary" disabled={!code.trim()} onClick={submit}>
                  Submit code
                </button>
              </div>
              {sent && <span className="hint">Code handed over; waiting for Claude Code to finish signing in…</span>}
            </div>
          </>
        )}
        {phase === 'failed' && (
          <div className="msg-system error">
            <AlertTriangle size={14} />
            <div className="body">Signing in did not work: {signIn?.message}</div>
          </div>
        )}
        {phase === 'cancelled' && <p className="faint">Signing in was cancelled.</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          {(phase === 'failed' || phase === 'cancelled') && (
            <button className="btn primary" onClick={start}>
              Try again
            </button>
          )}
          <button className="btn" onClick={close}>
            {running ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
