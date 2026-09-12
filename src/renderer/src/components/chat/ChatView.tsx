import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertTriangle, Bot, ChevronDown, ChevronsDownUp, ChevronsUpDown, Code, Ellipsis, FileDiff, FolderOpen, GitBranch, Github, HardDrive, MessageSquare, PanelRight, Pin, PinOff, Play, Power, Square, TerminalSquare, Upload } from 'lucide-react'
import type { DirInfo, EffortLevel, PermissionDecision, PermissionMode, SessionLiveState, SessionRecord } from '@shared/types'
import { groupColorFor } from '@shared/colors'
import { lastPromptOf } from '@shared/util'
import { useStore } from '@/store'
import { PopupSelect, type PopupOption } from '../common/PopupSelect'
import { GroupColorPicker } from '../common/GroupColorPicker'
import { isDarkTheme } from '@/lib/theme'
import { isComposing } from '@/lib/keys'
import { openFileFromClick } from '@/lib/openFiles'
import { MessageList } from './MessageList'
import { StateMark } from '../common/StateMark'
import { Composer } from './Composer'
import { ContextBar } from './ContextBar'
import { ChatProvider, type ChatCtx } from './ChatContext'
import { ContextMenu, type MenuItem } from '../common/ContextMenu'
import { RewindDialog } from '../dialogs/RewindDialog'
import { RewindPicker } from '../dialogs/RewindPicker'
import { UsageStatus } from '../status/UsageStatus'
import { formatBytes, formatDateTime, modelFamily, modelLabel, shortenPath, timeAgo } from '@/lib/format'
import { visualState } from '@/lib/sessionState'
import { sessionMenuItems } from '@/lib/sessionMenu'

import { CYCLE_MODES, EFFORTS, EFFORT_LABELS, EFFORT_SHORT, MODES } from '@/lib/options'

