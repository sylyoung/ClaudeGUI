import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, shell, systemPreferences } from 'electron'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { SettingsStore } from './store'
import { registerIpc } from './ipc'
import { getLoginShellEnv, getSpawnEnv, parseExtraEnv } from './env'
import { detectEditorCommand } from './shellService'
import { startDebugServer } from './debugServer'
import { UsageService } from './usageService'
import { HostClient, HostProtocolMismatch } from './hostClient'
import { Updater } from './updater'
import { loadWindowState, trackWindowState } from './windowState'
import { PermissionService } from './permissions'
import type { AppSettings, SessionEvent, StartupNotice, ThemeInfo, UsageSnapshot } from '@shared/types'
import type { HostEvent } from '../host/protocol'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const logFile = path.join(app.getPath('logs'), 'claudegui.log')
fs.mkdirSync(path.dirname(logFile), { recursive: true })
function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
  console.log(line)
  fs.appendFile(logFile, line + '\n', () => undefined)
}

let mainWindow: BrowserWindow | null = null
let store: SettingsStore
let host: HostClient
let usage: UsageService
let updater: Updater
let permissions: PermissionService
let startupNotice: StartupNotice | null = null
let quitting = false
let quitInProgress = false
/** Set when quitting to apply an update: the session host must stay alive. */
let updating = false
let expectDisconnect = false
let replacingHost = false
let staleCheckTimer: NodeJS.Timeout | null = null

function sdkVersion(): string {
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'))
    return String(pkg.version)
  } catch {
    return 'unknown'
  }
}

function resolveExecutable(): string {
  const custom = store.get().claudeExecutable?.trim()
  if (custom && fs.existsSync(custom)) return custom
  // SDK-bundled binary (platform package). Resolve so that a packaged app can unpack it.
  try {
    const pkgDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json'))
    const candidate = path.join(pkgDir, 'claude').replace('app.asar', 'app.asar.unpacked')
    if (fs.existsSync(candidate)) return candidate
  } catch {
    /* not installed */
  }
  return ''
}

/** /path/to/ClaudeGUI.app when running from a built bundle. */
function bundlePath(): string | undefined {
  if (!app.isPackaged) return undefined
  const exe = app.getPath('exe')
  const b = path.resolve(exe, '..', '..', '..')
  return b.endsWith('.app') ? b : undefined
}

function broadcast(event: SessionEvent): void {
  sendAll('session:event', event)
}

function sendAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

// ------------------------------------------------------------------ theme

function accentHex(): string {
  if (process.platform === 'darwin') {
    try {
      const c = systemPreferences.getAccentColor()
      if (c && c.length >= 6) return '#' + c.slice(0, 6).toLowerCase()
    } catch {
      /* unsupported */
    }
  }
  return '#007aff'
}

function getThemeInfo(): ThemeInfo {
  return { systemDark: nativeTheme.shouldUseDarkColors, accent: accentHex() }
}

function windowBackground(): string {
  const s = store.get()
  if (process.platform === 'darwin' && s.translucentSidebar) return '#00000000'
  return nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff'
}

function applyThemeSettings(): void {
  const s = store.get()
  nativeTheme.themeSource = s.theme || 'system'
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(windowBackground())
    if (process.platform === 'darwin') win.setVibrancy(s.translucentSidebar ? 'sidebar' : null)
  }
  sendAll('theme:changed', getThemeInfo())
}

function onSettingsChanged(prev: AppSettings, next: AppSettings): void {
  if (prev.theme !== next.theme || prev.translucentSidebar !== next.translucentSidebar || prev.accent !== next.accent) applyThemeSettings()
  if (prev.usageRefreshMinutes !== next.usageRefreshMinutes) usage.reschedule()
  if (host.connected) {
    host.setSettings(next, resolveExecutable() || undefined).catch((err) => log(`[host] setSettings failed: ${(err as Error).message}`))
    if (prev.dockBadge !== next.dockBadge) host.refreshBadge().catch(() => undefined)
  }
  sendAll('settings:changed', next)
  buildMenu()
}

// ----------------------------------------------------------------- window

