import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '../common/CodeBlock'
import { useChatCtx } from './ChatContext'
import { findPaths, isProbablyPath, splitLine } from '@/lib/paths'
import { useStore } from '@/store'

const FILE_PROTO = 'claudegui-file://'

/**
 * A URL scheme, as in `https:`, `mailto:` or `file:`. Anything without one is a path: models write
 * `[the proposal](/Users/me/proposal.docx)` and `[the notes](notes/plan.md)` constantly, and those
 * are links to files, not addresses to hand to a browser.
 */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * react-markdown drops the address of any link whose protocol it does not know, which silently
 * emptied every file link this file creates. Our own protocol is let through, and so is `file:` for
 * a picture, which is read from disk by MarkdownPicture; everything else is still checked the way
 * react-markdown checks it.
 */
function urlTransform(url: string, key: string): string {
  if (url.startsWith(FILE_PROTO)) return url
  if (key === 'src' && /^file:/i.test(url)) return url
  return defaultUrlTransform(url)
}

/** The files `![…](…)` can show; any other file named that way is shown as a link to it. */
const PICTURE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i

/** The path a picture's address names: `file://` taken off, and `%20` and the like read back. */
function picturePath(src: string): string {
  const p = src.replace(/^file:\/\//i, '')
  if (!/%[0-9a-f]{2}/i.test(p)) return p
  try {
    return decodeURI(p)
  } catch {
    return p
  }
}

/**
 * A picture written into a reply as `![what](path)`. Left to the browser, a path is read against
 * the window's own address rather than the chat's folder, so it showed as a broken picture; it is
 * found the way a file link is (against the chat's folder, or the folder of the Markdown file being
 * previewed) and read from disk. A click opens it in the viewer.
 */
function MarkdownPicture({ src, alt, baseDir }: { src: string; alt: string; baseDir?: string }) {
  const ctx = useChatCtx()
  const toast = useStore((s) => s.toast)
  const written = picturePath(src)
  const dir = ctx?.cwd ?? baseDir
  const [shown, setShown] = useState<{ path: string; url?: string; problem?: string } | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  // Whether the chat was at its end when the picture arrived: the picture then keeps it there.
  const atEnd = useRef(false)

  useEffect(() => {
    if (!dir && !written.startsWith('/')) return
    let live = true
    void (async () => {
      const path = await window.api.fs.locate(written, dir ?? '/')
      const content = await window.api.fs.read(path)
      if (!live) return
      const scroller = box.current?.closest('.messages')
      atEnd.current = Boolean(scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80)
      if (content.kind === 'image') setShown({ path, url: `data:${content.mimeType};base64,${content.base64}` })
      else if (content.kind === 'missing') setShown({ path, problem: 'not found' })
      else if (content.kind === 'too-large') setShown({ path, problem: 'too large to show here' })
      else setShown({ path, problem: 'not a picture' })
    })().catch((err: Error) => live && setShown({ path: written, problem: err.message }))
    return () => {
      live = false
    }
  }, [written, dir])

  const label = alt || written.split('/').pop() || written
  if (!dir && !written.startsWith('/')) return <span data-tip={written}>{label}</span>
  const open = (e: React.MouseEvent) => {
    if (ctx) ctx.openPath(written, undefined, { inEditor: e.metaKey || e.altKey })
    else if (shown) void window.api.shell.openPath(shown.path).then((err) => err && toast(err, 'error'))
  }
  const menu = (e: React.MouseEvent) => {
    if (!ctx) return
    e.preventDefault()
    ctx.showPathMenu(written, undefined, e.clientX, e.clientY)
  }
  return (
    <span className="md-picture" ref={box}>
      {shown?.url ? (
        <img
          src={shown.url}
          alt={alt}
          onClick={open}
          onContextMenu={menu}
          onLoad={() => {
            const scroller = box.current?.closest('.messages')
            if (atEnd.current && scroller) scroller.scrollTop = scroller.scrollHeight
          }}
          data-tip={`${shown.path}\nClick to open · right-click for options`}
        />
      ) : shown?.problem ? (
        <span className="file-link" onClick={open} onContextMenu={menu} data-tip={shown.path}>
          {label} (picture {shown.problem})
        </span>
      ) : null}
    </span>
  )
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] }

/** remark plugin: turn file paths in plain text into links so they become clickable. */
function remarkFilePaths() {
  return (tree: MdNode) => {
    const walk = (node: MdNode, inLink: boolean) => {
      if (!node.children) return
      const next: MdNode[] = []
      for (const child of node.children) {
        if (child.type === 'text' && !inLink && child.value && child.value.includes('/')) {
          const matches = findPaths(child.value)
          if (!matches.length) {
            next.push(child)
            continue
          }
          let cursor = 0
          for (const m of matches) {
            if (m.start > cursor) next.push({ type: 'text', value: child.value.slice(cursor, m.start) })
            next.push({ type: 'link', url: FILE_PROTO + encodeURIComponent(m.raw), children: [{ type: 'text', value: m.raw }] })
            cursor = m.end
          }
          if (cursor < child.value.length) next.push({ type: 'text', value: child.value.slice(cursor) })
        } else {
          walk(child, inLink || child.type === 'link' || child.type === 'linkReference')
          next.push(child)
        }
      }
      node.children = next
    }
    walk(tree, false)
  }
}

