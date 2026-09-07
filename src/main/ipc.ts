import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import type { AppInfo, AppSettings, DirInfo, EffortLevel, HostStatus, ImageAttachment, PermissionDecision, PermissionMode, SessionMove, StartupNotice, ThemeInfo } from '@shared/types'
import { splitList } from '@shared/util'
import type { SettingsStore } from './store'
import type { HostClient } from './hostClient'
import type { UsageService } from './usageService'
import type { Updater } from './updater'
import type { PermissionService } from './permissions'
import { DirWatcher, listDir, pathExists, probeFile, readFileContent, resolveMentionedPath } from './fsService'
import { openExternal, openInEditor, openPath, openTerminal, openWithApp, showItemInFolder } from './shellService'
import { getSpawnEnv, parseExtraEnv, resetLoginShellEnvCache, getLoginShellEnv } from './env'
import * as gitSvc from './gitService'

export interface IpcContext {
  store: SettingsStore
  host: HostClient
  usage: UsageService
  updater: Updater
  permissions: PermissionService
  getWindow(): BrowserWindow | null
  resolveExecutable(): string
  sdkVersion: string
  bundlePath: string | undefined
  logFile: string
  getThemeInfo(): ThemeInfo
  onSettingsChanged(prev: AppSettings, next: AppSettings): void
  takeStartupNotice(): StartupNotice | null
  replaceHost(): Promise<void>
  broadcast(channel: string, payload: unknown): void
}