function createWindow(): BrowserWindow {
  const s = store.get()
  const saved = loadWindowState(app.getPath('userData'))
  const win = new BrowserWindow({
    width: saved?.width ?? 1500,
    height: saved?.height ?? 950,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'ClaudeGUI',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: windowBackground(),
    vibrancy: process.platform === 'darwin' && s.translucentSidebar ? 'sidebar' : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false
    }
  })
  trackWindowState(win, app.getPath('userData'))
  win.on('ready-to-show', () => {
    if (saved?.maximized) win.maximize()
    win.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file:')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
  win.on('focus', () => {
    if (host?.connected) host.setFocus(true).catch(() => undefined)
  })
  win.on('blur', () => {
    if (host?.connected) host.setFocus(false).catch(() => undefined)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

function buildMenu(): void {
  const send = (channel: string, ...args: unknown[]) => mainWindow?.webContents.send(channel, ...args)
  const theme = store?.get().theme ?? 'system'
  const setTheme = (t: AppSettings['theme']) => {
    const prev = store.get()
    const next = store.update((s) => ({ ...s, theme: t }))
    onSettingsChanged(prev, next)
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => send('menu:check-updates') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('menu:settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Session',
      submenu: [
        { label: 'New Session…', accelerator: 'Cmd+N', click: () => send('menu:new-session') },
        { label: 'Import CLI Session…', accelerator: 'Cmd+Shift+I', click: () => send('menu:import-session') },
        { type: 'separator' },
        { label: 'Next Session', accelerator: 'Cmd+Shift+]', click: () => send('menu:next-session') },
        { label: 'Previous Session', accelerator: 'Cmd+Shift+[', click: () => send('menu:prev-session') },
        { label: 'Focus Composer', accelerator: 'Cmd+L', click: () => send('menu:focus-composer') },
        { label: 'Search Sessions', accelerator: 'Cmd+K', click: () => send('menu:search') },
        { label: 'Select All Sessions', accelerator: 'Cmd+Shift+A', click: () => send('menu:select-all') },
        { label: 'Start All Session Processes', click: () => send('menu:start-all') },
        { type: 'separator' },
        { label: 'Interrupt Current Turn', accelerator: 'Cmd+.', click: () => send('menu:interrupt') },
        { label: 'Keyboard Shortcuts', accelerator: 'Cmd+/', click: () => send('menu:shortcuts') },
        { type: 'separator' },
        { label: 'Refresh Usage Limits', click: () => void usage?.refresh('menu') }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => send('menu:toggle-sidebar') },
        { label: 'Toggle Folder Panel (this chat)', accelerator: 'Cmd+Shift+E', click: () => send('menu:toggle-files') },
        { label: 'Toggle Git Panel', accelerator: 'Cmd+Shift+G', click: () => send('menu:toggle-git') },
        { label: 'Toggle Statistics Bar', accelerator: 'Cmd+Shift+S', click: () => send('menu:toggle-board') },
        { label: 'Switch Sidebar View (Groups / Recent)', accelerator: 'Cmd+Shift+V', click: () => send('menu:toggle-view') },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: [
            { label: 'Match System', type: 'radio', checked: theme === 'system', click: () => setTheme('system') },
            { label: 'Light', type: 'radio', checked: theme === 'light', click: () => setTheme('light') },
            { label: 'Dark', type: 'radio', checked: theme === 'dark', click: () => setTheme('dark') }
          ]
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function notify(opts: { sessionId: string; title: string; body: string; kind: 'turn' | 'permission' | 'error' }): void {
  const s = store.get()
  if (!s.notifications) return
  if (opts.kind === 'turn' && !s.notifyOnTurnFinished) return
  if (opts.kind === 'permission' && !s.notifyOnPermission) return
  if (opts.kind === 'error' && !s.notifyOnError) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title: opts.title, body: opts.body, silent: !s.notificationSound })
  n.on('click', () => {
    if (!mainWindow) mainWindow = createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    broadcast({ type: 'focus', sessionId: opts.sessionId })
  })
  n.show()
}

function setBadge(count: number): void {
  if (process.platform !== 'darwin') return
  const show = store.get().dockBadge && count > 0
  app.dock?.setBadge(show ? String(count) : '')
}

// ------------------------------------------------------------- session host

function handleHostEvent(ev: HostEvent): void {
  switch (ev.e) {
    case 'session':
      broadcast(ev.d)
      if (ev.d.type === 'state' && host.status.stale) scheduleStaleHostCheck()
      break
    case 'notify':
      notify(ev.d)
      break
    case 'badge':
      setBadge(ev.d.count)
      break
    case 'rateLimit':
      usage.applyRateLimitEvent(ev.d.info, ev.d.ts)
      break
    case 'turnFinished':
      usage.refreshSoon('turn finished')
      break
    case 'exiting':
      log(`[host] session host exiting (${ev.d.reason})`)
      break
    default:
      break
  }
}

/** Attach to the running host or start one; handles a host from an incompatible version. */
async function connectHost(): Promise<void> {
  try {
    await host.connect()
  } catch (err) {
    if (err instanceof HostProtocolMismatch) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Stop Them and Continue', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        message: `A session host from ClaudeGUI ${err.hostVersion} is still running ${err.aliveSessions} session${err.aliveSessions === 1 ? '' : 's'} that this version cannot take over.`,
        detail: 'Stopping them ends their Claude processes and background tasks. History is kept and each session resumes with your next message.'
      })
      if (choice === 1) {
        quitting = true
        app.quit()
        return
      }
      await host.stopStaleHost()
      await host.connect()
    } else throw err
  }
  const st = host.status
  log(`[host] ${st.origin} pid=${st.pid} version=${st.version} live=${st.aliveSessions}${st.stale ? ' (stale)' : ''}`)
  if (st.stale && st.aliveSessions === 0) await replaceHost('started by an older version, no live sessions')
}

/** Stop the current host and start a fresh one from this app version (only when nothing is running). */
async function replaceHost(reason: string): Promise<void> {
  if (replacingHost || quitting) return
  replacingHost = true
  expectDisconnect = true
  try {
    log(`[host] replacing session host (${reason})`)
    await host.shutdown(10_000)
    await host.connect()
    sendAll('sessions:reload', null)
    log(`[host] new session host pid=${host.status.pid} version=${host.status.version}`)
  } catch (err) {
    log(`[host] replace failed: ${(err as Error).message}`)
  } finally {
    replacingHost = false
    expectDisconnect = false
  }
}

function scheduleStaleHostCheck(): void {
  if (staleCheckTimer) return
  staleCheckTimer = setTimeout(async () => {
    staleCheckTimer = null
    if (!host.status.stale || replacingHost || quitting || !host.connected) return
    try {
      if ((await host.aliveCount()) === 0) await replaceHost('all sessions of the old host stopped')
    } catch {
      /* ignore */
    }
  }, 3000)
}

// ------------------------------------------------------------------- quit

async function handleQuit(): Promise<void> {
  if (updating) {
    quitting = true
    usage.stop()
    log('restarting to apply an update: leaving the session host and its sessions running')
    expectDisconnect = true
    host.detach()
    store.flush()
    app.quit()
    return
  }
  let alive = 0
  try {
    alive = host.connected ? await host.aliveCount() : 0
  } catch {
    alive = 0
  }
  if (alive > 0 && store.get().confirmQuit) {
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `${alive} Claude session${alive === 1 ? ' is' : 's are'} running. Quit ClaudeGUI?`,
      detail: 'Running processes and their background tasks are stopped. History is kept and each session resumes with your next message.'
    })
    if (choice === 1) return
  }
  quitting = true
  usage.stop()
  updater.cancel()
  if (host.connected) {
    log('quitting: stopping the session host')
    expectDisconnect = true
    await host.shutdown(12_000)
  }
  store.flush()
  app.quit()
}