const EMPTY_MESSAGES: never[] = []
/** Folder-size thresholds of the status row: amber above 5 GB, red above 20 GB. */
const GB = 1024 * 1024 * 1024
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
  const gitBranch = useStore((s) => s.git[record.id]?.status?.info.branch)
  const gitInfo = useStore((s) => s.git[record.id]?.status?.info)
  const gitConflicts = useStore((s) => {
    const st = s.git[record.id]?.status
    return st?.files.some((f) => f.index === 'conflicted' || f.worktree === 'conflicted') ?? false
  })
  const gitChanges = useStore((s) => {
    const st = s.git[record.id]?.status
    if (!st?.info.isRepo) return 0
    return st.files.filter((f) => f.worktree !== 'ignored' && (f.index || f.worktree)).length
  })
  const refreshGit = useStore((s) => s.refreshGit)
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
  /** Prompt the rewind window is open for. */
  const [rewindId, setRewindId] = useState<string | null>(null)
  /** The list of earlier prompts that a double tap on Escape opens. */
  const [pickRewind, setPickRewind] = useState(false)
  const toolDetailsMode = useStore((s) => s.toolDetails)
  const toolCardsExpanded = useStore((s) => s.settings?.toolCardsExpanded ?? false)
  const toolDetails = toolDetailsMode ? toolDetailsMode === 'expand' : toolCardsExpanded
  const setToolDetails = useStore((s) => s.setToolDetails)
  const [editingTitle, setEditingTitle] = useState(false)
  const titleRef = useRef<HTMLSpanElement>(null)

  const status = live?.status ?? 'stopped'
  const dirInfo = useDirInfo(record.cwd, live?.status)

  // Renaming: put the caret in the title and select it, otherwise "Rename…" looks like it does
  // nothing. When not editing, the element's text is kept equal to the stored title (React does
  // not reliably re-render the children of a contentEditable element).
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    if (!editingTitle) {
      if (el.textContent !== record.title) el.textContent = record.title
      return
    }
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, [editingTitle, record.title])

  const openPath = useCallback<ChatCtx['openPath']>(
    async (raw, line, opts) => {
      try {
        const abs = await window.api.fs.locate(raw, record.cwd)
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
        } else await openFileFromClick(record.id, abs, line, probe.kind)
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    },
    [record.cwd, record.id, toast, toggleExpanded, setRevealPath, setFilesOpen]
  )

  const showPathMenu = useCallback<ChatCtx['showPathMenu']>(
    (raw, line, x, y) => {
      const resolve = () => window.api.fs.locate(raw, record.cwd)
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

  const rewindTo = useCallback((messageId: string) => setRewindId(messageId), [])
  const takeBackPrompt = useCallback<ChatCtx['takeBackPrompt']>(
    (messageId) => void useStore.getState().takeBackQueued(record.id, messageId, true),
    [record.id]
  )
  const waitingIds = live?.queuedIds
  const showPromptMenu = useCallback<ChatCtx['showPromptMenu']>(
    (messageId, text, x, y) => {
      const waiting = (waitingIds ?? []).includes(messageId)
      setMenu({
        x,
        y,
        items: [
          waiting
            ? { label: 'Take this prompt back out of the queue', onClick: () => takeBackPrompt(messageId) }
            : { label: 'Rewind the chat to here…', onClick: () => setRewindId(messageId) },
          { label: '', onClick: () => undefined, separator: true },
          { label: 'Copy this prompt', onClick: async () => { await window.api.shell.copy(text); toast('Prompt copied', 'success') } },
          { label: 'Put it back in the input box', onClick: () => useStore.getState().restoreComposer(record.id, text) }
        ]
      })
    },
    [record.id, toast, waitingIds, takeBackPrompt]
  )
  const ctx = useMemo<ChatCtx>(
    () => ({ sessionId: record.id, cwd: record.cwd, openPath, showPathMenu, rewindTo, showPromptMenu, takeBackPrompt }),
    [record.id, record.cwd, openPath, showPathMenu, rewindTo, showPromptMenu, takeBackPrompt]
  )

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
      if (e.key === 'Enter' && e.metaKey && !isComposing(e) && live?.pendingPermissions?.length && !(e.target instanceof HTMLTextAreaElement)) {
        const p = live.pendingPermissions[0]
        if (p.toolName !== 'AskUserQuestion') onAnswer(p.requestId, { behavior: 'allow' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [live?.pendingPermissions, onAnswer])

  /**
   * The keys the chat window in the terminal has: Escape stops the turn that is running, a second
   * Escape within a moment opens the list of earlier prompts to rewind to, and ⇧⇥ steps through the
   * permission modes. A dialog that is open owns Escape itself, and the command menu in the input
   * box stops its own Escape from reaching here, so neither counts as a tap.
   */
  const escAt = useRef(0)
  const running = status === 'running' || status === 'requires_action'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the candidate list of an input method; it must not also stop the turn.
      if (isComposing(e)) return
      if (e.key === 'Escape' && !e.repeat) {
        if (useStore.getState().dialog || rewindId || pickRewind) return
        const doubleTap = Date.now() - escAt.current < 700
        escAt.current = doubleTap ? 0 : Date.now()
        if (doubleTap) setPickRewind(true)
        else if (running) onInterrupt()
        return
      }
      if (e.key === 'Tab' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (useStore.getState().dialog || rewindId || pickRewind) return
        e.preventDefault()
        const current = live?.permissionMode ?? record.permissionMode
        const i = CYCLE_MODES.indexOf(current as PermissionMode)
        const next = CYCLE_MODES[(i + 1) % CYCLE_MODES.length]
        window.api.sessions
          .setPermissionMode(record.id, next)
          .then(() => toast(`Permission mode: ${MODES.find((m) => m.value === next)?.label ?? next}`, 'info'))
          .catch((err) => toast((err as Error).message, 'error'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onInterrupt, rewindId, pickRewind, live?.permissionMode, record.id, record.permissionMode, toast])

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
  const [pushing, setPushing] = useState(false)
  // Commit and push straight from the chat, without hunting for the Git tab first.
  const pushNow = async () => {
    setPushing(true)
    try {
      await window.api.git.push(record.cwd)
      toast('Pushed', 'success')
      void refreshGit(record.id, { log: true })
    } catch (err) {
      fail(err)
    } finally {
      setPushing(false)
    }
  }

  const statusPill = (() => {
    const tip = vs.description
    switch (vs.key) {
      case 'working': return <span className="pill blue" data-tip={tip}><StateMark state="working" /> working</span>
      case 'permission': return <span className="pill amber" data-tip={tip}><StateMark state="permission" /> permission</span>
      case 'option': return <span className="pill red" data-tip={tip}><StateMark state="option" /> option</span>
      case 'unread': return <span className="pill pink" data-tip={tip}><StateMark state="unread" /> unread</span>
      case 'starting': return <span className="pill blue" data-tip={tip}><StateMark state="starting" /> starting</span>
      case 'idle-tasks': return <span className="pill teal" data-tip={tip}><StateMark state="idle-tasks" /> idle · tasks running</span>
      case 'idle': return <span className="pill grey" data-tip={tip}><StateMark state="idle" /> idle</span>
      case 'error': return <span className="pill red" data-tip={tip}><StateMark state="error" /> error</span>
      default: return <span className="pill grey" data-tip={tip}><StateMark state="stopped" /> not running</span>
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
  const working = status === 'running' || status === 'starting'
  // Start of the running turn, as far as the chat can tell: your last own prompt.
  const lastTurnStart = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.kind === 'user' && !m.synthetic) return m.ts
    }
    return 0
  })()
  return (
    <ChatProvider value={ctx}>
      <div className={`chat ${working ? 'is-working' : ''}`}>
        <div className="chat-header drag" style={{ paddingLeft: headerInset }}>
          <span
            ref={titleRef}
            className="title no-drag"
            contentEditable={editingTitle}
            suppressContentEditableWarning
            onDoubleClick={() => setEditingTitle(true)}
            onBlur={(e) => {
              const t = e.currentTarget.textContent?.trim()
              setEditingTitle(false)
              if (t && t !== record.title) window.api.sessions.rename(record.id, t).catch(fail)
              else e.currentTarget.textContent = record.title
            }}
            onKeyDown={(e) => {
              if (isComposing(e)) return
              if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur() }
              if (e.key === 'Escape') { e.currentTarget.textContent = record.title; setEditingTitle(false); (e.currentTarget as HTMLElement).blur() }
            }}
            data-tip="Double-click to rename this chat (Enter saves, Escape cancels)"
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
            <button className="btn ghost icon" data-tip="Fork this chat: copy the conversation into a new chat in the same folder, as Claude Code's /branch does (you can also type /branch). The original chat is not changed." onClick={() => void useStore.getState().forkSession(record.id)}>
              <GitBranch size={15} />
            </button>
            <button
              className="btn ghost icon"
              data-tip={toolDetails ? 'Hide the details of every tool operation in this chat' : 'Show the details of every tool operation in this chat'}
              onClick={() => setToolDetails(!toolDetails)}
            >
              {toolDetails ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
            </button>
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
          <PopupSelect className={`m-${modelFamily(live?.model || record.model || record.lastModel)}`} label="model" value={currentModel} options={modelOptions} tip="Model used for this session's next turns. The list shows the full model ids." onChange={(v) => window.api.sessions.setModel(record.id, v).catch(fail)} minWidth={340} />
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
            <button className={`cs-item ${gitConflicts ? 'level-high' : (gitInfo?.ahead || gitInfo?.behind) ? 'level-warn' : ''}`} data-tip={`Git branch ${gitBranch} — click to open the Git panel`} onClick={() => showPanelTab('git')}>
              <GitBranch size={11} /> {gitBranch}
              {gitInfo && (gitInfo.ahead || gitInfo.behind) ? <span className="faint">{gitInfo.ahead ? ` ↑${gitInfo.ahead}` : ''}{gitInfo.behind ? ` ↓${gitInfo.behind}` : ''}</span> : null}
            </button>
          )}
          {gitChanges > 0 && (
            <button className="cs-item" data-tip={`${gitChanges} changed file${gitChanges === 1 ? '' : 's'} — click to open the Git panel and write a commit message`} onClick={() => showPanelTab('git')}>
              <FileDiff size={11} /> {gitChanges} to commit
            </button>
          )}
          {(gitInfo?.ahead ?? 0) > 0 && (
            <button className="cs-item push" disabled={pushing} data-tip={`${gitInfo?.ahead} commit${gitInfo?.ahead === 1 ? '' : 's'} not pushed${gitInfo?.remoteName ? ` to ${gitInfo.remoteName}` : ''} — click to push now`} onClick={() => void pushNow()}>
              <Upload size={11} /> {pushing ? 'pushing…' : `push ${gitInfo?.ahead}`}
            </button>
          )}
          {remoteLabel && (
            <button className="cs-item remote" data-tip={`Git remote ${gitInfo?.remoteName ?? 'origin'}: ${gitInfo?.remoteUrl ?? ''}${gitInfo?.remoteWebUrl ? '\nClick to open it in the browser' : ''}`} onClick={() => gitInfo?.remoteWebUrl && window.api.shell.openExternal(gitInfo.remoteWebUrl)}>
              <Github size={11} /> <span className="ellipsis">{remoteLabel}</span>
            </button>
          )}
          {dirInfo?.exists && dirInfo.bytes !== undefined && (
            <span className={`cs-item ${dirInfo.bytes > 20 * GB ? 'level-high' : dirInfo.bytes > 5 * GB ? 'level-warn' : ''}`} data-tip={`Size of the working directory (du -sk, refreshed after each turn and every 5 minutes; checked ${formatDateTime(dirInfo.checkedAt)})${dirInfo.bytes > 5 * GB ? '\nAmber above 5 GB, red above 20 GB.' : ''}`}>
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
        <MessageList sessionId={record.id} messages={messages} live={live} pending={live?.pendingPermissions ?? []} onAnswer={onAnswer} loaded={loaded} working={working} turnStartedAt={lastTurnStart} />
        {live?.error && status === 'error' && (
          <div className="msg-system error" style={{ margin: '0 20px 8px' }}>
            <ChevronDown size={14} />
            <div className="body">Process error: {live.error}. Sending a message restarts the session.</div>
          </div>
        )}
        <Composer sessionId={record.id} live={live} onSend={onSend} onInterrupt={onInterrupt} />
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        {rewindId && <RewindDialog sessionId={record.id} messageId={rewindId} onClose={() => setRewindId(null)} />}
        {pickRewind && (
          <RewindPicker
            sessionId={record.id}
            onPick={(messageId) => { setPickRewind(false); setRewindId(messageId) }}
            onClose={() => setPickRewind(false)}
          />
        )}
        {colorPick && group && (
          <GroupColorPicker x={colorPick.x} y={colorPick.y} color={group.color} title={`Colour of "${group.name}"`} onPick={(c) => window.api.sessions.setGroupColor(group.id, c).catch(fail)} onClose={() => setColorPick(null)} />
        )}
      </div>
    </ChatProvider>
  )
}
