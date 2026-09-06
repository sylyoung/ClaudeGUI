import React, { useState } from 'react'
import {
  Ban, Bot, Check, ChevronDown, ChevronRight, Circle, Clock, FileEdit, FilePlus, FileText, Globe, ListChecks, Loader2, Search,
  Terminal, Wrench, X, HelpCircle, Sparkles, FolderSearch, MessageSquare
} from 'lucide-react'
import type { ChatMessage, ToolUseBlockView } from '@shared/types'
import { CodeBlock } from '../common/CodeBlock'
import { DiffView } from '../common/DiffView'
import { Markdown } from './Markdown'
import { LinkifiedText } from './LinkifiedText'
import { useChatCtx } from './ChatContext'
import { formatDuration, formatTokens } from '@/lib/format'

const EXPANDED_BY_DEFAULT = new Set(['Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'AskUserQuestion', 'TodoWrite', 'ExitPlanMode', 'NotebookEdit'])

function toolIcon(name: string) {
  switch (name) {
    case 'Bash': return <Terminal size={14} />
    case 'Read': return <FileText size={14} />
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return <FileEdit size={14} />
    case 'Write': return <FilePlus size={14} />
    case 'Grep': return <Search size={14} />
    case 'Glob': return <FolderSearch size={14} />
    case 'Agent': case 'Task': return <Bot size={14} />
    case 'WebFetch': case 'WebSearch': return <Globe size={14} />
    case 'TodoWrite': return <ListChecks size={14} />
    case 'AskUserQuestion': return <HelpCircle size={14} />
    case 'Skill': return <Sparkles size={14} />
    case 'SendMessage': return <MessageSquare size={14} />
    default: return <Wrench size={14} />
  }
}

function str(v: unknown, max = 200): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function toolSummary(block: ToolUseBlockView): string {
  const i = block.input
  switch (block.name) {
    case 'Bash': return str(i.description) || str(i.command, 160)
    case 'Read': return str(i.file_path) + (i.offset ? ` (from line ${i.offset})` : '')
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return str(i.file_path ?? i.notebook_path)
    case 'Grep': return `${str(i.pattern, 80)}${i.path ? '  in ' + str(i.path, 80) : ''}`
    case 'Glob': return `${str(i.pattern, 80)}${i.path ? '  in ' + str(i.path, 80) : ''}`
    case 'Agent': case 'Task': return `${str(i.description, 100)}${i.subagent_type ? '  [' + i.subagent_type + ']' : ''}`
    case 'WebFetch': return str(i.url, 160)
    case 'WebSearch': return str(i.query, 160)
    case 'Skill': return `/${str(i.skill)} ${str(i.args, 100)}`
    case 'TodoWrite': return `${Array.isArray(i.todos) ? i.todos.length : 0} items`
    case 'AskUserQuestion': return str((i.questions as { question?: string }[] | undefined)?.[0]?.question, 140)
    case 'ToolSearch': return str(i.query, 120)
    case 'ExitPlanMode': return 'Plan ready for review'
    case 'SendMessage': return `to ${str(i.to)}: ${str(i.message, 100)}`
    default: {
      if (block.name.startsWith('mcp__')) {
        const [, server, ...rest] = block.name.split('__')
        return `${server} › ${rest.join('__')}  ${str(i, 100)}`
      }
      return str(i, 140)
    }
  }
}

function extOf(p: unknown): string | undefined {
  if (typeof p !== 'string') return undefined
  const m = /\.([A-Za-z0-9]+)$/.exec(p)
  return m?.[1]
}

export function ToolCallCard({ block, depth = 0, renderChild }: { block: ToolUseBlockView; depth?: number; renderChild: (m: ChatMessage, depth: number) => React.ReactNode }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const [resultExpanded, setResultExpanded] = useState(false)
  const ctx = useChatCtx()
  const isError = block.status === 'error'
  const expanded = open ?? (isError || EXPANDED_BY_DEFAULT.has(block.name) || (block.children?.length ?? 0) > 0)
  const i = block.input
  const filePath = typeof (i.file_path ?? i.notebook_path) === 'string' ? String(i.file_path ?? i.notebook_path) : undefined

  const status = (() => {
    switch (block.status) {
      case 'streaming': return <span className="tstatus"><Loader2 size={12} className="spin" /> composing</span>
      case 'pending': return <span className="tstatus"><Clock size={12} /> waiting</span>
      case 'running': return <span className="tstatus running"><Loader2 size={12} className="spin" /> running</span>
      case 'done': return <span className="tstatus"><Check size={12} /></span>
      case 'error': return <span className="tstatus error"><X size={12} /> error</span>
      case 'denied': return <span className="tstatus denied"><Ban size={12} /> denied</span>
    }
  })()

  const cls = `tool ${isError ? 'error' : ''} ${block.status === 'denied' ? 'denied' : ''} ${block.status === 'running' ? 'running' : ''}`
  const displayName = block.name.startsWith('mcp__') ? 'MCP' : block.name

  return (
    <div className={cls}>
      <div className="tool-head" onClick={() => setOpen(!expanded)}>
        <span className="faint">{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="faint">{toolIcon(block.name)}</span>
        <span className="tname">{displayName}</span>
        <span className="tsummary" title={toolSummary(block)}>
          {toolSummary(block)}
        </span>
        {block.task?.usage && (
          <span className="faint" style={{ fontSize: 11 }}>
            {formatTokens(block.task.usage.total_tokens)} tok · {block.task.usage.tool_uses} tools · {formatDuration(block.task.usage.duration_ms)}
          </span>
        )}
        {status}
      </div>
      {expanded && (
        <div className="tool-body">
          {filePath && (
            <div className="kv">
              <span className="k">file</span>
              <span className="v">
                <span className="file-link" onClick={(e) => ctx?.openPath(filePath, undefined, { inEditor: e.metaKey })} onContextMenu={(e) => { e.preventDefault(); ctx?.showPathMenu(filePath, undefined, e.clientX, e.clientY) }}>
                  {filePath}
                </span>
              </span>
            </div>
          )}
          <ToolInput block={block} />
          {block.task && (block.task.summary || block.task.status) && (
            <div className="task-line">
              {block.task.status === 'running' ? <Loader2 size={12} className="spin" /> : <Circle size={10} />}
              <span>{block.task.status ?? 'running'}</span>
              {block.task.summary && <span className="muted">— {block.task.summary}</span>}
              {block.task.lastToolName && <span className="faint">({block.task.lastToolName})</span>}
            </div>
          )}
          {block.children && block.children.length > 0 && (
            <div className="tool-children">{block.children.map((c) => renderChild(c, depth + 1))}</div>
          )}
          {block.result && (
            <div className={`tool-result ${block.result.isError ? 'error' : ''} ${resultExpanded ? 'expanded' : ''}`}>
              <div className="label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{block.result.isError ? 'error' : 'result'}</span>
                {block.result.content.length > 1500 && (
                  <button className="copy-btn" onClick={() => setResultExpanded((v) => !v)}>
                    {resultExpanded ? 'collapse' : 'expand'}
                  </button>
                )}
              </div>
              {block.result.content ? (
                (block.name === 'Agent' || block.name === 'Task') && !block.result.isError ? (
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', maxHeight: resultExpanded ? 'none' : 420, overflow: 'auto' }}>
                    <Markdown text={block.result.content} />
                  </div>
                ) : (
                  <pre>
                    <LinkifiedText text={block.result.content} />
                  </pre>
                )
              ) : (
                !block.result.images?.length && <span className="faint">(empty)</span>
              )}
              {block.result.images?.map((img, k) => (
                <div className="images" key={k}>
                  <img src={`data:${img.mediaType};base64,${img.data}`} alt="tool output" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ToolInput({ block }: { block: ToolUseBlockView }) {
  const i = block.input
  if (block.status === 'streaming') return <div className="faint mono" style={{ fontSize: 12 }}>{str(block.partialJson, 400)}</div>
  switch (block.name) {
    case 'Bash':
      return (
        <>
          <CodeBlock code={String(i.command ?? '')} language="bash" title={i.run_in_background ? 'bash · background' : 'bash'} />
        </>
      )
    case 'Edit':
      return <DiffView before={String(i.old_string ?? '')} after={String(i.new_string ?? '')} />
    case 'MultiEdit': {
      const edits = (i.edits as { old_string: string; new_string: string }[] | undefined) ?? []
      return (
        <>
          {edits.map((e, k) => (
            <DiffView key={k} before={e.old_string ?? ''} after={e.new_string ?? ''} />
          ))}
        </>
      )
    }
    case 'Write':
      return <CodeBlock code={String(i.content ?? '')} language={extOf(i.file_path)} title={`write · ${String(i.content ?? '').split('\n').length} lines`} />
    case 'Read':
      return null
    case 'Agent':
    case 'Task':
      return (
        <details>
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 12 }}>prompt</summary>
          <Markdown text={String(i.prompt ?? '')} />
        </details>
      )
    case 'TodoWrite': {
      const todos = (i.todos as { content: string; status: string; activeForm?: string }[] | undefined) ?? []
      return (
        <ul className="todo-list">
          {todos.map((t, k) => (
            <li key={k} className={t.status}>
              <span>{t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}</span>
              <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
            </li>
          ))}
        </ul>
      )
    }
    case 'AskUserQuestion': {
      const qs = (i.questions as { question: string; header: string; options: { label: string; description: string }[] }[] | undefined) ?? []
      const answers = (i.answers as Record<string, string> | undefined) ?? {}
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {qs.map((q, k) => (
            <div key={k}>
              <div style={{ fontWeight: 600 }}>{q.question}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {q.options?.map((o) => o.label).join(' · ')}
              </div>
              {answers[q.question] && <div style={{ color: 'var(--green)', fontSize: 12 }}>→ {answers[q.question]}</div>}
            </div>
          ))}
        </div>
      )
    }
    case 'ExitPlanMode':
      return i.plan ? <Markdown text={String(i.plan)} /> : null
    case 'Skill':
    case 'WebFetch':
    case 'WebSearch':
    case 'Grep':
    case 'Glob':
    default: {
      const entries = Object.entries(i).filter(([k]) => k !== 'file_path')
      if (!entries.length) return null
      return (
        <div className="kv">
          {entries.map(([k, v]) => (
            <React.Fragment key={k}>
              <span className="k">{k}</span>
              <span className="v">{typeof v === 'string' ? (v.length > 3000 ? v.slice(0, 3000) + '…' : v) : JSON.stringify(v, null, 1)}</span>
            </React.Fragment>
          ))}
        </div>
      )
    }
  }
}
