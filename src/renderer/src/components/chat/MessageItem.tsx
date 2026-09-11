import React, { memo } from 'react'
import { AlertTriangle, Brain, History, Info, Lightbulb, Undo2 } from 'lucide-react'
import type { AssistantChatMessage, ChatMessage } from '@shared/types'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { LinkifiedText } from './LinkifiedText'
import { formatCost, formatDateTime, formatDuration, formatStamp, formatTime, formatTokens, modelLabel } from '@/lib/format'
import { useStore } from '@/store'
import { useChatCtx } from './ChatContext'

/**
 * What has happened to a prompt you typed. There are two states and no others: Claude Code has
 * taken it (registered), or it is still waiting in Claude Code's queue (queued).
 */
export type PromptState = 'registered' | 'queued'

const PROMPT_STATE: Record<PromptState, { mark: string; label: string; tip: string }> = {
  registered: { mark: '✓', label: 'registered', tip: 'Claude Code has taken this prompt: what follows it is the answer it started' },
  queued: { mark: '⋯', label: 'queued', tip: 'Waiting: Claude Code has not taken this prompt yet. It is sent when the current turn ends, and ↑ in the input box (or the take-back button) pulls it out of the queue again.' }
}

/**
 * What a message the CLI wrote about its own work actually is, so the folded row says so instead
 * of reading "system message" for everything.
 */
function houseKeepingLabel(text: string): string {
  const t = text.trimStart()
  if (t.startsWith('<command-name>')) return 'the command as Claude Code received it'
  if (t.startsWith('<local-command-stdout>')) return 'what the command printed'
  if (t.startsWith('<local-command-caveat>')) return 'note about the command'
  if (t.startsWith('<system-reminder>')) return 'reminder Claude Code added'
  if (t.startsWith('<task-notification>')) return 'background agent finished'
  if (t.startsWith('<bash-input>')) return 'command run in the terminal'
  if (t.startsWith('<bash-stdout>')) return 'what the terminal command printed'
  if (t.startsWith('<monitor-notification>')) return 'monitor reported a change'
  if (t.startsWith('<background-task')) return 'background command'
  if (t.startsWith('<cron-')) return 'scheduled task'
  if (t.startsWith('[Request interrupted')) return 'interrupted'
  if (t.startsWith('This session is being continued from a previous conversation')) return 'summary kept after compacting'
  return 'system message'
}

/**
 * The parts of a shell command typed after "!" (or run in the terminal's shell mode), as Claude Code
 * writes them into the conversation; null when the text is something else.
 */
function parseShellRun(text: string): { command?: string; stdout?: string; stderr?: string } | null {
  const t = text.trimStart()
  if (!t.startsWith('<bash-input>') && !t.startsWith('<bash-stdout>')) return null
  return {
    command: /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1],
    stdout: /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(text)?.[1],
    stderr: /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(text)?.[1]
  }
}

/** A shell command and what it printed, shown as it would read in a terminal. */
function ShellRun({ message, shell }: { message: ChatMessage; shell: { command?: string; stdout?: string; stderr?: string } }) {
  const chat = useChatCtx()
  const showTs = useStore((s) => s.settings?.showTimestamps ?? true)
  const running = useStore((s) => (chat ? Boolean(s.live[chat.sessionId]?.runningShellIds?.includes(message.id)) : false))
  const out = shell.stdout?.replace(/\s+$/, '')
  const err = shell.stderr?.replace(/\s+$/, '')
  return (
    <div className="msg shell-run">
      {shell.command !== undefined && (
        <div className="shell-cmd" data-tip="A shell command run in this chat's folder. Claude reads it and its output with your next message.">
          <span className="shell-bang">!</span>
          <span className="mono shell-text">{shell.command}</span>
          <span className="spacer" />
          {running && <span className="faint">running…</span>}
          {running && chat && (
            <button className="btn ghost sm" data-tip="Stop this command" onClick={() => void window.api.sessions.stopShell(chat.sessionId, message.id)}>
              Stop
            </button>
          )}
          {showTs && <span className="faint">{formatTime(message.ts)}</span>}
        </div>
      )}
      {(out || err) && (
        <pre className="shell-out">
          {out}
          {out && err ? '\n' : ''}
          {err && <span className="shell-err">{err}</span>}
        </pre>
      )}
      {!running && shell.stdout !== undefined && !out && !err && <div className="faint shell-none">no output</div>}
    </div>
  )
}

