import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, shell, systemPreferences } from 'electron'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { AppStore } from './store'
import { SessionManager, type NotifyKind } from './sessions/SessionManager'
import { registerIpc } from './ipc'
import { getLoginShellEnv, getSpawnEnv, parseExtraEnv } from './env'
import { detectEditorCommand } from './shellService'
import { startDebugServer } from './debugServer'
import { UsageService } from './usageService'
import { setToolResultMaxChars } from './sessions/transcript'
import type { AppSettings, SessionEvent, ThemeInfo, UsageSnapshot } from '@shared/types'

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
let store: AppStore
let manager: SessionManager
let usage: UsageService
let quitting = false

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
  const custom = store.settings.get().claudeExecutable?.trim()
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
  const s = store.settings.get()
  if (process.platform === 'darwin' && s.translucentSidebar) return '#00000000'
  return nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff'
}

function applyThemeSettings(): void {
  const s = store.settings.get()
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
  if (prev.toolResultMaxChars !== next.toolResultMaxChars) setToolResultMaxChars(next.toolResultMaxChars)
  if (prev.dockBadge !== next.dockBadge) manager.refreshBadge()
  sendAll('settings:changed', next)
  buildMenu()
}

// ----------------------------------------------------------------- window

function createWindow(): BrowserWindow {
  const s = store.settings.get()
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
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
  win.on('ready-to-show', () => win.show())
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
    manager.setActive(manager.activeSessionId)
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
  const theme = store?.settings.get().theme ?? 'system'
  const setTheme = (t: AppSettings['theme']) => {
    const prev = store.settings.get()
    const next = store.settings.update((s) => ({ ...s, theme: t }))
    onSettingsChanged(prev, next)
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
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
        { type: 'separator' },
        { label: 'Interrupt Current Turn', accelerator: 'Cmd+.', click: () => send('menu:interrupt') },
        { type: 'separator' },
        { label: 'Refresh Usage Limits', click: () => void usage?.refresh('menu') }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => send('menu:toggle-sidebar') },
        { label: 'Toggle Files Panel', accelerator: 'Cmd+Shift+E', click: () => send('menu:toggle-files') },
        { label: 'Toggle Git Panel', accelerator: 'Cmd+Shift+G', click: () => send('menu:toggle-git') },
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

function notify(opts: { sessionId: string; title: string; body: string; kind: NotifyKind }): void {
  const s = store.settings.get()
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
    store = new AppStore()
    nativeTheme.themeSource = store.settings.get().theme || 'system'
    setToolResultMaxChars(store.settings.get().toolResultMaxChars)
    // Warm the login environment early; also pick a default editor on first run.
    const env = await getLoginShellEnv().catch(() => ({}) as Record<string, string>)
    if (!store.settings.get().editorCommand) {
      store.settings.update((s) => ({ ...s, editorCommand: detectEditorCommand({ ...process.env, ...env } as Record<string, string>) }))
    }
    usage = new UsageService({
      getEnv: () => getSpawnEnv(parseExtraEnv(store.settings.get().extraEnv)),
      getSettings: () => store.settings.get(),
      sessionUsage: () => manager.planUsageFromAnySession(),
      emit: (snapshot: UsageSnapshot) => sendAll('usage:update', snapshot),
      log
    })
    manager = new SessionManager(store, {
      getEnv: () => getSpawnEnv(parseExtraEnv(store.settings.get().extraEnv)),
      getExecutable: () => resolveExecutable() || undefined,
      getSettings: () => store.settings.get(),
      appVersion: app.getVersion(),
      broadcast,
      notify,
      isWindowFocused: () => Boolean(mainWindow?.isFocused()),
      updateBadge: (count) => {
        if (process.platform !== 'darwin') return
        const show = store.settings.get().dockBadge && count > 0
        app.dock?.setBadge(show ? String(count) : '')
      },
      onRateLimit: (info, ts) => usage.applyRateLimitEvent(info, ts),
      onTurnFinished: () => usage.refreshSoon('turn finished'),
      log
    })
    registerIpc({ store, manager, usage, getWindow: () => mainWindow, resolveExecutable, sdkVersion: sdkVersion(), getThemeInfo, onSettingsChanged })
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
    const s = store.settings.get()
    if (process.env.CLAUDEGUI_DEBUG === '1' || s.debugServer) {
      if (!process.env.CLAUDEGUI_DEBUG_PORT && s.debugPort) process.env.CLAUDEGUI_DEBUG_PORT = String(s.debugPort)
      startDebugServer({ getWindow: () => mainWindow, manager, log })
    }
    usage.start()
    void manager.resumeOnLaunch()
    const proxyKeys = Object.keys(env).filter((k) => /proxy/i.test(k))
    log(`ClaudeGUI ${app.getVersion()} started. user=${os.userInfo().username} sdk=${sdkVersion()} exe=${resolveExecutable()} envVars=${Object.keys(env).length} proxyVars=${proxyKeys.join(',') || 'none'} theme=${s.theme} log=${logFile}`)
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
    const alive = manager ? manager.aliveCount() : 0
    if (alive > 0 && store.settings.get().confirmQuit) {
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `${alive} Claude session${alive === 1 ? ' is' : 's are'} running. Quit ClaudeGUI?`,
        detail: 'Running processes are stopped. History is kept and each session resumes with your next message.'
      })
      if (choice === 1) {
        e.preventDefault()
        return
      }
    }
    if (alive > 0) {
      e.preventDefault()
      quitting = true
      log('quitting: stopping sessions')
      usage?.stop()
      Promise.race([manager.stopAll(), new Promise((r) => setTimeout(r, 6000))]).finally(() => {
        store.flush()
        app.quit()
      })
    } else {
      quitting = true
      usage?.stop()
      store?.flush()
    }
  })
}
