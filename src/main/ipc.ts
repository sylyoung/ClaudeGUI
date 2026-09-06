import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { AppInfo, AppSettings, ImageAttachment, PermissionDecision, PermissionMode, EffortLevel } from '@shared/types'
import type { AppStore } from './store'
import type { SessionManager } from './sessions/SessionManager'
import { DirWatcher, listDir, pathExists, readFileContent, resolveMentionedPath } from './fsService'
import { openExternal, openInEditor, openPath, openTerminal, showItemInFolder } from './shellService'
import { getSpawnEnv, parseExtraEnv, resetLoginShellEnvCache, getLoginShellEnv } from './env'

export interface IpcContext {
  store: AppStore
  manager: SessionManager
  getWindow(): BrowserWindow | null
  resolveExecutable(): string
  sdkVersion: string
}

export function registerIpc(ctx: IpcContext): void {
  const { store, manager } = ctx
  const watcher = new DirWatcher((dir) => {
    ctx.getWindow()?.webContents.send('fs:changed', dir)
  })
  app.on('before-quit', () => watcher.closeAll())

  const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...(args as T)) }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err)
        console.error(`[ipc] ${channel} failed:`, message)
        return { ok: false, error: message }
      }
    })
  }

  // ---- app / settings
  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    sdkVersion: ctx.sdkVersion,
    userDataPath: app.getPath('userData'),
    claudeExecutable: ctx.resolveExecutable(),
    homeDir: os.homedir()
  }))
  handle('settings:get', () => store.settings.get())
  handle('settings:set', (patch: Partial<AppSettings>) => {
    store.settings.update((s) => ({ ...s, ...patch }))
    return store.settings.get()
  })
  handle('app:envInfo', async () => {
    const env = await getLoginShellEnv()
    const keys = Object.keys(env).sort()
    return { count: keys.length, proxy: keys.filter((k) => /proxy/i.test(k)).map((k) => `${k}=${env[k]}`), path: env.PATH ?? '' }
  })
  handle('app:reloadEnv', async () => {
    resetLoginShellEnvCache()
    const env = await getLoginShellEnv()
    return Object.keys(env).length
  })

  // ---- sessions
  handle('sessions:list', () => manager.list())
  handle('sessions:history', (id: string) => manager.history(id))
  handle('sessions:create', (opts: { cwd: string; title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | '' }) => manager.create(opts))
  handle('sessions:importCli', (sessionId: string, cwd: string, title?: string) => manager.importCli(sessionId, cwd, title))
  handle('sessions:listCli', (dir?: string) => manager.listCli(dir))
  handle('sessions:send', (id: string, text: string, images?: ImageAttachment[]) => manager.send(id, text, images))
  handle('sessions:start', (id: string) => manager.start(id))
  handle('sessions:stop', (id: string) => manager.stop(id))
  handle('sessions:interrupt', (id: string) => manager.interrupt(id))
  handle('sessions:answerPermission', (id: string, requestId: string, decision: PermissionDecision) => manager.answerPermission(id, requestId, decision))
  handle('sessions:setModel', (id: string, model: string) => manager.get(id).setModel(model))
  handle('sessions:setPermissionMode', (id: string, mode: PermissionMode) => manager.get(id).setPermissionMode(mode))
  handle('sessions:setEffort', (id: string, level: EffortLevel | '') => manager.get(id).setEffort(level))
  handle('sessions:rename', (id: string, title: string) => manager.rename(id, title))
  handle('sessions:setPinned', (id: string, pinned: boolean) => manager.setPinned(id, pinned))
  handle('sessions:setArchived', (id: string, archived: boolean) => manager.setArchived(id, archived))
  handle('sessions:remove', (id: string, deleteTranscript: boolean) => manager.remove(id, deleteTranscript))
  handle('sessions:setActive', (id: string | undefined) => manager.setActive(id))
  handle('sessions:stopTask', (id: string, taskId: string) => manager.get(id).stopTask(taskId))
  handle('sessions:backgroundTasks', (id: string, toolUseId?: string) => manager.get(id).backgroundTasks(toolUseId))
  handle('sessions:commands', (id: string) => manager.get(id).getCommands())
  handle('sessions:models', (id: string) => manager.get(id).getModels())
  handle('sessions:contextUsage', (id: string) => manager.get(id).getContextUsage())

  // ---- filesystem
  handle('fs:list', (dir: string, showHidden: boolean) => listDir(dir, showHidden))
  handle('fs:read', (file: string) => readFileContent(file))
  handle('fs:exists', (p: string) => pathExists(p))
  handle('fs:resolve', (raw: string, cwd: string) => resolveMentionedPath(raw, cwd, os.homedir()))
  handle('fs:watch', (dir: string) => watcher.watch(dir))
  handle('fs:unwatch', (dir: string) => watcher.unwatch(dir))
  handle('fs:home', () => os.homedir())
  handle('fs:readImageBase64', (file: string) => {
    const buf = fs.readFileSync(file)
    return buf.toString('base64')
  })

  // ---- shell
  handle('shell:openExternal', (url: string) => openExternal(url))
  handle('shell:openPath', (p: string) => openPath(p))
  handle('shell:showInFolder', (p: string) => showItemInFolder(p))
  handle('shell:openInEditor', async (file: string, line?: number) => {
    const env = await getSpawnEnv(parseExtraEnv(store.settings.get().extraEnv))
    const cmd = store.settings.get().editorCommand || 'open -t {path}'
    openInEditor(cmd, file, line, env)
  })
  handle('shell:openTerminal', async (dir: string) => openTerminal(dir, await getSpawnEnv()))
  handle('shell:copy', (text: string) => clipboard.writeText(text))

  // ---- dialogs
  handle('dialog:chooseDirectory', async (defaultPath?: string) => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined as never, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || path.join(os.homedir(), 'Workspace')
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })
  handle('dialog:chooseFiles', async () => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win ?? undefined as never, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    if (res.canceled) return []
    return res.filePaths
  })
}
