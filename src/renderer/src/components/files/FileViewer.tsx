import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Code, Ellipsis, ExternalLink, Eye, FolderOpen, Pencil, X } from 'lucide-react'
import type { FileContent } from '@shared/types'
import { useStore, type FileTab } from '@/store'
import { highlight } from '@/lib/highlight'
import { Markdown } from '../chat/Markdown'
import { basename, formatBytes } from '@/lib/format'

export function FileViewer({ sessionId }: { sessionId: string }) {
  const files = useStore((s) => s.files[sessionId])
  const setActiveFile = useStore((s) => s.setActiveFile)
  const closeFile = useStore((s) => s.closeFile)
  const open = files?.open ?? []
  const active = open.find((t) => t.path === files?.active) ?? open[open.length - 1]
  if (!open.length) return null
  return (
    <div className="viewer">
      <div className="viewer-tabs">
        {open.map((t) => (
          <div key={t.path} className={`viewer-tab ${t.path === active?.path ? 'active' : ''}`} onClick={() => setActiveFile(sessionId, t.path)} data-tip={t.path}>
            <span>{basename(t.path)}</span>
            <span className="close" onClick={(e) => { e.stopPropagation(); closeFile(sessionId, t.path) }}>
              <X size={12} />
            </span>
          </div>
        ))}
      </div>
      {active && <FileBody tab={active} />}
    </div>
  )
}

function FileBody({ tab }: { tab: FileTab }) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [preview, setPreview] = useState(true)
  const openBinaryExternally = useStore((s) => s.settings?.openBinaryWithSystemApp ?? true)
  const toast = useStore((s) => s.toast)
  const ref = useRef<HTMLDivElement>(null)
  const autoOpened = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.fs.read(tab.path).then((c) => !cancelled && setContent(c)).catch(() => !cancelled && setContent({ path: tab.path, kind: 'missing', size: 0, mtime: 0 }))
    return () => { cancelled = true }
  }, [tab.path, tab.version])

  useEffect(() => {
    if (!content || tab.line == null) return
    const el = ref.current?.querySelector(`[data-line="${tab.line}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [content, tab.line, tab.version])

  // Binary documents (docx, pdf, …) are handed to their default macOS app.
  useEffect(() => {
    if (content?.kind === 'binary' && openBinaryExternally && autoOpened.current !== tab.path) {
      autoOpened.current = tab.path
      void window.api.shell.openPath(tab.path).then((err) => err && toast(err, 'error'))
    }
  }, [content, openBinaryExternally, tab.path, toast])

  const isMarkdown = content?.language === 'markdown'
  const lines = useMemo(() => {
    if (!content || content.kind !== 'text' || (isMarkdown && preview)) return []
    const html = highlight(content.text ?? '', content.language)
    return html.split('\n')
  }, [content, isMarkdown, preview])

  const openExternal = () => window.api.shell.openPath(tab.path).then((err) => err && toast(err, 'error'))

  return (
    <>
      <div className="viewer-toolbar">
        <span className="path" data-tip={tab.path}>{tab.path}</span>
        {content && content.kind !== 'missing' && <span>{formatBytes(content.size)}</span>}
        {isMarkdown && (
          <button className="btn ghost icon" data-tip={preview ? 'Show source' : 'Preview markdown'} onClick={() => setPreview((p) => !p)}>
            {preview ? <Code size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button className="btn ghost icon" data-tip="Open with the default app" onClick={openExternal}>
          <ExternalLink size={13} />
        </button>
        <button className="btn ghost icon" data-tip="Open with…" onClick={() => window.api.shell.openWith(tab.path)}>
          <Ellipsis size={13} />
        </button>
        <button className="btn ghost icon" data-tip="Open in editor" onClick={() => window.api.shell.openInEditor(tab.path, tab.line)}>
          <Pencil size={13} />
        </button>
        <button className="btn ghost icon" data-tip="Reveal in Finder" onClick={() => window.api.shell.showInFolder(tab.path)}>
          <FolderOpen size={13} />
        </button>
      </div>
      <div className="viewer-content" ref={ref}>
        {!content && <div className="faint" style={{ padding: 12 }}>Loading…</div>}
        {content?.kind === 'missing' && <div className="faint" style={{ padding: 12 }}>File not found.</div>}
        {content?.kind === 'binary' && (
          <div className="viewer-binary">
            <div className="faint">
              {basename(tab.path)} · {formatBytes(content.size)} · not a text file
              {openBinaryExternally ? ' — opened with its default app.' : '.'}
            </div>
            <div className="row" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button data-tip="Open with the default macOS app" className="btn sm" onClick={openExternal}><ExternalLink size={12} /> Open with default app</button>
              <button className="btn sm" onClick={() => window.api.shell.openWith(tab.path)}><Ellipsis size={12} /> Open with…</button>
              <button className="btn sm" onClick={() => window.api.shell.showInFolder(tab.path)}><FolderOpen size={12} /> Reveal</button>
            </div>
          </div>
        )}
        {content?.kind === 'too-large' && (
          <div className="viewer-binary">
            <div className="faint">File too large to preview ({formatBytes(content.size)}).</div>
            <div className="row" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn sm" onClick={openExternal}><ExternalLink size={12} /> Open with default app</button>
              <button data-tip="Open this file in your editor (Settings → Files)" className="btn sm" onClick={() => window.api.shell.openInEditor(tab.path)}><Pencil size={12} /> Open in editor</button>
            </div>
          </div>
        )}
        {content?.kind === 'image' && <img src={`data:${content.mimeType};base64,${content.base64}`} alt={tab.path} />}
        {content?.kind === 'text' && isMarkdown && preview && <Markdown text={content.text ?? ''} />}
        {content?.kind === 'text' && !(isMarkdown && preview) && (
          <div className="code-view hljs" style={{ background: 'transparent', padding: '8px 0' }}>
            {lines.map((l, i) => (
              <div key={i} className={`cl ${tab.line === i + 1 ? 'hl' : ''}`} data-line={i + 1}>
                <span className="ln">{i + 1}</span>
                <span className="ct" dangerouslySetInnerHTML={{ __html: l || ' ' }} />
              </div>
            ))}
            {content.truncated && <div className="faint" style={{ padding: 8 }}>… truncated (file is {formatBytes(content.size)}; raise the limit in Settings → Files)</div>}
          </div>
        )}
      </div>
    </>
  )
}