export function registerIpc(ctx: IpcContext): void {
  const { store, host, updater } = ctx
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

  const settings = () => store.get()
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
    homeDir: os.homedir(),
    packaged: app.isPackaged,
    bundlePath: ctx.bundlePath,
    logFile: ctx.logFile
  }))
  handle('app:theme', () => ctx.getThemeInfo())
  handle('app:startupNotice', () => ctx.takeStartupNotice())
  handle('settings:get', () => settings())
  handle('settings:set', (patch: Partial<AppSettings>) => {
    const prev = settings()
    const next = store.update((s) => ({ ...s, ...patch }))
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
    if (host.connected) await host.reloadEnv().catch(() => undefined)
    return Object.keys(e).length
  })

  // ---- plan usage
  handle('usage:get', () => ctx.usage.snapshot)
  handle('usage:refresh', () => ctx.usage.refresh('manual'))

  // ---- session host
  handle('host:status', async (): Promise<HostStatus> => {
    if (!host.connected) return host.status
    try {
      const info = await host.info()
      return { ...host.status, aliveSessions: info.aliveSessions, pid: info.pid, version: info.version, startedAt: info.startedAt, logFile: info.logFile }
    } catch {
      return host.status
    }
  })
  handle('host:restart', async () => {
    const alive = host.connected ? await host.aliveCount() : 0
    if (alive > 0) throw new Error(`${alive} session(s) are still running; stop them first`)
    await ctx.replaceHost()
  })

  // ---- updates
  handle('update:state', () => updater.state)
  handle('update:check', () => updater.check())
  handle('update:install', () => updater.install())
  handle('update:apply', () => updater.apply())
  handle('update:cancel', () => updater.cancel())
  handle('update:openLog', async () => {
    if (fs.existsSync(updater.logFile)) await shell.openPath(updater.logFile)
    else throw new Error('No update log yet')
  })
  handle('update:openWorkDir', async () => {
    fs.mkdirSync(updater.workDir, { recursive: true })
    await shell.openPath(updater.workDir)
  })

  // ---- sessions (all forwarded to the session host process)
  handle('sessions:list', () => host.list())
  handle('sessions:history', (id: string) => host.history(id))
  handle('sessions:create', async (opts: { cwd: string; title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel | '' }) => {
    const record = await host.create(opts)
    store.addRecentDirectory(record.cwd)
    return record
  })
  handle('sessions:importCli', async (sessionId: string, cwd: string, title?: string) => {
    const record = await host.importCli(sessionId, cwd, title)
    store.addRecentDirectory(record.cwd)
    return record
  })
  handle('sessions:listCli', (dir?: string) => host.listCli(dir))
  handle('sessions:send', (id: string, text: string, images?: ImageAttachment[]) => host.send(id, text, images))
  handle('sessions:start', (id: string) => host.start(id))
  handle('sessions:stop', (id: string) => host.stop(id))
  handle('sessions:interrupt', (id: string) => host.interrupt(id))
  handle('sessions:cancelQueued', (id: string, messageId: string) => host.cancelQueued(id, messageId))
  handle('sessions:rewindPreview', (id: string, messageId: string) => host.rewindPreview(id, messageId))
  handle('sessions:rewind', (id: string, messageId: string, restoreFiles: boolean) => host.rewind(id, messageId, restoreFiles))
  handle('sessions:answerPermission', (id: string, requestId: string, decision: PermissionDecision) => host.answerPermission(id, requestId, decision))
  handle('sessions:setModel', (id: string, model: string) => host.setModel(id, model))
  handle('sessions:setPermissionMode', (id: string, mode: PermissionMode) => host.setPermissionMode(id, mode))
  handle('sessions:setEffort', (id: string, level: EffortLevel | '') => host.setEffort(id, level))
  handle('sessions:rename', (id: string, title: string) => host.rename(id, title))
  handle('sessions:setPinned', (id: string, pinned: boolean) => host.setPinned(id, pinned))
  handle('sessions:setArchived', (id: string, archived: boolean) => host.setArchived(id, archived))
  handle('sessions:remove', (id: string, deleteTranscript: boolean) => host.remove(id, deleteTranscript))
  handle('sessions:setActive', (id: string | undefined) => host.setActive(id))
  handle('sessions:stopTask', (id: string, taskId: string) => host.stopTask(id, taskId))
  handle('sessions:backgroundTasks', (id: string, toolUseId?: string) => host.backgroundTasks(id, toolUseId))
  handle('sessions:commands', (id: string) => host.commands(id))
  handle('sessions:models', (id: string) => host.models(id))
  handle('sessions:contextUsage', (id: string, full?: boolean) => host.contextUsage(id, full))
  handle('sessions:createGroup', (name: string, color?: string) => host.createGroup(name, color))
  handle('sessions:setGroupColor', (id: string, color: string) => host.setGroupColor(id, color))
  handle('sessions:renameGroup', (id: string, name: string) => host.renameGroup(id, name))
  handle('sessions:deleteGroup', (id: string) => host.deleteGroup(id))
  handle('sessions:setGroupCollapsed', (id: string, collapsed: boolean) => host.setGroupCollapsed(id, collapsed))
  handle('sessions:moveGroup', (id: string, beforeId?: string) => host.moveGroup(id, beforeId))
  handle('sessions:moveSession', (id: string, move: SessionMove) => host.moveSession(id, move))
  handle('sessions:relocate', async (id: string, cwd?: string) => {
    let target = cwd
    if (!target) {
      const win = ctx.getWindow()
      const current = (await host.list()).records.find((r) => r.id === id)
      const res = await dialog.showOpenDialog(win ?? (undefined as never), {
        title: 'Choose the new working directory for this session',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: current ? path.dirname(current.cwd) : settings().defaultCwd || os.homedir()
      })
      if (res.canceled || !res.filePaths.length) return null
      target = res.filePaths[0]
    }
    return host.relocate(id, target)
  })

  // ---- working directory size (du), cached per folder for five minutes
  const dirCache = new Map<string, DirInfo>()
  handle('fs:dirInfo', async (dir: string, force?: boolean): Promise<DirInfo> => {
    const cached = dirCache.get(dir)
    if (cached && !force && Date.now() - cached.checkedAt < 5 * 60_000) return cached
    if (!fs.existsSync(dir)) {
      const info: DirInfo = { path: dir, exists: false, checkedAt: Date.now() }
      dirCache.set(dir, info)
      return info
    }
    const info = await new Promise<DirInfo>((resolve) => {
      execFile('/usr/bin/du', ['-sk', '-x', dir], { timeout: 45_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        const m = /^(\d+)/.exec(String(stdout || '').trim())
        const kb = m ? Number(m[1]) : undefined
        resolve({ path: dir, exists: true, bytes: kb !== undefined ? kb * 1024 : undefined, checkedAt: Date.now(), partial: Boolean(err) })
      })
    })
    dirCache.set(dir, info)
    return info
  })

  // ---- macOS privacy permissions
  handle('perm:list', () => ctx.permissions.list())
  handle('perm:request', (key: string) => ctx.permissions.request(key))
  handle('perm:requestAll', () => ctx.permissions.requestAll())
  handle('perm:openPane', (key: string) => ctx.permissions.openPane(key))

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
