import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import type { ImageAttachment, SessionLiveState, SlashCommandView } from '@shared/types'
import { useStore } from '@/store'

interface Props {
  sessionId: string
  live: SessionLiveState | undefined
  onSend: (text: string, images: ImageAttachment[]) => void
  onInterrupt: () => void
}

export function Composer({ sessionId, live, onSend, onInterrupt }: Props) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [commands, setCommands] = useState<SlashCommandView[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const focusNonce = useStore((s) => s.composerFocusNonce)
  const sendWithEnter = useStore((s) => s.settings?.sendWithEnter ?? true)
  const restore = useStore((s) => s.composerRestore[sessionId])
  const messages = useStore((s) => s.messages[sessionId])
  const sentQueue = useStore((s) => s.sentQueue[sessionId])
  const busy = live?.status === 'running' || live?.status === 'requires_action' || live?.status === 'starting'

  // ↑ / ↓ walk through the prompts you already typed in this chat (oldest last), like a shell
  // history. Prompts that were sent but not answered yet are included, so nothing is lost.
  const history = useMemo(() => {
    const list: string[] = []
    for (const m of messages ?? []) if (m.kind === 'user' && !m.synthetic && m.text.trim()) list.push(m.text)
    for (const q of sentQueue ?? []) if (q.text.trim() && list[list.length - 1] !== q.text) list.push(q.text)
    return list
  }, [messages, sentQueue])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const draftBeforeHistory = useRef('')
  const recall = (index: number) => {
    setHistoryIndex(index)
    setText(index < 0 ? draftBeforeHistory.current : history[index])
    setTimeout(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    }, 0)
  }

  // Prompts of an interrupted turn come back into the box (see store.interruptSession).
  useEffect(() => {
    if (!restore) return
    setText((t) => (t.trim() ? `${t}\n\n${restore.text}` : restore.text))
    if (restore.images.length) setImages((imgs) => [...imgs, ...restore.images])
    setTimeout(() => ref.current?.focus(), 0)
  }, [restore?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ref.current?.focus()
  }, [sessionId, focusNonce])

  // Restore draft per session
  useEffect(() => {
    setText(localStorage.getItem(`draft:${sessionId}`) ?? '')
    setImages([])
  }, [sessionId])
  useEffect(() => {
    if (text) localStorage.setItem(`draft:${sessionId}`, text)
    else localStorage.removeItem(`draft:${sessionId}`)
  }, [text, sessionId])

  // auto-grow
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 320) + 'px'
  }, [text])

  const slashActive = text.startsWith('/') && !text.includes('\n') && !text.includes(' ')
  useEffect(() => {
    if (!slashActive) return
    if (live?.slashCommands?.length) setCommands(live.slashCommands)
    else window.api.sessions.commands(sessionId).then(setCommands).catch(() => setCommands([]))
  }, [slashActive, sessionId, live?.slashCommands])

  const filtered = useMemo(() => {
    if (!slashActive) return []
    const q = text.slice(1).toLowerCase()
    const builtin: SlashCommandView[] = [
      { name: 'compact', description: 'Compact the conversation context', argumentHint: '[instructions]' },
      { name: 'clear', description: 'Start a fresh conversation in this session', argumentHint: '' },
      { name: 'context', description: 'Show context window usage', argumentHint: '' },
      { name: 'cost', description: 'Show token usage and cost', argumentHint: '' },
      { name: 'usage', description: 'Show plan usage limits', argumentHint: '' }
    ]
    const names = new Set(commands.map((c) => c.name))
    const all = [...commands, ...builtin.filter((b) => !names.has(b.name))]
    return all
      .map((c) => ({ c, rank: rankCommand(c, q) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
      .map((x) => x.c)
      .slice(0, 40)
  }, [slashActive, text, commands])
  useEffect(() => setSlashIndex(0), [text])

  const submit = useCallback(() => {
    const t = text.trim()
    if (!t && !images.length) return
    onSend(t, images)
    setText('')
    setImages([])
    setHistoryIndex(-1)
    draftBeforeHistory.current = ''
    localStorage.removeItem(`draft:${sessionId}`)
  }, [text, images, onSend, sessionId])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashActive && filtered.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % filtered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + filtered.length) % filtered.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && filtered[slashIndex] && '/' + filtered[slashIndex].name !== text)) {
        e.preventDefault()
        const c = filtered[slashIndex]
        setText('/' + c.name + (c.argumentHint ? ' ' : ''))
        return
      }
    }
    const el = e.currentTarget
    const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0
    if (e.key === 'ArrowUp' && history.length && (!text || caretAtStart) && !e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      if (historyIndex < 0) draftBeforeHistory.current = text
      recall(historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1))
      return
    }
    if (e.key === 'ArrowDown' && historyIndex >= 0 && !e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const next = historyIndex + 1
      recall(next >= history.length ? -1 : next)
      return
    }
    if (e.key === 'Enter') {
      const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      if ((sendWithEnter && plain) || e.metaKey || e.ctrlKey) {
        e.preventDefault()
        submit()
      }
    }
  }

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/')) {
        const data = await fileToBase64(f)
        setImages((imgs) => [...imgs, { mediaType: f.type, data, name: f.name }])
      } else {
        const p = (f as File & { path?: string }).path
        if (p) setText((t) => (t ? t + ' ' : '') + p)
      }
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.files
    if (items.length) {
      e.preventDefault()
      void addFiles(items)
    }
  }

  const pickImages = async () => {
    const paths = await window.api.dialog.chooseFiles()
    for (const p of paths) {
      const data = await window.api.fs.readImageBase64(p)
      const ext = p.split('.').pop()?.toLowerCase() ?? 'png'
      const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
      setImages((imgs) => [...imgs, { mediaType, data, name: p.split('/').pop() }])
    }
  }

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files) }}>
      {slashActive && filtered.length > 0 && (
        <div className="slash-menu">
          {filtered.map((c, i) => (
            <div key={c.name} className={`slash-item ${i === slashIndex ? 'active' : ''}`} data-tip={c.description} onMouseDown={(e) => { e.preventDefault(); setText('/' + c.name + (c.argumentHint ? ' ' : '')); ref.current?.focus() }}>
              <span className="sname">/{c.name}</span>
              <span className="sdesc">{c.description}</span>
              {c.argumentHint && <span className="faint mono" style={{ fontSize: 11 }}>{c.argumentHint}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="composer-inner">
        {(text || images.length > 0) && (
          <button
            className="composer-clear no-drag"
            data-tip="Clear the input box (text and attachments)"
            onClick={() => {
              setText('')
              setImages([])
              localStorage.removeItem(`draft:${sessionId}`)
              ref.current?.focus()
            }}
          >
            <X size={13} />
          </button>
        )}
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, k) => (
              <div className="attachment" key={k}>
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                <button data-tip="Remove this image" onClick={() => setImages((imgs) => imgs.filter((_, i) => i !== k))}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={busy ? 'Queue a message… (sent after the current turn)' : 'Message Claude…  ( / for commands, ↑ for an earlier prompt, drop files or paste images )'}
          onChange={(e) => {
            setText(e.target.value)
            if (historyIndex >= 0) setHistoryIndex(-1)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellCheck
        />
        <div className="composer-row">
          <button className="btn ghost icon" data-tip="Attach images (you can also paste or drop them here)" onClick={pickImages}>
            <ImagePlus size={15} />
          </button>
          <span className="composer-hint">
            {sendWithEnter ? '⏎ send · ⇧⏎ newline' : '⌘⏎ send'}
            {history.length > 0 ? ' · ↑ earlier prompt' : ''}
            {live?.queuedCount ? ` · ${live.queuedCount} queued` : ''}
          </span>
          <span className="spacer" />
          {busy && (
            <button className="btn danger sm" onClick={onInterrupt} data-tip="Stop the current turn (⌘.). The prompt you sent goes back into this box so you can edit and resend it.">
              <Square size={12} /> Stop
            </button>
          )}
          <button className="btn primary sm" onClick={submit} disabled={!text.trim() && !images.length} data-tip={busy ? 'Queue this message; it is sent when the current turn ends' : 'Send the message'}>
            <ArrowUp size={14} /> {busy ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Ranking for the slash-command menu: exact name, then name prefix, alias, word-start inside the
 * name, substring, and finally loose subsequence matches. "/comp" therefore lists /compact before
 * /autocompact. Lower is better; -1 = no match.
 */
export function rankCommand(c: SlashCommandView, q: string): number {
  if (!q) return 0
  const name = c.name.toLowerCase()
  const aliases = (c.aliases ?? []).map((a) => a.toLowerCase())
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if (aliases.some((a) => a === q)) return 2
  if (aliases.some((a) => a.startsWith(q))) return 3
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`[-_:/ ]${escaped}`).test(name)) return 4
  if (name.includes(q)) return 5
  if (aliases.some((a) => a.includes(q))) return 6
  let i = 0
  for (const ch of name) if (i < q.length && ch === q[i]) i += 1
  if (i === q.length) return 7
  return -1
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = reject
    r.readAsDataURL(f)
  })
}
