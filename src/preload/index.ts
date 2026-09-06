import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  AppSettings,
  ChatMessage,
  CliSessionSummary,
  EffortLevel,
  FileContent,
  FileProbe,
  FsEntry,
  GitBranchInfo,
  GitCommitInfo,
  GitDiffResult,
  GitFileState,
  GitStatusResult,
  ImageAttachment,
  ModelInfoView,
  PermissionDecision,
  PermissionMode,
  SessionEvent,
  SessionLiveState,
  SessionRecord,
  SlashCommandView,
  ThemeInfo,
  UsageSnapshot
} from '@shared/types'

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!res.ok) throw new Error(res.error)
  return res.value
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export interface DiscardEntryArg {
  path: string
  origPath?: string
  index: GitFileState | null
  worktree: GitFileState | null
}

const api = {
  app: {
    info: () => invoke<AppInfo>('app:info'),
    envInfo: () => invoke<{ count: number; proxy: string[]; path: string }>('app:envInfo'),
    reloadEnv: () => invoke<number>('app:reloadEnv'),
    theme: () => invoke<ThemeInfo>('app:theme')
  },
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    set: (patch: Partial<AppSettings>) => invoke<AppSettings>('settings:set', patch)
  },
  usage: {
    get: () => invoke<UsageSnapshot>('usage:get'),
    refresh: () => invoke<UsageSnapshot>('usage:refresh')
  },
  sessions: {
    list: () => invoke<{ records: SessionRecord[]; live: SessionLiveState[] }>('sessions:list'),
    history: (id: string) => invoke<ChatMessage[]>('sessions:history', id),
    create: (opts: { cwd: string; title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | '' }) =>
      invoke<SessionRecord>('sessions:create', opts),
    importCli: (sessionId: string, cwd: string, title?: string) => invoke<SessionRecord>('sessions:importCli', sessionId, cwd, title),
    listCli: (dir?: string) => invoke<CliSessionSummary[]>('sessions:listCli', dir),
    send: (id: string, text: string, images?: ImageAttachment[]) => invoke<void>('sessions:send', id, text, images),
    start: (id: string) => invoke<void>('sessions:start', id),
    stop: (id: string) => invoke<void>('sessions:stop', id),
    interrupt: (id: string) => invoke<void>('sessions:interrupt', id),
    answerPermission: (id: string, requestId: string, decision: PermissionDecision) =>
      invoke<boolean>('sessions:answerPermission', id, requestId, decision),
    setModel: (id: string, model: string) => invoke<void>('sessions:setModel', id, model),
    setPermissionMode: (id: string, mode: PermissionMode) => invoke<void>('sessions:setPermissionMode', id, mode),
    setEffort: (id: string, level: EffortLevel | '') => invoke<void>('sessions:setEffort', id, level),
    rename: (id: string, title: string) => invoke<void>('sessions:rename', id, title),
    setPinned: (id: string, pinned: boolean) => invoke<void>('sessions:setPinned', id, pinned),
    setArchived: (id: string, archived: boolean) => invoke<void>('sessions:setArchived', id, archived),
    remove: (id: string, deleteTranscript: boolean) => invoke<void>('sessions:remove', id, deleteTranscript),
    setActive: (id: string | undefined) => invoke<void>('sessions:setActive', id),
    stopTask: (id: string, taskId: string) => invoke<void>('sessions:stopTask', id, taskId),
    backgroundTasks: (id: string, toolUseId?: string) => invoke<boolean>('sessions:backgroundTasks', id, toolUseId),
    commands: (id: string) => invoke<SlashCommandView[]>('sessions:commands', id),
    models: (id: string) => invoke<ModelInfoView[]>('sessions:models', id),
    contextUsage: (id: string, full?: boolean) => invoke<SessionLiveState['contextUsage'] | null>('sessions:contextUsage', id, full)
  },
  fs: {
    list: (dir: string, showHidden: boolean) => invoke<FsEntry[]>('fs:list', dir, showHidden),
    read: (file: string) => invoke<FileContent>('fs:read', file),
    probe: (file: string) => invoke<FileProbe>('fs:probe', file),
    exists: (p: string) => invoke<{ exists: boolean; isDir: boolean }>('fs:exists', p),
    resolve: (raw: string, cwd: string) => invoke<string>('fs:resolve', raw, cwd),
    watch: (dir: string) => invoke<void>('fs:watch', dir),
    unwatch: (dir: string) => invoke<void>('fs:unwatch', dir),
    home: () => invoke<string>('fs:home'),
    readImageBase64: (file: string) => invoke<string>('fs:readImageBase64', file),
    trash: (p: string) => invoke<void>('fs:trash', p)
  },
  shell: {
    openExternal: (url: string) => invoke<void>('shell:openExternal', url),
    openPath: (p: string) => invoke<string>('shell:openPath', p),
    openWith: (p: string) => invoke<boolean>('shell:openWith', p),
    showInFolder: (p: string) => invoke<void>('shell:showInFolder', p),
    openInEditor: (file: string, line?: number) => invoke<void>('shell:openInEditor', file, line),
    openTerminal: (dir: string) => invoke<void>('shell:openTerminal', dir),
    copy: (text: string) => invoke<void>('shell:copy', text)
  },
  git: {
    status: (cwd: string) => invoke<GitStatusResult>('git:status', cwd),
    stage: (cwd: string, paths: string[], force?: boolean) => invoke<void>('git:stage', cwd, paths, force),
    stageAll: (cwd: string) => invoke<void>('git:stageAll', cwd),
    unstage: (cwd: string, paths: string[]) => invoke<void>('git:unstage', cwd, paths),
    unstageAll: (cwd: string) => invoke<void>('git:unstageAll', cwd),
    untrack: (cwd: string, paths: string[]) => invoke<void>('git:untrack', cwd, paths),
    discard: (cwd: string, entries: DiscardEntryArg[]) => invoke<{ trashed: number }>('git:discard', cwd, entries),
    discardAll: (cwd: string) => invoke<void>('git:discardAll', cwd),
    delete: (cwd: string, absPaths: string[]) => invoke<void>('git:delete', cwd, absPaths),
    ignore: (cwd: string, relPaths: string[]) => invoke<string[]>('git:ignore', cwd, relPaths),
    commit: (cwd: string, message: string, opts?: { amend?: boolean; signoff?: boolean }) => invoke<string>('git:commit', cwd, message, opts ?? {}),
    push: (cwd: string) => invoke<string>('git:push', cwd),
    pull: (cwd: string, rebase?: boolean) => invoke<string>('git:pull', cwd, Boolean(rebase)),
    fetch: (cwd: string) => invoke<void>('git:fetch', cwd),
    log: (cwd: string, limit?: number) => invoke<GitCommitInfo[]>('git:log', cwd, limit ?? 30),
    diff: (cwd: string, relPath: string, staged: boolean) => invoke<GitDiffResult>('git:diff', cwd, relPath, staged),
    showCommit: (cwd: string, hash: string) => invoke<string>('git:showCommit', cwd, hash),
    branches: (cwd: string) => invoke<GitBranchInfo[]>('git:branches', cwd),
    checkout: (cwd: string, branch: string) => invoke<void>('git:checkout', cwd, branch),
    createBranch: (cwd: string, name: string) => invoke<void>('git:createBranch', cwd, name),
    init: (cwd: string) => invoke<void>('git:init', cwd),
    undoLastCommit: (cwd: string) => invoke<void>('git:undoLastCommit', cwd),
    revertCommit: (cwd: string, hash: string) => invoke<void>('git:revertCommit', cwd, hash),
    stash: (cwd: string) => invoke<void>('git:stash', cwd),
    stashPop: (cwd: string) => invoke<void>('git:stashPop', cwd),
    publish: (cwd: string, name: string, visibility: 'public' | 'private') => invoke<string>('git:publish', cwd, name, visibility)
  },
  dialog: {
    chooseDirectory: (defaultPath?: string) => invoke<string | null>('dialog:chooseDirectory', defaultPath),
    chooseFiles: () => invoke<string[]>('dialog:chooseFiles')
  },
  events: {
    onSessionEvent: (cb: (e: SessionEvent) => void) => on<SessionEvent>('session:event', cb),
    onFsChanged: (cb: (dir: string) => void) => on<string>('fs:changed', cb),
    onUsage: (cb: (s: UsageSnapshot) => void) => on<UsageSnapshot>('usage:update', cb),
    onTheme: (cb: (t: ThemeInfo) => void) => on<ThemeInfo>('theme:changed', cb),
    onSettingsChanged: (cb: (s: AppSettings) => void) => on<AppSettings>('settings:changed', cb),
    onMenu: (cb: (command: string) => void) => {
      const channels = [
        'menu:settings', 'menu:new-session', 'menu:import-session', 'menu:next-session', 'menu:prev-session',
        'menu:focus-composer', 'menu:toggle-sidebar', 'menu:toggle-files', 'menu:toggle-git', 'menu:search', 'menu:interrupt'
      ]
      const offs = channels.map((ch) => on<void>(ch, () => cb(ch)))
      return () => offs.forEach((off) => off())
    }
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
