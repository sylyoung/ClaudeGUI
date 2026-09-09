import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Keyboard, Square, X } from 'lucide-react'
import type { ImageAttachment, SessionLiveState, SlashCommandView } from '@shared/types'
import { useStore } from '@/store'
import { isComposing } from '@/lib/keys'

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
  /** The "/word" the caret sits in, anywhere in the text — not only at the start of the box. */
  const [slash, setSlash] = useState<SlashToken | null>(null)
  /** Start of a token whose menu you closed with Escape, so it stays closed while you type in it. */
  const dismissedStart = useRef<number | null>(null)
  /** Set while the box holds text you recalled rather than typed: no command menu until you edit. */
  const noMenu = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const focusNonce = useStore((s) => s.composerFocusNonce)
  const sendWithEnter = useStore((s) => s.settings?.sendWithEnter ?? true)
  const restore = useStore((s) => s.composerRestore[sessionId])
  const messages = useStore((s) => s.messages[sessionId])
  const sentQueue = useStore((s) => s.sentQueue[sessionId])
  const busy = live?.status === 'running' || live?.status === 'requires_action' || live?.status === 'starting'

  // ↑ / ↓ walk through the prompts you already typed in this chat (newest last), like a shell
  // history. Prompts that were sent but not answered yet are included, so nothing is lost.
  const history = useMemo(() => {
    const waiting = new Set(live?.queuedIds ?? [])
    const list: HistoryEntry[] = []
    const ids = new Set<string>()
    const texts = new Set<string>()
    for (const m of messages ?? []) {
      if (m.kind !== 'user' || m.synthetic || !m.text.trim()) continue
      ids.add(m.id)
      texts.add(m.text)
      list.push({ text: m.text, id: m.id, queued: waiting.has(m.id), at: m.ts })
    }
    // Prompts we have just sent but not seen come back from the chat yet — added only when the
    // chat does not hold them already, so the same prompt never appears twice in the walk. They
    // are the newest thing typed, hence the largest time.
    for (const q of sentQueue ?? []) {
      if (!q.text.trim() || (q.id ? ids.has(q.id) : texts.has(q.text))) continue
      if (q.id) ids.add(q.id)
      texts.add(q.text)
      list.push({ text: q.text, id: q.id, queued: q.id ? waiting.has(q.id) : false, at: Number.MAX_SAFE_INTEGER })
    }
    // The walk follows the order the prompts were typed in, which is no longer the order they
    // stand in in the chat: when Claude Code takes a prompt off its queue, the chat moves it down
    // to the answer it starts, so a prompt that is still waiting can end up above one typed before
    // it. Without this, ↑ would hand you the prompt already being answered instead of the waiting
    // one you meant to take back. Equal times keep the order of the chat.
    return list.sort((a, b) => a.at - b.at)
  }, [messages, sentQueue, live?.queuedIds])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const draftBeforeHistory = useRef('')
  const takeBackQueued = useStore((s) => s.takeBackQueued)
  const toast = useStore((s) => s.toast)
  const setDialog = useStore((s) => s.setDialog)
  const recall = (index: number) => {
    const entry = index < 0 ? null : history[index]
    setHistoryIndex(index)
    setText(entry ? entry.text : draftBeforeHistory.current)
    // The recalled text was not typed here, so the command menu must not pop up over it (it would
    // swallow the next ↑) until you edit it or move the caret yourself.
    noMenu.current = true
    setSlash(null)
    setTimeout(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    }, 0)
    // A prompt that is still waiting is taken back out of the queue when you pull it in here, so it
    // is not answered behind your back while you edit it.
    if (entry?.queued && entry.id) {
      void takeBackQueued(sessionId, entry.id).then((ok) => {
        if (!ok) return
        toast('That prompt was taken back out of the queue; it is in the input box.', 'success')
        // It has left the chat and the queue, so it is no longer a step of the walk: the walk ends
        // here and the text becomes the draft, which ↓ brings back if you walk further up.
        setHistoryIndex(-1)
        draftBeforeHistory.current = entry.text
      })
    }
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

  const syncSlash = (el: HTMLTextAreaElement) => {
    if (noMenu.current) return
    const token = slashTokenAt(el.value, el.selectionStart ?? 0)
    if (!token) {
      dismissedStart.current = null
      setSlash(null)
      return
    }
    setSlash(token.start === dismissedStart.current ? null : token)
  }
  const slashActive = slash !== null
  useEffect(() => {
    if (!slashActive) return
    if (live?.slashCommands?.length) setCommands(live.slashCommands)
    else window.api.sessions.commands(sessionId).then(setCommands).catch(() => setCommands([]))
  }, [slashActive, sessionId, live?.slashCommands])

  const filtered = useMemo(() => {
    if (!slash) return []
    const q = slash.query.toLowerCase()
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
  }, [slash, commands])
  useEffect(() => setSlashIndex(0), [text])

  /** Put the chosen command in place of the "/word" the caret is in, leaving the rest untouched. */
  const applyCommand = (c: SlashCommandView) => {
    const el = ref.current
    if (!el || !slash) return
    const end = el.selectionEnd ?? text.length
    const tail = text.slice(end)
    // A command that takes arguments is followed by one space — but not a second one when the
    // sentence already continues with a space.
    const insert = '/' + c.name + (c.argumentHint && !tail.startsWith(' ') ? ' ' : '')
    const next = text.slice(0, slash.start) + insert + tail
    const caret = slash.start + c.name.length + 1 + (c.argumentHint ? 1 : 0)
    setText(next)
    setSlash(null)
    dismissedStart.current = null
    setTimeout(() => {
      const box = ref.current
      if (!box) return
      box.focus()
      box.selectionStart = box.selectionEnd = caret
    }, 0)
  }

  const submit = useCallback(() => {
    const t = text.trim()
    if (!t && !images.length) return
    onSend(t, images)
    setText('')
    setSlash(null)
    noMenu.current = false
    setImages([])
    setHistoryIndex(-1)
    draftBeforeHistory.current = ''
    localStorage.removeItem(`draft:${sessionId}`)
  }, [text, images, onSend, sessionId])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // A key the input method is using to build a character (pinyin candidates and the like) belongs
    // to the input method, not to the chat box: Enter would send half-typed pinyin.
    if (isComposing(e)) return
    const walkingHistory = historyIndex >= 0
    // While you are walking the history, ↑ and ↓ belong to the history even if the recalled prompt
    // is a command and the menu is open on it.
    const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown'
    if (slashActive && filtered.length && !(walkingHistory && arrow)) {
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
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dismissedStart.current = slash?.start ?? null
        setSlash(null)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && filtered[slashIndex] && filtered[slashIndex].name !== slash?.query)) {
        e.preventDefault()
        applyCommand(filtered[slashIndex])
        return
      }
    }
    const el = e.currentTarget
    const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0
    // Once you are walking the history, ↑ and ↓ keep walking it; typing or clicking in the box ends
    // the walk and gives the arrows back to the caret.
    const walking = walkingHistory
    if (e.key === 'ArrowUp' && history.length && (walking || !text || caretAtStart) && !e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      if (!walking) draftBeforeHistory.current = text
      recall(walking ? Math.max(0, historyIndex - 1) : history.length - 1)
      return
    }
    if (e.key === 'ArrowDown' && walking && !e.shiftKey && !e.metaKey && !e.altKey) {
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

  /**
   * A copy out of a word processor, a PDF viewer or a web page usually carries the same selection
   * twice: as text, and as a picture of the formatted text. Word on macOS even offers the picture
   * first, which is why pasting a paragraph used to land here as an image. Text is what was copied,
   * so it wins: the picture is only taken when the clipboard holds no text at all (a screenshot, an
   * image copied from a browser, a file copied in Finder).
   */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files)
    if (!files.length) return
    if (e.clipboardData.getData('text/plain').trim()) return
    e.preventDefault()
    void addFiles(files)
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
            <div key={c.name} className={`slash-item ${i === slashIndex ? 'active' : ''}`} data-tip={c.description} onMouseDown={(e) => { e.preventDefault(); applyCommand(c) }}>
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
            noMenu.current = false
            setText(e.target.value)
            syncSlash(e.target)
            if (historyIndex >= 0) setHistoryIndex(-1)
          }}
          onKeyDown={onKeyDown}
          onMouseDown={() => {
            noMenu.current = false
            if (historyIndex >= 0) setHistoryIndex(-1)
          }}
          onSelect={(e) => syncSlash(e.currentTarget)}
          onKeyUp={(e) => syncSlash(e.currentTarget)}
          onClick={(e) => syncSlash(e.currentTarget)}
          onPaste={onPaste}
          spellCheck
        />
        <div className="composer-row">
          <button className="btn ghost icon" data-tip="Attach images (you can also paste or drop them here)" onClick={pickImages}>
            <ImagePlus size={15} />
          </button>
          <button className="btn ghost icon" data-tip="All keyboard shortcuts (⌘/)" onClick={() => setDialog('shortcuts')}>
            <Keyboard size={15} />
          </button>
          <span className="composer-hint">
            {sendWithEnter ? '⏎ send · ⇧⏎ newline' : '⌘⏎ send'}
            {history.length > 0 ? ' · ↑ earlier prompt' : ''}
            {' · esc esc rewind'}
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

/** One step of the prompt history: what you typed, when, and whether it is still waiting in the queue. */
interface HistoryEntry {
  text: string
  id?: string
  queued?: boolean
  /** When the prompt was sent; the walk is in this order, not in the order of the chat. */
  at: number
}

export interface SlashToken {
  /** Index of the "/" in the text. */
  start: number
  /** What was typed after it, up to the caret. */
  query: string
}

/**
 * The "/command" word the caret is inside, wherever it is in the message — the menu is no longer
 * limited to a message that begins with "/". A slash right after a non-space character belongs to a
 * path such as `src/lib` or a date such as `12/3`, so it does not open the menu, and a space or a
 * line break ends the word.
 */
export function slashTokenAt(value: string, caret: number): SlashToken | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i]
    if (/\s/.test(ch)) return null
    if (ch === '/') {
      if (i > 0 && !/\s/.test(value[i - 1])) return null
      return { start: i, query: value.slice(i + 1, caret) }
    }
  }
  return null
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
