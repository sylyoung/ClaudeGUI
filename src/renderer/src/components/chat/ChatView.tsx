import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Bot, ChevronDown, Code, Ellipsis, FolderOpen, GitBranch, Github, HardDrive, Loader2, MessageSquare, PanelRight, Pin, PinOff, Play, Power, Square, TerminalSquare } from 'lucide-react'
import type { DirInfo, EffortLevel, PermissionDecision, PermissionMode, SessionLiveState, SessionRecord } from '@shared/types'
import { groupColorFor } from '@shared/colors'
import { lastPromptOf } from '@shared/util'
import { useStore } from '@/store'
import { PopupSelect, type PopupOption } from '../common/PopupSelect'
import { GroupColorPicker } from '../common/GroupColorPicker'
import { isDarkTheme } from '@/lib/theme'
import { MessageList } from './MessageList'
import { Composer } from './Composer'
import { ContextBar } from './ContextBar'
import { ChatProvider, type ChatCtx } from './ChatContext'
import { ContextMenu, type MenuItem } from '../common/ContextMenu'
import { UsageStatus } from '../status/UsageStatus'
import { formatBytes, formatDateTime, modelLabel, shortenPath, timeAgo } from '@/lib/format'
import { visualState } from '@/lib/sessionState'
import { sessionMenuItems } from '@/lib/sessionMenu'

