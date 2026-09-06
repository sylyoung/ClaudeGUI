import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { AppInfo, AppSettings, EffortLevel, ImageAttachment, PermissionDecision, PermissionMode, ThemeInfo } from '@shared/types'
import type { AppStore } from './store'
import { splitList } from './store'
import type { SessionManager } from './sessions/SessionManager'
import type { UsageService } from './usageService'
import { DirWatcher, listDir, pathExists, probeFile, readFileContent, resolveMentionedPath } from './fsService'
import { openExternal, openInEditor, openPath, openTerminal, openWithApp, showItemInFolder } from './shellService'
import { getSpawnEnv, parseExtraEnv, resetLoginShellEnvCache, getLoginShellEnv } from './env'
import * as gitSvc from './gitService'

export interface IpcContext {
  store: AppStore
  manager: SessionManager
  usage: UsageService
  getWindow(): BrowserWindow | null
  resolveExecutable(): string
  sdkVersion: string
  getThemeInfo(): ThemeInfo
  onSettingsChanged(prev: AppSettings, next: AppSettings): void
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

  const settings = () => store.settings.get()
  const env = () => getSpawnEnv(parseExtraEnv(settings().extraEnv))

  // ---- app / settings
  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    sdkVersion: ctx.sdkVersion,
    userDataPath: app.getPath('userData'),
    claudeExecutable: ctx.resolveExecutable(),
    homeDir: os.homedir()
  }))
  handle('app:theme', () => ctx.getThemeInfo())
  handle('settings:get', () => settings())
  handle('settings:set', (patch: Partial<AppSettings>) => {
    const prev = settings()
    const next = store.settings.update((s) => ({ ...s, ...patch }))
    ctx.onSettingsChanged(prev, next)
    return next
  })
  handle('app:envInfo', async () => {
    const e = await getLoginShellEnv()
    const keys = Object.keys(e).sort()
    return { count: keys.length, proxy: keys.filter((k) => /proxy/i.test(k)).map((k) => `${k}=${e[k]}`), path: e.PATH ?? '' }
  })
  handle('app:reloadEnv', async () => {
    resetLoginShellEnvCache()
    const e = await getLoginShellEnv()
    return Object.keys(e).length
  })

  // ---- plan usage
  handle('usage:get', () => ctx.usage.snapshot)
  handle('usage:refresh', () => ctx.usage.refresh('manual'))

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
  handle('sessions:contextUsage', (id: string, full?: boolean) => manager.get(id).refreshContextUsage(full ? 'full' : 'summary'))

  // ---- filesystem
  handle('fs:list', (dir: string, showHidden: boolean) => listDir(dir, showHidden, splitList(settings().excludePatterns)))
  handle('fs:read', (file: string) => readFileContent(file, Math.max(64, settings().maxPreviewKB || 1500) * 1024))
  handle('fs:probe', (file: string) => probeFile(file))
  handle('fs:exists', (p: string) => pathExists(p))
  handle('fs:resolve', (raw: string, cwd: string) => resolveMentionedPath(raw, cwd, os.homedir()))
  handle('fs:watch', (dir: string) => watcher.watch(dir))
  handle('fs:unwatch', (dir: string) => watcher.unwatch(dir))
  handle('fs:home', () => os.homedir())
  handle('fs:readImageBase64', (file: string) => fs.readFileSync(file).toString('base64'))
  handle('fs:trash', (p: string) => shell.trashItem(p))

  // ---- shell
  handle('shell:openExternal', (url: string) => openExternal(url))
  handle('shell:openPath', (p: string) => openPath(p))
  handle('shell:showInFolder', (p: string) => showItemInFolder(p))
  handle('shell:openInEditor', async (file: string, line?: number) => {
    const cmd = settings().editorCommand || 'open -t {path}'
    openInEditor(cmd, file, line, await env())
  })
  handle('shell:openWith', async (file: string) => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win ?? (undefined as never), {
      title: `Open ${path.basename(file)} with…`,
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['app'] }]
    })
    if (res.canceled || !res.filePaths.length) return false
    openWithApp(res.filePaths[0], file, await env())
    return true
  })
  handle('shell:openTerminal', async (dir: string) => openTerminal(dir, await getSpawnEnv()))
  handle('shell:copy', (text: string) => clipboard.writeText(text))

  // ---- git (every call takes the session working directory; the repo root is derived from it)
  const root = async (cwd: string) => {
    const r = await gitSvc.repoRoot(cwd, await env())
    if (!r) throw new Error('Not a git repository')
    return r
  }
  handle('git:status', async (cwd: string) => gitSvc.getStatus(cwd, await env()))
  handle('git:stage', async (cwd: string, paths: string[], force?: boolean) => gitSvc.stage(await root(cwd), paths, await env(), Boolean(force)))
  handle('git:stageAll', async (cwd: string) => gitSvc.stageAll(await root(cwd), await env()))
  handle('git:unstage', async (cwd: string, paths: string[]) => gitSvc.unstage(await root(cwd), paths, await env()))
  handle('git:unstageAll', async (cwd: string) => gitSvc.unstageAll(await root(cwd), await env()))
  handle('git:untrack', async (cwd: string, paths: string[]) => gitSvc.untrack(await root(cwd), paths, await env()))
  handle('git:discard', async (cwd: string, entries: gitSvc.DiscardEntry[]) => gitSvc.discard(await root(cwd), entries, await env()))
  handle('git:discardAll', async (cwd: string) => gitSvc.discardAll(await root(cwd), await env()))
  handle('git:delete', async (cwd: string, absPaths: string[]) => gitSvc.deletePaths(await root(cwd), absPaths, await env()))
  handle('git:ignore', async (cwd: string, relPaths: string[]) => gitSvc.addToGitignore(await root(cwd), relPaths))
  handle('git:commit', async (cwd: string, message: string, opts: { amend?: boolean; signoff?: boolean }) => gitSvc.commit(await root(cwd), message, opts ?? {}, await env()))
  handle('git:push', async (cwd: string) => {
    const e = await env()
    const r = await root(cwd)
    const info = await gitSvc.getInfo(r, e)
    return gitSvc.push(r, info, e)
  })
  handle('git:pull', async (cwd: string, rebase: boolean) => gitSvc.pull(await root(cwd), rebase, await env()))
  handle('git:fetch', async (cwd: string) => gitSvc.fetch(await root(cwd), await env()))
  handle('git:log', async (cwd: string, limit: number) => gitSvc.log(await root(cwd), limit, await env()))
  handle('git:diff', async (cwd: string, relPath: string, staged: boolean) => gitSvc.diff(await root(cwd), relPath, staged, await env()))
  handle('git:showCommit', async (cwd: string, hash: string) => gitSvc.showCommit(await root(cwd), hash, await env()))
  handle('git:branches', async (cwd: string) => gitSvc.branches(await root(cwd), await env()))
  handle('git:checkout', async (cwd: string, branch: string) => gitSvc.checkout(await root(cwd), branch, await env()))
  handle('git:createBranch', async (cwd: string, name: string) => gitSvc.createBranch(await root(cwd), name, await env()))
  handle('git:init', async (cwd: string) => gitSvc.init(cwd, await env()))
  handle('git:undoLastCommit', async (cwd: string) => gitSvc.undoLastCommit(await root(cwd), await env()))
  handle('git:revertCommit', async (cwd: string, hash: string) => gitSvc.revertCommit(await root(cwd), hash, await env()))
  handle('git:stash', async (cwd: string) => gitSvc.stashPush(await root(cwd), await env()))
  handle('git:stashPop', async (cwd: string) => gitSvc.stashPop(await root(cwd), await env()))
  handle('git:publish', async (cwd: string, name: string, visibility: 'public' | 'private') => gitSvc.publish(await root(cwd), name, visibility, await env()))

  // ---- dialogs
  handle('dialog:chooseDirectory', async (defaultPath?: string) => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win ?? (undefined as never), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || settings().defaultCwd || path.join(os.homedir(), 'Workspace')
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })
  handle('dialog:chooseFiles', async () => {
    const win = ctx.getWindow()
    const res = await dialog.showOpenDialog(win ?? (undefined as never), {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    if (res.canceled) return []
    return res.filePaths
  })
}