// ------------------------------------------------------------------ start

app.setName('ClaudeGUI')
// Development: CLAUDEGUI_USER_DATA=<dir> isolates settings/sessions from an installed copy.
if (process.env.CLAUDEGUI_USER_DATA) app.setPath('userData', process.env.CLAUDEGUI_USER_DATA)
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createWindow()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    const userData = app.getPath('userData')
    store = new SettingsStore(userData)
    nativeTheme.themeSource = store.get().theme || 'system'
    // Warm the login environment early; also pick a default editor on first run.
    const env = await getLoginShellEnv().catch(() => ({}) as Record<string, string>)
    if (!store.get().editorCommand) {
      store.update((s) => ({ ...s, editorCommand: detectEditorCommand({ ...process.env, ...env } as Record<string, string>) }))
    }
    host = new HostClient({
      userDataPath: userData,
      logFile: path.join(app.getPath('logs'), 'session-host.log'),
      hostScript: path.join(__dirname, 'host.mjs'),
      appVersion: app.getVersion(),
      getSettings: () => store.get(),
      getExecutable: () => resolveExecutable() || undefined,
      isFocused: () => Boolean(mainWindow?.isFocused()),
      log
    })
    host.on('event', (ev: HostEvent) => handleHostEvent(ev))
    host.on('disconnected', ({ detached }: { detached: boolean }) => {
      if (quitting || detached || expectDisconnect) return
      log('[host] session host disconnected unexpectedly; reconnecting')
      setTimeout(() => {
        void connectHost()
          .then(() => sendAll('sessions:reload', null))
          .catch((err) => log(`[host] reconnect failed: ${(err as Error).message}`))
      }, 500)
    })
    usage = new UsageService({
      getEnv: () => getSpawnEnv(parseExtraEnv(store.get().extraEnv)),
      getSettings: () => store.get(),
      sessionUsage: () => (host.connected ? host.planUsage() : Promise.resolve(null)),
      emit: (snapshot: UsageSnapshot) => sendAll('usage:update', snapshot),
      log
    })
    updater = new Updater({
      appVersion: app.getVersion(),
      bundlePath: bundlePath(),
      userDataPath: userData,
      getSettings: () => store.get(),
      getEnv: () => getSpawnEnv(parseExtraEnv(store.get().extraEnv)),
      emit: (state) => sendAll('update:changed', state),
      requestRestart: () => {
        updating = true
        app.quit()
      },
      log
    })
    startupNotice = updater.takeStartupNotice()
    permissions = new PermissionService(userData, () => getSpawnEnv(parseExtraEnv(store.get().extraEnv)), log)
    registerIpc({
      store,
      host,
      usage,
      updater,
      permissions,
      getWindow: () => mainWindow,
      resolveExecutable,
      sdkVersion: sdkVersion(),
      bundlePath: bundlePath(),
      logFile,
      getThemeInfo,
      onSettingsChanged,
      takeStartupNotice: () => {
        const n = startupNotice
        startupNotice = null
        return n
      },
      replaceHost: () => replaceHost('requested from Settings'),
      broadcast: sendAll
    })
    buildMenu()
    nativeTheme.on('updated', () => {
      for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(windowBackground())
      sendAll('theme:changed', getThemeInfo())
    })
    if (process.platform === 'darwin') {
      systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', () => sendAll('theme:changed', getThemeInfo()))
    }
    const iconPath = path.join(__dirname, '../../resources/icon.png')
    if (process.platform === 'darwin' && fs.existsSync(iconPath)) app.dock?.setIcon(nativeImage.createFromPath(iconPath))
    mainWindow = createWindow()
    const s = store.get()
    if (process.env.CLAUDEGUI_DEBUG === '1' || s.debugServer) {
      if (!process.env.CLAUDEGUI_DEBUG_PORT && s.debugPort) process.env.CLAUDEGUI_DEBUG_PORT = String(s.debugPort)
      startDebugServer({ getWindow: () => mainWindow, host, updater, log })
    }
    try {
      await connectHost()
    } catch (err) {
      log(`[host] cannot start the session host: ${(err as Error).message}`)
      dialog.showMessageBox({ type: 'error', message: 'ClaudeGUI could not start its session host.', detail: `${(err as Error).message}\n\nLog: ${path.join(app.getPath('logs'), 'session-host.log')}` }).catch(() => undefined)
    }
    usage.start()
    if (host.connected) host.resumeOnLaunch().catch((err) => log(`[host] resumeOnLaunch failed: ${(err as Error).message}`))
    const proxyKeys = Object.keys(env).filter((k) => /proxy/i.test(k))
    log(`ClaudeGUI ${app.getVersion()} started. user=${os.userInfo().username} sdk=${sdkVersion()} exe=${resolveExecutable()} bundle=${bundlePath() ?? '(dev)'} envVars=${Object.keys(env).length} proxyVars=${proxyKeys.join(',') || 'none'} theme=${s.theme} log=${logFile}`)
  })

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow()
    else mainWindow.show()
  })

  // Keep sessions alive when the window is closed (macOS behaviour); quit only via Cmd+Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    if (quitInProgress) return
    quitInProgress = true
    // Never call app.quit() again from inside this handler: a nested quit is ignored by Electron
    // and the prevented one wins, leaving the app running. Continue on the next tick instead.
    setImmediate(() => {
      void handleQuit().finally(() => {
        quitInProgress = false
      })
    })
  })
}