import { EFFORTS, EFFORT_LABELS, EFFORT_SHORT, MODES } from '@/lib/options'

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
  const toggleFiles = useStore((s) => s.toggleFiles)
  const setFilesOpen = useStore((s) => s.setFilesOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const showBoard = useStore((s) => s.settings?.showStatusBoard ?? true)
  const themeInfo = useStore((s) => s.theme)
  const themeMode = useStore((s) => s.settings?.theme ?? 'system')
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
  const [colorPick, setColorPick] = useState<{ x: number; y: number } | null>(null)
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
          setFilesOpen(true)
        } else if (probe.kind === 'bundle' || ((probe.kind === 'binary' || probe.kind === 'too-large') && openBinaryExternally)) {
          const err = await window.api.shell.openPath(abs)
          if (err) toast(err, 'error')
        } else openFile(record.id, abs, line)
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    },
    [record.cwd, record.id, toast, openFile, toggleExpanded, setRevealPath, openBinaryExternally, setFilesOpen]
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

  const models = live?.models?.length ? live.models.map((m) => ({ value: m.value, label: `${m.displayName} (${m.value})`, short: m.displayName, hint: m.description })) : FALLBACK_MODELS.filter((m) => m.value).map((m) => ({ value: m.value, label: m.label, short: modelLabel(m.value) }))
  const currentModel = record.model ?? ''
  const defaultOpt: PopupOption = live?.model && !record.model
    ? { value: '', label: `Default — ${modelLabel(live.model)} (${live.model}), from settings.json`, short: `Default · ${modelLabel(live.model)}` }
    : { value: '', label: 'Default (from settings.json)', short: 'Default' }
  const modelOptions: PopupOption[] = [defaultOpt, ...models]
  if (!modelOptions.some((m) => m.value === currentModel)) modelOptions.push({ value: currentModel, label: `${modelLabel(currentModel)} (${currentModel})`, short: modelLabel(currentModel) })
  const modeOptions: PopupOption[] = MODES.map((m) => ({ value: m.value, label: m.label, short: m.value, hint: m.hint }))
  const effortOptions: PopupOption[] = EFFORTS.map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e, short: EFFORT_SHORT[e] ?? e }))
  const vs = visualState(live)
  const counts = { background: vs.background, subagents: vs.subagents }
  const dark = isDarkTheme(themeMode, themeInfo.systemDark)
  const group = record.groupId ? groups.find((g) => g.id === record.groupId) : undefined
  const gColor = groupColorFor(group, dark)
  const fail = (err: unknown) => toast((err as Error).message, 'error')

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
  const groupMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      ...[...groups].sort((a, b) => a.order - b.order).map((g) => ({ label: g.name, checked: record.groupId === g.id, onClick: () => window.api.sessions.moveSession(record.id, { groupId: g.id }).catch(fail) })),
      { label: '', onClick: () => undefined, separator: true },
      { label: 'No group', checked: !record.groupId, onClick: () => window.api.sessions.moveSession(record.id, {}).catch(fail) }
    ]
    if (group) {
      const x = e.clientX
      const y = e.clientY
      items.push({ label: '', onClick: () => undefined, separator: true }, { label: `Change colour of "${group.name}"…`, onClick: () => setColorPick({ x, y }) })
    }
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const remoteFull = gitInfo?.remoteWebUrl ? gitInfo.remoteWebUrl.replace(/^https?:\/\//, '') : gitInfo?.remoteUrl ? gitInfo.remoteUrl.replace(/^.*@/, '').replace(/\.git$/, '') : undefined
  // "github.com/owner/repo" → "owner/repo" (the icon says GitHub); other hosts keep their name.
  const remoteLabel = remoteFull?.replace(/^github\.com\//, '')
  const lastPrompt = lastPromptOf(record)
  const lastAct = live?.lastActivityAt ?? record.lastActiveAt
  const rl = live?.rateLimit
  const headerInset = !sidebarOpen && !showBoard ? 84 : 12
  return (
    <ChatProvider value={ctx}>
      <div className="chat">
        <div className="chat-header drag" style={{ paddingLeft: headerInset }}>
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
          <span className="spacer" />
          {!filesOpen && <UsageStatus compact />}
          <span className="hdr-actions no-drag">
            <button className="btn ghost icon" data-tip="Open the working directory in a Terminal window" onClick={() => window.api.shell.openTerminal(record.cwd).catch(fail)}>
              <TerminalSquare size={15} />
            </button>
            <button className="btn ghost icon" data-tip="Reveal the working directory in Finder" onClick={() => window.api.shell.openPath(record.cwd).catch(fail)}>
              <FolderOpen size={15} />
            </button>
            <button className="btn ghost icon" data-tip="Open the working directory in your editor (Settings → Files → editor command)" onClick={() => window.api.shell.openInEditor(record.cwd).catch(fail)}>
              <Code size={15} />
            </button>
            {gitInfo?.remoteWebUrl && (
              <button className="btn ghost icon" data-tip={`Open ${remoteFull} in the browser`} onClick={() => window.api.shell.openExternal(gitInfo.remoteWebUrl!).catch(fail)}>
                <Github size={15} />
              </button>
            )}
            <button className={`btn ghost icon ${filesOpen ? 'on' : ''}`} data-tip={filesOpen ? 'Hide the folder panel (files, tasks, git) for this chat — remembered per chat (⌘⇧E)' : 'Show the folder panel (files, tasks, git) for this chat — remembered per chat (⌘⇧E)'} onClick={toggleFiles}>
              <PanelRight size={15} />
            </button>
            <button className={`btn ghost icon ${record.pinned ? 'on' : ''}`} data-tip={record.pinned ? 'Unpin this session' : 'Pin this session to the top of its group (and to the Pinned section of the Recent view)'} onClick={() => window.api.sessions.setPinned(record.id, !record.pinned).catch(fail)}>
              {record.pinned ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
            {live?.processAlive ? (
              <button className="btn ghost icon" data-tip="Stop the Claude process and its background tasks (history is kept; the next message starts it again)" onClick={() => window.api.sessions.stop(record.id).catch(fail)}>
                <Power size={15} />
              </button>
            ) : (
              <button className="btn ghost icon" data-tip="Start the Claude process now (otherwise it starts with your next message)" onClick={() => window.api.sessions.start(record.id).catch(fail)}>
                <Play size={15} />
              </button>
            )}
            <button className="btn ghost icon" data-tip="More actions: rename, archive, move to group, change working directory, copy resume command, delete…" onClick={moreMenu}>
              <Ellipsis size={15} />
            </button>
          </span>
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
        <div className="chat-config">
          <PopupSelect label="model" value={currentModel} options={modelOptions} tip="Model used for this session's next turns. The list shows the full model ids." onChange={(v) => window.api.sessions.setModel(record.id, v).catch(fail)} minWidth={340} />
          <PopupSelect label="permissions" value={live?.permissionMode ?? record.permissionMode} options={modeOptions} tip="Permission mode: what Claude may do without asking. The list explains every mode." onChange={(v) => window.api.sessions.setPermissionMode(record.id, v as PermissionMode).catch(fail)} minWidth={380} />
          <PopupSelect label="effort" value={record.effort ?? ''} options={effortOptions} tip="Effort level: how much reasoning the model spends per turn (higher = slower, more thorough)" onChange={(v) => window.api.sessions.setEffort(record.id, v as EffortLevel | '').catch(fail)} minWidth={280} />
          <span className="spacer" />
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
        <div className="chat-status">
          <button className="cs-item gtag" style={gColor ? { color: gColor } : undefined} data-tip={group ? `Group "${group.name}" — click to move this session to another group or change the colour` : 'Not in a group — click to put it in one'} onClick={groupMenu}>
            ● {group ? group.name : 'no group'}
          </button>
          <button className="cs-item cwd" data-tip={`Working directory: ${record.cwd}\nClick to reveal it in Finder, right-click to copy the path`} onClick={() => window.api.shell.openPath(record.cwd).catch(fail)} onContextMenu={(e) => { e.preventDefault(); void window.api.shell.copy(record.cwd).then(() => toast('Path copied', 'success')) }}>
            <FolderOpen size={11} />
            <span className="ellipsis">{shortenPath(record.cwd, appInfo?.homeDir)}</span>
          </button>
          {gitBranch && (
            <button className="cs-item" data-tip={`Git branch ${gitBranch} — click to open the Git panel`} onClick={() => showPanelTab('git')}>
              <GitBranch size={11} /> {gitBranch}
              {gitInfo && (gitInfo.ahead || gitInfo.behind) ? <span className="faint">{gitInfo.ahead ? ` ↑${gitInfo.ahead}` : ''}{gitInfo.behind ? ` ↓${gitInfo.behind}` : ''}</span> : null}
            </button>
          )}
          {remoteLabel && (
            <button className="cs-item remote" data-tip={`Git remote ${gitInfo?.remoteName ?? 'origin'}: ${gitInfo?.remoteUrl ?? ''}${gitInfo?.remoteWebUrl ? '\nClick to open it in the browser' : ''}`} onClick={() => gitInfo?.remoteWebUrl && window.api.shell.openExternal(gitInfo.remoteWebUrl)}>
              <Github size={11} /> <span className="ellipsis">{remoteLabel}</span>
            </button>
          )}
          {dirInfo?.exists && dirInfo.bytes !== undefined && (
            <span className="cs-item" data-tip={`Size of the working directory (du -sk, refreshed after each turn and every 5 minutes; checked ${formatDateTime(dirInfo.checkedAt)})`}>
              <HardDrive size={11} /> {formatBytes(dirInfo.bytes)}
            </span>
          )}
          <span className="cs-item" data-tip={`Your last prompt: ${formatDateTime(lastPrompt)} (${timeAgo(lastPrompt)})\nThis is the time the sidebar orders sessions by.`}>
            <MessageSquare size={11} /> {formatDateTime(lastPrompt)} <span className="faint">({timeAgo(lastPrompt)})</span>
          </span>
          <span className="cs-item" data-tip={`Last activity in this chat (your prompts or Claude's messages): ${formatDateTime(lastAct)}`}>
            <Activity size={11} /> {timeAgo(lastAct)}
          </span>
          <span className="spacer" />
          <ContextBar sessionId={record.id} live={live} />
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
        {colorPick && group && (
          <GroupColorPicker x={colorPick.x} y={colorPick.y} color={group.color} title={`Colour of "${group.name}"`} onPick={(c) => window.api.sessions.setGroupColor(group.id, c).catch(fail)} onClose={() => setColorPick(null)} />
        )}
      </div>
    </ChatProvider>
  )
}
