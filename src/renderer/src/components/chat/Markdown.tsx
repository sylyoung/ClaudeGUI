import React, { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '../common/CodeBlock'
import { useChatCtx } from './ChatContext'
import { findPaths, isProbablyPath, splitLine } from '@/lib/paths'

const FILE_PROTO = 'claudegui-file://'

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
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const h = href ?? ''
        if (h.startsWith(FILE_PROTO)) {
          const raw = decodeURIComponent(h.slice(FILE_PROTO.length))
          const { path, line } = splitLine(raw)
          return (
            <span
              className="file-link"
              onClick={(e) => ctx?.openPath(path, line, { inEditor: e.metaKey || e.altKey })}
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
              if (h) window.api.shell.openExternal(h)
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
    [ctx]
  )
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkFilePaths]} components={components}>
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
