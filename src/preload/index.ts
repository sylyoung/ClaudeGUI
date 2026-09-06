import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  AppSettings,
  ChatMessage,
  CliSessionSummary,
  EffortLevel,
  FileContent,
  FsEntry,
  ImageAttachment,
  ModelInfoView,
  PermissionDecision,
  PermissionMode,
  SessionEvent,
  SessionLiveState,
  SessionRecord,
  SlashCommandView
} from '@shared/types'

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!res.ok) throw new Error(res.error)
  return res.value
}

const api = {
  app: {
    info: () => invoke<AppInfo>('app:info'),
    envInfo: () => invoke<{ count: number; proxy: string[]; path: string }>('app:envInfo'),
    reloadEnv: () => invoke<number>('app:reloadEnv')
  },
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    set: (patch: Partial<AppSettings>) => invoke<AppSettings>('settings:set', patch)
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
    contextUsage: (id: string) => invoke<unknown>('sessions:contextUsage', id)
  },
  fs: {
    list: (dir: string, showHidden: boolean) => invoke<FsEntry[]>('fs:list', dir, showHidden),
    read: (file: string) => invoke<FileContent>('fs:read', file),
    exists: (p: string) => invoke<{ exists: boolean; isDir: boolean }>('fs:exists', p),
    resolve: (raw: string, cwd: string) => invoke<string>('fs:resolve', raw, cwd),
    watch: (dir: string) => invoke<void>('fs:watch', dir),
    unwatch: (dir: string) => invoke<void>('fs:unwatch', dir),
    home: () => invoke<string>('fs:home'),
    readImageBase64: (file: string) => invoke<string>('fs:readImageBase64', file)
  },
  shell: {
    openExternal: (url: string) => invoke<void>('shell:openExternal', url),
    openPath: (p: string) => invoke<string>('shell:openPath', p),
    showInFolder: (p: string) => invoke<void>('shell:showInFolder', p),
    openInEditor: (file: string, line?: number) => invoke<void>('shell:openInEditor', file, line),
    openTerminal: (dir: string) => invoke<void>('shell:openTerminal', dir),
    copy: (text: string) => invoke<void>('shell:copy', text)
  },
  dialog: {
    chooseDirectory: (defaultPath?: string) => invoke<string | null>('dialog:chooseDirectory', defaultPath),
    chooseFiles: () => invoke<string[]>('dialog:chooseFiles')
  },
  events: {
    onSessionEvent: (cb: (e: SessionEvent) => void) => {
      const listener = (_: unknown, e: SessionEvent) => cb(e)
      ipcRenderer.on('session:event', listener)
      return () => { ipcRenderer.removeListener('session:event', listener) }
    },
    onFsChanged: (cb: (dir: string) => void) => {
      const listener = (_: unknown, dir: string) => cb(dir)
      ipcRenderer.on('fs:changed', listener)
      return () => { ipcRenderer.removeListener('fs:changed', listener) }
    },
    onMenu: (cb: (command: string) => void) => {
      const channels = [
        'menu:settings', 'menu:new-session', 'menu:import-session', 'menu:next-session', 'menu:prev-session',
        'menu:focus-composer', 'menu:toggle-sidebar', 'menu:toggle-files', 'menu:search', 'menu:interrupt'
      ]
      const listeners = channels.map((ch) => {
        const l = () => cb(ch)
        ipcRenderer.on(ch, l)
        return () => { ipcRenderer.removeListener(ch, l) }
      })
      return () => listeners.forEach((off) => off())
    }
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
