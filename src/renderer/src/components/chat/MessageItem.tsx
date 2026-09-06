import React, { memo } from 'react'
import { AlertTriangle, Brain, Info, Lightbulb } from 'lucide-react'
import type { AssistantChatMessage, ChatMessage } from '@shared/types'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { LinkifiedText } from './LinkifiedText'
import { formatCost, formatDuration, formatTime, formatTokens, modelLabel } from '@/lib/format'
import { useStore } from '@/store'

export const MessageItem = memo(function MessageItem({ message, depth = 0 }: { message: ChatMessage; depth?: number }) {
  const showTs = useStore((s) => s.settings?.showTimestamps ?? true)
  switch (message.kind) {
    case 'user':
      if (message.synthetic) {
        return (
          <details className="msg msg-user synthetic" style={{ alignItems: 'stretch' }}>
            <summary className="faint" style={{ cursor: 'pointer', fontSize: 11.5 }}>
              system message · {formatTime(message.ts)}
            </summary>
            <div className="bubble">{message.text}</div>
          </details>
        )
      }
      return (
        <div className="msg msg-user">
          {message.images?.length ? (
            <div className="images">
              {message.images.map((img, k) => (
                <img key={k} src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? 'attachment'} />
              ))}
            </div>
          ) : null}
          {message.text && (
            <div className="bubble">
              <LinkifiedText text={message.text} />
            </div>
          )}
          {showTs && <div className="msg-meta">{formatTime(message.ts)}</div>}
        </div>
      )
    case 'assistant':
      return <AssistantMessage message={message} depth={depth} />
    case 'system': {
      const icon = message.level === 'warning' || message.level === 'error' ? <AlertTriangle size={14} /> : message.level === 'suggestion' ? <Lightbulb size={14} /> : <Info size={14} />
      return (
        <div className={`msg-system ${message.level}`}>
          <span style={{ marginTop: 2 }}>{icon}</span>
          <div className="body">{message.data?.markdown ? <Markdown text={message.text} /> : <LinkifiedText text={message.text} />}</div>
        </div>
      )
    }
    case 'result': {
      const s = message.stats
      return (
        <div className={`msg-result ${message.errorText ? 'error' : ''}`} title={`in ${formatTokens(s.inputTokens)} · out ${formatTokens(s.outputTokens)} · cache read ${formatTokens(s.cacheReadTokens)} · cache write ${formatTokens(s.cacheCreationTokens)}`}>
          <span className="line" />
          <span>
            {message.errorText ? `⚠ ${message.errorText} · ` : ''}
            {formatDuration(s.durationMs)} · {s.numTurns} turn{s.numTurns === 1 ? '' : 's'} · {formatTokens(s.outputTokens)} out · total {formatCost(s.costUsd)}
          </span>
          <span className="line" />
        </div>
      )
    }
  }
})

function AssistantMessage({ message, depth }: { message: AssistantChatMessage; depth: number }) {
  const showTs = useStore((s) => s.settings?.showTimestamps ?? true)
  const thinking = useStore((s) => s.settings?.thinkingDisplay ?? 'collapsed')
  const lastTextIdx = (() => {
    for (let i = message.blocks.length - 1; i >= 0; i--) if (message.blocks[i].type === 'text') return i
    return -1
  })()
  const renderChild = (m: ChatMessage, d: number) => <MessageItem key={m.id} message={m} depth={d} />
  return (
    <div className="msg msg-assistant">
      {depth === 0 && (
        <div className="msg-meta">
          <span className="avatar">C</span>
          <span>{modelLabel(message.model)}</span>
          {message.subagentType && <span className="pill">{message.subagentType}</span>}
          {showTs && <span>{formatTime(message.ts)}</span>}
          {message.aborted && <span className="pill amber">interrupted</span>}
        </div>
      )}
      <div className="blocks">
        {message.blocks.map((b, i) => {
          if (b.type === 'text') {
            if (!b.text.trim() && !(message.streaming && i === lastTextIdx)) return null
            return (
              <div className={`content ${message.streaming && i === lastTextIdx ? 'streaming-cursor' : ''}`} key={i}>
                <Markdown text={b.text} />
              </div>
            )
          }
          if (b.type === 'thinking') {
            if (!b.text.trim() || thinking === 'hidden') return null
            return (
              <details className="thinking" key={i} open={thinking === 'expanded'}>
                <summary>
                  <Brain size={12} /> thinking
                </summary>
                <div className="body">{b.text}</div>
              </details>
            )
          }
          return <ToolCallCard key={b.id} block={b} depth={depth} renderChild={renderChild} />
        })}
        {message.streaming && message.blocks.length === 0 && <div className="content streaming-cursor faint">thinking…</div>}
        {message.error && <div className="msg-system error"><AlertTriangle size={14} /><div className="body">API error: {message.error}</div></div>}
      </div>
    </div>
  )
}
