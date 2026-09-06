import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bot, ChevronDown, Ellipsis, FolderOpen, GitBranch, Github, HardDrive, Loader2, Power, Square, TerminalSquare } from 'lucide-react'
import type { DirInfo, EffortLevel, PermissionDecision, PermissionMode, SessionLiveState, SessionRecord } from '@shared/types'
import { useStore } from '@/store'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { ContextBar } from './ContextBar'
import { ChatProvider, type ChatCtx } from './ChatContext'
import { ContextMenu, type MenuItem } from '../common/ContextMenu'
import { UsageStatus } from '../status/UsageStatus'
import { formatBytes, formatDateTime, modelLabel, shortenPath, timeAgo } from '@/lib/format'
import { visualState } from '@/lib/sessionState'
import { sessionMenuItems } from '@/lib/sessionMenu'

import { EFFORTS, EFFORT_LABELS, MODES } from '@/lib/options'

const EMPTY_MESSAGES: never[] = []
const FALLBACK_MODELS = [
  { value: '', label: 'Default (settings.json)' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1 (claude-fable-5-1)' },
  { value: 'claude-opus-5', label: 'Opus 5 (claude-opus-5)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 (claude-sonnet-5)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (claude-haiku-4-5)' }
]

/** Size of the working directory (du), refreshed when a turn ends and every five minutes. */
function useDirInfo(cwd: string, status: string | undefined): DirInfo | null {
  const [info, setInfo] = useState<DirInfo | null>(null)
  const idle = status === 'idle' || status === 'stopped' || status === 'error'
  useEffect(() => {
    let cancelled = false
    const load = (force?: boolean) => window.api.fs.dirInfo(cwd, force).then((i) => !cancelled && setInfo(i)).catch(() => undefined)
    void load()
    const t = setInterval(() => void load(true), 5 * 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [cwd])
  useEffect(() => {
    if (idle) window.api.fs.dirInfo(cwd, true).then(setInfo).catch(() => undefined)
  }, [idle, cwd])
  return info
}

export function ChatView({ record, live }: { record: SessionRecord; live: SessionLiveState | undefined }) {
  const messages = useStore((s) => s.messages[record.id] ?? EMPTY_MESSAGES)
  const loaded = useStore((s) => Boolean(s.historyLoaded[record.id]))
  const appInfo = useStore((s) => s.appInfo)
  const filesOpen = useStore((s) => s.filesOpen)
  const showPanelTab = useStore((s) => s.showPanelTab)
  const openBinaryExternally = useStore((s) => s.settings?.openBinaryWithSystemApp ?? true)
  const gitBranch = useStore((s) => s.git[record.id]?.status?.info.branch)
  const gitInfo = useStore((s) => s.git[record.id]?.status?.info)
  const groups = useStore((s) => s.groups)
  const interruptSession = useStore((s) => s.interruptSession)
  const send = useStore((s) => s.send)
  const answer = useStore((s) => s.answerPermission)
  const toast = useStore((s) => s.toast)
  const openFile = useStore((s) => s.openFile)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const setRevealPath = useStore((s) => s.setRevealPath)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)

  const status = live?.status ?? 'stopped'
  const dirInfo = useDirInfo(record.cwd, live?.status)

  const openPath = useCallback<ChatCtx['openPath']>(
    async (raw, line, opts) => {
      try {
        const abs = await window.api.fs.resolve(raw, record.cwd)
        const probe = await window.api.fs.probe(abs)
        if (probe.kind === 'missing') {
          toast(`Not found: ${abs}`, 'error')
          return
        }
        if (opts?.inEditor) {
          if (probe.kind === 'dir' || probe.kind === 'bundle') await window.api.shell.openPath(abs)
          else await window.api.shell.openInEditor(abs, line)
          return
        }
        if (probe.kind === 'dir') {
          toggleExpanded(record.id, abs, true)
          setRevealPath(record.id, abs)
          useStore.setState({ filesOpen: true })
        } else if (probe.kind === 'bundle' || ((probe.kind === 'binary' || probe.kind === 'too-large') && openBinaryExternally)) {
          const err = await window.api.shell.openPath(abs)
          if (err) toast(err, 'error')
        } else openFile(record.id, abs, line)
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    },
    [record.cwd, record.id, toast, openFile, toggleExpanded, setRevealPath, openBinaryExternally]
  )

  const showPathMenu = useCallback<ChatCtx['showPathMenu']>(
    (raw, line, x, y) => {
      const resolve = () => window.api.fs.resolve(raw, record.cwd)
      setMenu({
        x,
        y,
        items: [
          { label: 'Open in viewer', onClick: async () => openFile(record.id, await resolve(), line) },
          { label: 'Open in editor', onClick: () => openPath(raw, line, { inEditor: true }) },
          { label: 'Open with default app', onClick: async () => window.api.shell.openPath(await resolve()) },
          { label: 'Open with…', onClick: async () => window.api.shell.openWith(await resolve()) },
          { label: 'Reveal in Finder', onClick: async () => window.api.shell.showInFolder(await resolve()) },
          { label: '', onClick: () => undefined, separator: true },
          { label: 'Copy path', onClick: async () => { await window.api.shell.copy(await resolve()); toast('Path copied', 'success') } }
        ]
      })
    },
    [record.cwd, record.id, openPath, openFile, toast]
  )

  const ctx = useMemo<ChatCtx>(() => ({ sessionId: record.id, cwd: record.cwd, openPath, showPathMenu }), [record.id, record.cwd, openPath, showPathMenu])

  const onSend = useCallback((text: string, images: { mediaType: string; data: string; name?: string }[]) => void send(record.id, text, images), [record.id, send])
  const onInterrupt = useCallback(() => void interruptSession(record.id), [record.id, interruptSession])
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

  const models = live?.models?.length ? live.models.map((m) => ({ value: m.value, label: `${m.displayName} (${m.value})` })) : FALLBACK_MODELS
  const currentModel = record.model ?? ''
  const defaultLabel = live?.model && !record.model ? `Default — ${modelLabel(live.model)} (${live.model})` : 'Default (from settings.json)'
  const withDefault = [{ value: '', label: defaultLabel }, ...models.filter((m) => m.value !== '')]
  const modelOptions = withDefault.some((m) => m.value === currentModel) ? withDefault : [...withDefault, { value: currentModel, label: `${modelLabel(currentModel)} (${currentModel})` }]
  const vs = visualState(live)
  const counts = { background: vs.background, subagents: vs.subagents }

  const statusPill = (() => {
    const tip = vs.description
    switch (vs.key) {
      case 'working': return <span className="pill blue" data-tip={tip}><Loader2 size={11} className="spin" /> working</span>
      case 'attention': return <span className="pill amber" data-tip={tip}>needs your input</span>
      case 'starting': return <span className="pill blue" data-tip={tip}><Loader2 size={11} className="spin" /> starting</span>
      case 'idle-tasks': return <span className="pill teal" data-tip={tip}>idle · tasks running</span>
      case 'idle': return <span className="pill green" data-tip={tip}>idle</span>
      case 'error': return <span className="pill red" data-tip={tip}>error</span>
      default: return <span className="pill" data-tip={tip}>not running</span>
    }
  })()

  const moreMenu = (e: React.MouseEvent) => {
    setMenu({ x: e.clientX, y: e.clientY, items: sessionMenuItems(record, live, { groups, toast, onRename: () => setEditingTitle(true) }) })
  }

  const remoteLabel = gitInfo?.remoteWebUrl ? gitInfo.remoteWebUrl.replace(/^https?:\/\//, '') : gitInfo?.remoteUrl ? gitInfo.remoteUrl.replace(/^.*@/, '').replace(/\.git$/, '') : undefined
  const lastTs = live?.lastActivityAt ?? record.lastActiveAt
  const rl = live?.rateLimit
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
            data-tip="Double-click to rename this session"
          >
            {record.title}
          </span>
          {statusPill}
          {counts.background > 0 && (
            <button className="chip bg no-drag" data-tip={`${counts.background} background shell${counts.background === 1 ? '' : 's'} / monitor${counts.background === 1 ? '' : 's'} running — click to open the Tasks tab`} onClick={() => showPanelTab('tasks')}>
              <TerminalSquare size={12} /> {counts.background} background
            </button>
          )}
          {counts.subagents > 0 && (
            <button className="chip agent no-drag" data-tip={`${counts.subagents} subagent${counts.subagents === 1 ? '' : 's'} working — click to open the Tasks tab`} onClick={() => showPanelTab('tasks')}>
              <Bot size={12} /> {counts.subagents} subagent{counts.subagents === 1 ? '' : 's'}
            </button>
          )}
          <span className="cwd no-drag" data-tip={`Working directory: ${record.cwd}\nClick to reveal it in Finder`} onClick={() => window.api.shell.openPath(record.cwd)}>
            <FolderOpen size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            {shortenPath(record.cwd, appInfo?.homeDir)}
          </span>
          {gitBranch && (
            <button className="cwd no-drag" data-tip={`Git branch ${gitBranch} — click to open the Git panel`} onClick={() => showPanelTab('git')}>
              <GitBranch size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
              {gitBranch}
            </button>
          )}
          <span className="spacer" />
          {!filesOpen && <UsageStatus compact />}
          <button className="btn ghost icon no-drag" data-tip="Open the working directory in a Terminal window" onClick={() => window.api.shell.openTerminal(record.cwd)}>
            <TerminalSquare size={15} />
          </button>
          {live?.processAlive ? (
            <button className="btn ghost icon no-drag" data-tip="Stop the Claude process and its background tasks (history is kept; the next message starts it again)" onClick={() => window.api.sessions.stop(record.id)}>
              <Power size={15} />
            </button>
          ) : null}
          <button className="btn ghost icon no-drag" data-tip="More actions: rename, pin, archive, move to group, change working directory, delete…" onClick={moreMenu}>
            <Ellipsis size={15} />
          </button>
        </div>
        {live?.cwdMissing && (
          <div className="cwd-missing">
            <AlertTriangle size={14} />
            <div className="body">
              This session's folder no longer exists: <code>{record.cwd}</code>. Point it at the folder's new location; the transcript moves along so nothing is lost.
            </div>
            <button className="btn sm primary" onClick={() => window.api.sessions.relocate(record.id).then((r) => r && toast(`Working directory is now ${r.cwd}`, 'success')).catch((err) => toast(err.message, 'error'))}>
              Choose folder…
            </button>
          </div>
        )}
        <div className="chat-toolbar">
          <label data-tip="Model used for this session's next turns (full model id in parentheses)">
            model
            <select className="select" style={{ marginLeft: 6, maxWidth: 320 }} value={currentModel} onChange={(e) => window.api.sessions.setModel(record.id, e.target.value).catch((err) => toast(err.message, 'error'))}>
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
          <label data-tip={`Permission mode: what Claude may do without asking.\n${MODES.map((m) => `${m.value}: ${m.hint}`).join('\n')}`}>
            permissions
            <select className="select" style={{ marginLeft: 6, maxWidth: 380 }} value={live?.permissionMode ?? record.permissionMode} onChange={(e) => window.api.sessions.setPermissionMode(record.id, e.target.value as PermissionMode).catch((err) => toast(err.message, 'error'))}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value} title={m.hint}>{m.label}</option>
              ))}
            </select>
          </label>
          <label data-tip="Effort level: how much reasoning the model spends per turn (higher = slower, more thorough)">
            effort
            <select className="select" style={{ marginLeft: 6, maxWidth: 240 }} value={record.effort ?? ''} onChange={(e) => window.api.sessions.setEffort(record.id, e.target.value as EffortLevel | '').catch((err) => toast(err.message, 'error'))}>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>{EFFORT_LABELS[e] ?? e}</option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <span className="tb-info" data-tip={`Last activity in this chat: ${formatDateTime(lastTs)}`}>
            {formatDateTime(lastTs)} <span className="faint">({timeAgo(lastTs)})</span>
          </span>
          {dirInfo?.exists && dirInfo.bytes !== undefined && (
            <span className="tb-info" data-tip={`Size of the working directory (du -sk, refreshed after each turn and every 5 minutes; checked ${formatDateTime(dirInfo.checkedAt)})`}>
              <HardDrive size={11} /> {formatBytes(dirInfo.bytes)}
            </span>
          )}
          {remoteLabel && (
            <button className="tb-info clickable" data-tip={`Git remote ${gitInfo?.remoteName ?? 'origin'}: ${gitInfo?.remoteUrl ?? ''}${gitInfo?.remoteWebUrl ? '\nClick to open it in the browser' : ''}`} onClick={() => gitInfo?.remoteWebUrl && window.api.shell.openExternal(gitInfo.remoteWebUrl)}>
              <Github size={11} /> {remoteLabel}
              {gitInfo && (gitInfo.ahead || gitInfo.behind) ? <span className="faint"> {gitInfo.ahead ? `↑${gitInfo.ahead}` : ''}{gitInfo.behind ? ` ↓${gitInfo.behind}` : ''}</span> : null}
            </button>
          )}
          <ContextBar sessionId={record.id} live={live} />
          {rl && rl.status !== 'allowed' && (
            <span className={rl.status === 'rejected' ? 'pill red' : 'pill amber'} data-tip={`Rate limit (${rl.rateLimitType})`}>
              {rl.status === 'rejected' ? 'rate limited' : 'near limit'}
            </span>
          )}
          {(status === 'running' || status === 'requires_action') && (
            <button className="btn danger sm" onClick={onInterrupt} data-tip="Stop the current turn (⌘.). The prompt you sent goes back into the input box.">
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
