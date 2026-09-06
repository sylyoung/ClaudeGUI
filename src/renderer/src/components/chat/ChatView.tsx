import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Ellipsis, FolderOpen, Loader2, Power, Square, TerminalSquare } from 'lucide-react'
import type { EffortLevel, PermissionDecision, PermissionMode, SessionLiveState, SessionRecord } from '@shared/types'
import { useStore } from '@/store'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { ChatProvider, type ChatCtx } from './ChatContext'
import { ContextMenu, type MenuItem } from '../common/ContextMenu'
import { formatCost, formatTokens, modelLabel, shortenPath } from '@/lib/format'

const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Ask before risky actions' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Auto-accept file edits' },
  { value: 'auto', label: 'Auto', hint: 'Classifier approves safe actions' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning' },
  { value: 'dontAsk', label: "Don't ask", hint: 'Deny anything not pre-approved' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Skip all permission checks' }
]
const EMPTY_MESSAGES: never[] = []
const EFFORTS: (EffortLevel | '')[] = ['', 'low', 'medium', 'high', 'xhigh', 'max']
const FALLBACK_MODELS = [
  { value: '', label: 'Default (settings.json)' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

export function ChatView({ record, live }: { record: SessionRecord; live: SessionLiveState | undefined }) {
  const messages = useStore((s) => s.messages[record.id] ?? EMPTY_MESSAGES)
  const loaded = useStore((s) => Boolean(s.historyLoaded[record.id]))
  const appInfo = useStore((s) => s.appInfo)
  const send = useStore((s) => s.send)
  const answer = useStore((s) => s.answerPermission)
  const toast = useStore((s) => s.toast)
  const openFile = useStore((s) => s.openFile)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const setRevealPath = useStore((s) => s.setRevealPath)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)

  const status = live?.status ?? 'stopped'

  const openPath = useCallback<ChatCtx['openPath']>(
    async (raw, line, opts) => {
      try {
        const abs = await window.api.fs.resolve(raw, record.cwd)
        const { exists, isDir } = await window.api.fs.exists(abs)
        if (!exists) {
          toast(`Not found: ${abs}`, 'error')
          return
        }
        if (opts?.inEditor) {
          if (isDir) await window.api.shell.openPath(abs)
          else await window.api.shell.openInEditor(abs, line)
          return
        }
        if (isDir) {
          toggleExpanded(record.id, abs, true)
          setRevealPath(record.id, abs)
          useStore.setState({ filesOpen: true })
        } else openFile(record.id, abs, line)
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    },
    [record.cwd, record.id, toast, openFile, toggleExpanded, setRevealPath]
  )

  const showPathMenu = useCallback<ChatCtx['showPathMenu']>(
    (raw, line, x, y) => {
      const resolve = () => window.api.fs.resolve(raw, record.cwd)
      setMenu({
        x,
        y,
        items: [
          { label: 'Open in viewer', onClick: () => openPath(raw, line) },
          { label: 'Open in editor', onClick: () => openPath(raw, line, { inEditor: true }) },
          { label: 'Open with default app', onClick: async () => window.api.shell.openPath(await resolve()) },
          { label: 'Reveal in Finder', onClick: async () => window.api.shell.showInFolder(await resolve()) },
          { label: '', onClick: () => undefined, separator: true },
          { label: 'Copy path', onClick: async () => { await window.api.shell.copy(await resolve()); toast('Path copied', 'success') } }
        ]
      })
    },
    [record.cwd, openPath, toast]
  )

  const ctx = useMemo<ChatCtx>(() => ({ sessionId: record.id, cwd: record.cwd, openPath, showPathMenu }), [record.id, record.cwd, openPath, showPathMenu])

  const onSend = useCallback((text: string, images: { mediaType: string; data: string; name?: string }[]) => void send(record.id, text, images), [record.id, send])
  const onInterrupt = useCallback(() => window.api.sessions.interrupt(record.id).catch((e) => toast(e.message, 'error')), [record.id, toast])
  const onAnswer = useCallback((requestId: string, d: PermissionDecision) => void answer(record.id, requestId, d), [record.id, answer])

  useEffect(() => {
    document.title = `${record.title} — ClaudeGUI`
    return () => {
      document.title = 'ClaudeGUI'
    }
  }, [record.title])

  // ⌘⏎ answers the first pending permission with allow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.metaKey && live?.pendingPermissions?.length && !(e.target instanceof HTMLTextAreaElement)) {
        const p = live.pendingPermissions[0]
        if (p.toolName !== 'AskUserQuestion') onAnswer(p.requestId, { behavior: 'allow' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [live?.pendingPermissions, onAnswer])

  const models = live?.models?.length ? live.models.map((m) => ({ value: m.value, label: m.displayName })) : FALLBACK_MODELS
  const currentModel = record.model ?? ''
  const defaultLabel = live?.model && !record.model ? `Default (${modelLabel(live.model)})` : 'Default (settings.json)'
  const withDefault = [{ value: '', label: defaultLabel }, ...models.filter((m) => m.value !== '')]
  const modelOptions = withDefault.some((m) => m.value === currentModel) ? withDefault : [...withDefault, { value: currentModel, label: modelLabel(currentModel) }]

  const statusPill = (() => {
    switch (status) {
      case 'running': return <span className="pill green"><Loader2 size={11} className="spin" /> {live?.activity === 'compacting' ? 'compacting' : live?.activeTools?.length ? `running ${live.activeTools[live.activeTools.length - 1].toolName}` : 'working'}</span>
      case 'requires_action': return <span className="pill amber">needs your input</span>
      case 'starting': return <span className="pill blue"><Loader2 size={11} className="spin" /> starting</span>
      case 'idle': return <span className="pill green">idle</span>
      case 'error': return <span className="pill red" title={live?.error}>error</span>
      default: return <span className="pill">not running</span>
    }
  })()

  const moreMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: 'Rename…', onClick: () => setEditingTitle(true) },
      { label: record.pinned ? 'Unpin' : 'Pin to top', onClick: () => window.api.sessions.setPinned(record.id, !record.pinned) },
      { label: record.archived ? 'Unarchive' : 'Archive', onClick: () => window.api.sessions.setArchived(record.id, !record.archived) },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Open folder in Terminal', onClick: () => window.api.shell.openTerminal(record.cwd) },
      { label: 'Reveal folder in Finder', onClick: () => window.api.shell.openPath(record.cwd) },
      { label: 'Copy resume command', onClick: async () => { await window.api.shell.copy(`cd "${record.cwd}" && claude --resume ${record.claudeSessionId}`); toast('Copied: claude --resume …', 'success') } },
      { label: 'Copy session id', onClick: async () => { await window.api.shell.copy(record.claudeSessionId); toast('Session id copied', 'success') } },
      { label: '', onClick: () => undefined, separator: true },
      { label: live?.processAlive ? 'Stop process (keeps history)' : 'Start process', onClick: () => (live?.processAlive ? window.api.sessions.stop(record.id) : window.api.sessions.start(record.id)).catch((err) => toast(err.message, 'error')) },
      { label: 'Delete session…', danger: true, onClick: () => { if (confirm(`Delete "${record.title}" from ClaudeGUI?\n\nThe Claude Code transcript on disk is kept unless you also choose to delete it next.`)) { const del = confirm('Also delete the transcript file from ~/.claude/projects? (Cancel = keep it)'); void window.api.sessions.remove(record.id, del) } } }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  return (
    <ChatProvider value={ctx}>
      <div className="chat">
        <div className="chat-header drag">
          <span
            className="title no-drag"
            contentEditable={editingTitle}
            suppressContentEditableWarning
            onDoubleClick={() => setEditingTitle(true)}
            onBlur={(e) => {
              setEditingTitle(false)
              const t = e.currentTarget.textContent?.trim()
              if (t && t !== record.title) window.api.sessions.rename(record.id, t)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur() }
              if (e.key === 'Escape') { e.currentTarget.textContent = record.title; (e.currentTarget as HTMLElement).blur() }
            }}
            title="Double-click to rename"
          >
            {record.title}
          </span>
          {statusPill}
          <span className="cwd no-drag" title={record.cwd} onClick={() => window.api.shell.openPath(record.cwd)}>
            <FolderOpen size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            {shortenPath(record.cwd, appInfo?.homeDir)}
          </span>
          <span className="spacer" />
          <button className="btn ghost icon no-drag" title="Open folder in terminal" onClick={() => window.api.shell.openTerminal(record.cwd)}>
            <TerminalSquare size={15} />
          </button>
          {live?.processAlive ? (
            <button className="btn ghost icon no-drag" title="Stop the Claude process (history is kept; it resumes on next message)" onClick={() => window.api.sessions.stop(record.id)}>
              <Power size={15} />
            </button>
          ) : null}
          <button className="btn ghost icon no-drag" title="More" onClick={moreMenu}>
            <Ellipsis size={15} />
          </button>
        </div>
        <div className="chat-toolbar">
          <label>
            model
            <select className="select" style={{ marginLeft: 6 }} value={currentModel} onChange={(e) => window.api.sessions.setModel(record.id, e.target.value).catch((err) => toast(err.message, 'error'))}>
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
          <label>
            permissions
            <select className="select" style={{ marginLeft: 6 }} value={live?.permissionMode ?? record.permissionMode} onChange={(e) => window.api.sessions.setPermissionMode(record.id, e.target.value as PermissionMode).catch((err) => toast(err.message, 'error'))}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value} title={m.hint}>{m.label}</option>
              ))}
            </select>
          </label>
          <label>
            effort
            <select className="select" style={{ marginLeft: 6 }} value={record.effort ?? ''} onChange={(e) => window.api.sessions.setEffort(record.id, e.target.value as EffortLevel | '').catch((err) => toast(err.message, 'error'))}>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>{e || 'default'}</option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {live?.contextTokens ? <span title="Context tokens used by the last request">ctx {formatTokens(live.contextTokens)}</span> : null}
          {live?.totalCostUsd ? <span title="Estimated cost of this process's turns">{formatCost(live.totalCostUsd)}</span> : null}
          {live?.rateLimit?.utilization != null && (
            <span className={live.rateLimit.status === 'rejected' ? 'pill red' : live.rateLimit.status === 'allowed_warning' ? 'pill amber' : 'pill'} title={`Rate limit (${live.rateLimit.rateLimitType})`}>
              limit {Math.round(live.rateLimit.utilization * 100)}%
            </span>
          )}
          {live?.claudeVersion ? <span className="faint">v{live.claudeVersion}</span> : null}
          {status === 'running' && (
            <button className="btn danger sm" onClick={onInterrupt}>
              <Square size={11} /> Stop
            </button>
          )}
        </div>
        <MessageList sessionId={record.id} messages={messages} pending={live?.pendingPermissions ?? []} onAnswer={onAnswer} loaded={loaded} />
        {live?.error && status === 'error' && (
          <div className="msg-system error" style={{ margin: '0 20px 8px' }}>
            <ChevronDown size={14} />
            <div className="body">Process error: {live.error}. Sending a message restarts the session.</div>
          </div>
        )}
        <Composer sessionId={record.id} live={live} onSend={onSend} onInterrupt={onInterrupt} />
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      </div>
    </ChatProvider>
  )
}
