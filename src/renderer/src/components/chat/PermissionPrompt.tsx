import React, { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { PendingPermission, PermissionDecision } from '@shared/types'
import { CodeBlock } from '../common/CodeBlock'
import { DiffView } from '../common/DiffView'
import { Markdown } from './Markdown'
import { useChatCtx } from './ChatContext'

interface Question {
  question: string
  header: string
  multiSelect?: boolean
  options: { label: string; description: string; preview?: string }[]
}

export function PermissionPrompt({ request, onAnswer }: { request: PendingPermission; onAnswer: (d: PermissionDecision) => void }) {
  if (request.toolName === 'AskUserQuestion') return <QuestionPrompt request={request} onAnswer={onAnswer} />
  return <ToolPermission request={request} onAnswer={onAnswer} />
}

function ToolPermission({ request, onAnswer }: { request: PendingPermission; onAnswer: (d: PermissionDecision) => void }) {
  const [denyOpen, setDenyOpen] = useState(false)
  const [reason, setReason] = useState('')
  const ctx = useChatCtx()
  const i = request.input
  const isPlan = request.toolName === 'ExitPlanMode'
  const filePath = typeof i.file_path === 'string' ? i.file_path : undefined
  const canAlways = Boolean(request.suggestions?.length)
  const title = request.title || (isPlan ? 'Claude wants to exit plan mode and start implementing' : `Claude wants to use ${request.displayName || request.toolName}`)

  return (
    <div className="permission">
      <div className="p-title">
        <ShieldAlert size={16} /> {title}
      </div>
      {request.description && <div className="p-desc">{request.description}</div>}
      {request.decisionReason && <div className="p-desc faint">{request.decisionReason}</div>}
      {request.agentId && <div className="p-desc faint">from subagent {request.agentId}</div>}
      {filePath && (
        <div className="kv">
          <span className="k">file</span>
          <span className="v">
            <span className="file-link" onClick={() => ctx?.openPath(filePath)}>{filePath}</span>
          </span>
        </div>
      )}
      {request.toolName === 'Bash' && (
        <>
          {typeof i.description === 'string' && <div className="p-desc">{i.description}</div>}
          <CodeBlock code={String(i.command ?? '')} language="bash" />
        </>
      )}
      {request.toolName === 'Edit' && <DiffView before={String(i.old_string ?? '')} after={String(i.new_string ?? '')} />}
      {request.toolName === 'MultiEdit' &&
        ((i.edits as { old_string: string; new_string: string }[] | undefined) ?? []).map((e, k) => <DiffView key={k} before={e.old_string} after={e.new_string} />)}
      {request.toolName === 'Write' && <CodeBlock code={String(i.content ?? '')} title={`write ${String(i.content ?? '').split('\n').length} lines`} />}
      {isPlan && typeof i.plan === 'string' && <Markdown text={i.plan} />}
      {!['Bash', 'Edit', 'MultiEdit', 'Write', 'ExitPlanMode'].includes(request.toolName) && Object.keys(i).length > 0 && (
        <div className="kv">
          {Object.entries(i)
            .filter(([k]) => k !== 'file_path')
            .map(([k, v]) => (
              <React.Fragment key={k}>
                <span className="k">{k}</span>
                <span className="v">{typeof v === 'string' ? v.slice(0, 2000) : JSON.stringify(v, null, 1)?.slice(0, 2000)}</span>
              </React.Fragment>
            ))}
        </div>
      )}
      <div className="p-actions">
        <button className="btn primary" onClick={() => onAnswer({ behavior: 'allow' })}>
          {isPlan ? 'Approve plan' : 'Allow'} <span className="kbd" style={{ marginLeft: 4 }}>⌘⏎</span>
        </button>
        {canAlways && !isPlan && (
          <button className="btn" onClick={() => onAnswer({ behavior: 'allow', alwaysAllow: true })} title="Add a permission rule so this is not asked again">
            Always allow
          </button>
        )}
        <button className="btn danger" onClick={() => (denyOpen ? onAnswer({ behavior: 'deny', message: reason || undefined }) : setDenyOpen(true))}>
          {isPlan ? 'Keep planning' : denyOpen ? 'Send denial' : 'Deny'}
        </button>
        {denyOpen && (
          <button className="btn ghost" onClick={() => setDenyOpen(false)}>
            cancel
          </button>
        )}
      </div>
      {denyOpen && (
        <textarea
          className="input"
          autoFocus
          placeholder="Optional: tell Claude what to do instead…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onAnswer({ behavior: 'deny', message: reason || undefined })
          }}
        />
      )}
    </div>
  )
}

function QuestionPrompt({ request, onAnswer }: { request: PendingPermission; onAnswer: (d: PermissionDecision) => void }) {
  const questions = (request.input.questions as Question[] | undefined) ?? []
  const [selected, setSelected] = useState<Record<number, Set<string>>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((s) => {
      const cur = new Set(s[qi] ?? [])
      if (multi) {
        if (cur.has(label)) cur.delete(label)
        else cur.add(label)
      } else {
        cur.clear()
        cur.add(label)
      }
      return { ...s, [qi]: cur }
    })
  }

  const complete = questions.every((q, qi) => (selected[qi]?.size ?? 0) > 0 || (other[qi] ?? '').trim())
  const submit = () => {
    const answers: Record<string, string> = {}
    questions.forEach((q, qi) => {
      const picks = [...(selected[qi] ?? [])]
      const extra = (other[qi] ?? '').trim()
      if (extra) picks.push(extra)
      answers[q.question] = picks.join(', ')
    })
    onAnswer({ behavior: 'allow', updatedInput: { ...request.input, answers } })
  }

  return (
    <div className="permission">
      <div className="p-title">
        <ShieldAlert size={16} /> Claude has a question
      </div>
      {questions.map((q, qi) => (
        <div className="question" key={qi}>
          <div className="q-header">{q.header}</div>
          <div className="q-text">{q.question}</div>
          {q.options.map((o) => {
            const on = selected[qi]?.has(o.label)
            return (
              <div className={`option ${on ? 'selected' : ''}`} key={o.label} onClick={() => toggle(qi, o.label, Boolean(q.multiSelect))}>
                <span>{q.multiSelect ? (on ? '☑' : '☐') : on ? '◉' : '○'}</span>
                <div style={{ flex: 1 }}>
                  <div className="o-label">{o.label}</div>
                  {o.description && <div className="o-desc">{o.description}</div>}
                  {o.preview && on && <pre>{o.preview}</pre>}
                </div>
              </div>
            )
          })}
          <input
            className="input"
            placeholder="Other (type your own answer)…"
            value={other[qi] ?? ''}
            onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))}
          />
        </div>
      ))}
      <div className="p-actions">
        <button className="btn primary" disabled={!complete} onClick={submit}>
          Submit answer
        </button>
        <button className="btn ghost" onClick={() => onAnswer({ behavior: 'deny', message: 'The user dismissed the question without answering.' })}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
