import React, { useMemo } from 'react'
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
 * emptied every file link this file creates. Our own protocol is let through; everything else is
 * still checked the way react-markdown checks it.
 */
function urlTransform(url: string): string {
  return url.startsWith(FILE_PROTO) ? url : defaultUrlTransform(url)
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

export function Markdown({ text }: { text: string }) {
  const ctx = useChatCtx()
  const toast = useStore((s) => s.toast)
  const components = useMemo<Components>(
    () => ({
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
    [ctx, toast]
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