export const MessageItem = memo(function MessageItem({ message, depth = 0, state }: { message: ChatMessage; depth?: number; state?: PromptState }) {
  const showTs = useStore((s) => s.settings?.showTimestamps ?? true)
  const chat = useChatCtx()
  switch (message.kind) {
    case 'user':
      if (message.synthetic) {
        const shell = parseShellRun(message.text)
        if (shell) return <ShellRun message={message} shell={shell} />
        return (
          <details className="msg msg-user synthetic" style={{ alignItems: 'stretch' }}>
            <summary className="faint" style={{ cursor: 'pointer', fontSize: 11.5 }}>
              {houseKeepingLabel(message.text)} · {formatTime(message.ts)}
            </summary>
            <div className="bubble">{message.text}</div>
          </details>
        )
      }
      return (
        <div
          className={`msg msg-user ${state ? 'st-' + state : ''}`}
          onContextMenu={(e) => {
            if (!chat) return
            e.preventDefault()
            chat.showPromptMenu(message.id, message.text, e.clientX, e.clientY)
          }}
        >
          {message.images?.length ? (
            <div className="images">
              {message.images.map((img, k) => (
                <img key={k} src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? 'attachment'} />
              ))}
            </div>
          ) : null}
          {message.text && (
            <div className="bubble-row">
              {chat && (
                state === 'queued' ? (
                  <button
                    className="msg-action"
                    data-tip="Take this prompt back out of the queue and put it in the input box"
                    onClick={() => chat.takeBackPrompt(message.id)}
                  >
                    <Undo2 size={13} />
                  </button>
                ) : (
                  <button
                    className="msg-action"
                    data-tip="Rewind the chat to this prompt (asks first whether the files should go back too)"
                    onClick={() => chat.rewindTo(message.id)}
                  >
                    <History size={13} />
                  </button>
                )
              )}
              <div className="bubble">
                <LinkifiedText text={message.text} />
              </div>
            </div>
          )}
          {(showTs || state) && (
            <div className="msg-meta">
              {state && (
                <span className={`prompt-state st-${state}`} data-tip={PROMPT_STATE[state].tip}>
                  <span className="pmark">{PROMPT_STATE[state].mark}</span> {PROMPT_STATE[state].label}
                </span>
              )}
              {showTs && formatTime(message.ts)}
            </div>
          )}
        </div>
      )
    case 'assistant':
      return <AssistantMessage message={message} depth={depth} />
    case 'system': {
      const icon = message.level === 'warning' || message.level === 'error' ? <AlertTriangle size={14} /> : message.level === 'suggestion' ? <Lightbulb size={14} /> : <Info size={14} />
      // Compacting the context keeps a summary of the conversation so far; it is what Claude
      // remembers from here on, so it can be opened from the row that reports the compaction
      // instead of standing in the chat as a message of its own.
      const kept = typeof message.data?.summary === 'string' ? message.data.summary : ''
      if (kept) {
        return (
          <details className={`msg-system foldable ${message.level}`}>
            <summary>
              <span style={{ marginTop: 2 }}>{icon}</span>
              <span className="body">{message.text}</span>
              <span className="faint">what Claude kept ▸</span>
            </summary>
            <div className="kept">{kept}</div>
          </details>
        )
      }
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
        <div className={`msg-result ${message.errorText ? 'error' : ''}`} data-tip={`Turn finished ${formatDateTime(s.endedAt)}\nin ${formatTokens(s.inputTokens)} · out ${formatTokens(s.outputTokens)} · cache read ${formatTokens(s.cacheReadTokens)} · cache write ${formatTokens(s.cacheCreationTokens)} · cost ${formatCost(s.costUsd)}`}>
          <span className="line" />
          <span>
            {message.errorText ? `⚠ ${message.errorText} · ` : ''}
            {formatDuration(s.durationMs)} · {s.numTurns} turn{s.numTurns === 1 ? '' : 's'} · {formatTokens(s.outputTokens)} out · {formatStamp(s.endedAt || message.ts)}
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
