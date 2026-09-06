import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Square } from 'lucide-react'
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
  const busy = live?.status === 'running' || live?.status === 'requires_action' || live?.status === 'starting'

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
    return all.filter((c) => c.name.toLowerCase().includes(q) || c.aliases?.some((a) => a.toLowerCase().includes(q))).slice(0, 40)
  }, [slashActive, text, commands])
  useEffect(() => setSlashIndex(0), [text])

  const submit = useCallback(() => {
    const t = text.trim()
    if (!t && !images.length) return
    onSend(t, images)
    setText('')
    setImages([])
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
            <div key={c.name} className={`slash-item ${i === slashIndex ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); setText('/' + c.name + (c.argumentHint ? ' ' : '')); ref.current?.focus() }}>
              <span className="sname">/{c.name}</span>
              <span className="sdesc">{c.description}</span>
              {c.argumentHint && <span className="faint mono" style={{ fontSize: 11 }}>{c.argumentHint}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="composer-inner">
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, k) => (
              <div className="attachment" key={k}>
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                <button onClick={() => setImages((imgs) => imgs.filter((_, i) => i !== k))}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={busy ? 'Queue a message… (sent after the current turn)' : 'Message Claude…  ( / for commands, drop files or paste images )'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellCheck
        />
        <div className="composer-row">
          <button className="btn ghost icon" title="Attach image" onClick={pickImages}>
            <ImagePlus size={15} />
          </button>
          <span className="composer-hint">
            {sendWithEnter ? '⏎ send · ⇧⏎ newline' : '⌘⏎ send'}
            {live?.queuedCount ? ` · ${live.queuedCount} queued` : ''}
          </span>
          <span className="spacer" />
          {busy && (
            <button className="btn danger sm" onClick={onInterrupt} title="Interrupt the current turn (⌘.)">
              <Square size={12} /> Stop
            </button>
          )}
          <button className="btn primary sm" onClick={submit} disabled={!text.trim() && !images.length} title="Send">
            <ArrowUp size={14} /> {busy ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = reject
    r.readAsDataURL(f)
  })
}
