import React, { useEffect, useState } from 'react'
import { History, RotateCcw } from 'lucide-react'
import type { RewindPreview } from '@shared/types'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import { shortenPath } from '@/lib/format'

/**
 * Asks what a rewind should include before anything is changed: the conversation alone, or the
 * conversation together with the files Claude has changed since that prompt. The number of files
 * comes from a dry run, so the effect is known before you confirm.
 */
export function RewindDialog({ sessionId, messageId, onClose }: { sessionId: string; messageId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [error, setError] = useState('')
  const [withFiles, setWithFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const appInfo = useStore((s) => s.appInfo)
  const rewind = useStore((s) => s.rewind)

  useEffect(() => {
    let alive = true
    window.api.sessions
      .rewindPreview(sessionId, messageId)
      .then((p) => {
        if (!alive) return
        setPreview(p)
        setWithFiles(p.files.available && p.files.changed > 0)
      })
      .catch((err) => alive && setError((err as Error).message))
    return () => {
      alive = false
    }
  }, [sessionId, messageId])

  const run = async () => {
    setBusy(true)
    try {
      await rewind(sessionId, messageId, withFiles)
      onClose()
    } catch {
      setBusy(false)
    }
  }

  const files = preview?.files
  return (
    <Modal title="Rewind this chat to an earlier prompt" onClose={onClose} width={620}>
      {error && <div className="msg-system error"><div className="body">{error}</div></div>}
      {!preview && !error && <div className="faint">Checking what would change…</div>}
      {preview && (
        <>
          <div className="field">
            <label>Back to this prompt</label>
            <div className="rewind-quote">{preview.text.slice(0, 400) || '(empty prompt)'}</div>
            <div className="hint">
              Everything after it — Claude's answers and your later prompts — is removed from the chat, and this prompt
              goes back into the input box so you can change it and send it again.
            </div>
          </div>
          <div className="field">
            <label>Files</label>
            {files?.available ? (
              <label className="check">
                <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
                <span>
                  Also put the files back as they were{' '}
                  <span className="faint">
                    ({files.changed} file{files.changed === 1 ? '' : 's'}
                    {files.insertions || files.deletions ? `, +${files.insertions} / −${files.deletions} lines` : ''})
                  </span>
                </span>
              </label>
            ) : (
              <div className="hint">{files?.reason ?? 'The files stay as they are.'}</div>
            )}
            {files?.available && files.paths.length > 0 && (
              <div className="rewind-files">
                {files.paths.slice(0, 12).map((p) => (
                  <div key={p} className="mono">{shortenPath(p, appInfo?.homeDir)}</div>
                ))}
                {files.paths.length > 12 && <div className="faint">and {files.paths.length - 12} more…</div>}
              </div>
            )}
          </div>
          {!preview.canRewind && <div className="msg-system warning"><div className="body">{preview.reason}</div></div>}
          <div className="actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className={`btn ${withFiles ? 'danger' : 'primary'}`} disabled={!preview.canRewind || busy} onClick={run} data-tip={withFiles ? 'Files are written back on disk; this cannot be undone' : 'Only the conversation is cut back; files stay as they are'}>
              {withFiles ? <RotateCcw size={14} /> : <History size={14} />} {busy ? 'Rewinding…' : withFiles ? 'Rewind chat and files' : 'Rewind the chat'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