/** `baseDir`: where a relative path in the text starts when there is no chat around it — the folder of a Markdown file being previewed. */
export function Markdown({ text, baseDir }: { text: string; baseDir?: string }) {
  const ctx = useChatCtx()
  const toast = useStore((s) => s.toast)
  const components = useMemo<Components>(
    () => ({
      img: ({ src, alt }) => {
        const s = typeof src === 'string' ? src : ''
        if (!s) return alt ? <span>{alt}</span> : null
        if (SCHEME.test(s) && !/^file:/i.test(s)) {
          // The window loads nothing from the internet: a picture there is offered as a link.
          return (
            <a
              href={s}
              onClick={(e) => {
                e.preventDefault()
                void window.api.shell.openExternal(s).catch((err) => toast(`Could not open ${s}: ${(err as Error).message}`, 'error'))
              }}
              data-tip={s}
            >
              {alt || s}
            </a>
          )
        }
        const path = picturePath(s)
        if (!PICTURE.test(path)) {
          if (!ctx) return <span data-tip={path}>{alt || path}</span>
          return (
            <span className="file-link" onClick={(e) => ctx.openPath(path, undefined, { inEditor: e.metaKey || e.altKey })} data-tip={path}>
              {alt || path}
            </span>
          )
        }
        return <MarkdownPicture src={s} alt={alt ?? ''} baseDir={baseDir} />
      },
      a: ({ href, children }) => {
        const h = href ?? ''
        // The links this file makes itself carry our own protocol; a markdown link that names a
        // file carries none. `#…` is a link inside the document, not a file.
        const written = h.startsWith(FILE_PROTO)
          ? decodeURIComponent(h.slice(FILE_PROTO.length))
          : h && !SCHEME.test(h) && !h.startsWith('#')
            ? h
            : null
        if (written !== null) {
          const { path, line } = splitLine(written)
          // With no chat around it — a Markdown file open in the viewer — only an absolute path can
          // be opened, so a relative one is left as plain text rather than as a link that cannot work.
          if (!ctx && !path.startsWith('/')) return <span data-tip={written}>{children}</span>
          return (
            <span
              className="file-link"
              onClick={(e) => {
                // `shell.openExternal` refuses anything without a scheme ("Invalid URL"), so a path
                // handed to it opened nothing at all, silently. Paths go the way a path in the text
                // goes: resolved against the chat's folder, then opened by the file settings.
                if (ctx) ctx.openPath(path, line, { inEditor: e.metaKey || e.altKey })
                else void window.api.shell.openPath(path).then((err) => err && toast(err, 'error'))
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                ctx?.showPathMenu(path, line, e.clientX, e.clientY)
              }}
              data-tip="Click to open · ⌘-click to open in editor · right-click for options"
            >
              {children}
            </span>
          )
        }
        return (
          <a
            href={h}
            onClick={(e) => {
              e.preventDefault()
              if (h) {
                void window.api.shell
                  .openExternal(h)
                  .catch((err) => toast(`Could not open ${h}: ${(err as Error).message}`, 'error'))
              }
            }}
            data-tip={h}
          >
            {children}
          </a>
        )
      },
      pre: ({ children }) => {
        const child = React.Children.toArray(children)[0] as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined
        const className = child?.props?.className ?? ''
        const lang = /language-([\w+-]+)/.exec(className)?.[1]
        const code = extractText(child?.props?.children)
        return <CodeBlock code={code} language={lang} />
      },
      code: ({ children, className }) => {
        const text = extractText(children)
        if (!className && ctx && isProbablyPath(text)) {
          const { path, line } = splitLine(text.trim())
          return (
            <code
              className="file-link"
              onClick={(e) => ctx.openPath(path, line, { inEditor: e.metaKey || e.altKey })}
              onContextMenu={(e) => {
                e.preventDefault()
                ctx.showPathMenu(path, line, e.clientX, e.clientY)
              }}
              data-tip="Click to open · ⌘-click to open in editor"
            >
              {text}
            </code>
          )
        }
        return <code className={className}>{children}</code>
      },
      table: ({ children }) => (
        <div className="table-wrap">
          <table>{children}</table>
        </div>
      ),
      input: ({ checked, ...rest }) => <input type="checkbox" checked={Boolean(checked)} readOnly {...(rest as object)} />
    }),
    [ctx, toast, baseDir]
  )
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkFilePaths]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (React.isValidElement(node)) return extractText((node.props as { children?: React.ReactNode }).children)
  return ''
}
