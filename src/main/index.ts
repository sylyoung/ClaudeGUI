import { app, BrowserWindow, Menu, Notification, shell, nativeImage } from 'electron'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { AppStore } from './store'
import { SessionManager } from './sessions/SessionManager'
import { registerIpc } from './ipc'
import { getLoginShellEnv, getSpawnEnv, parseExtraEnv } from './env'
import { detectEditorCommand } from './shellService'
import { startDebugServer } from './debugServer'
import type { SessionEvent } from '@shared/types'

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
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('session:event', event)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'ClaudeGUI',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#111417',
    vibrancy: undefined,
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
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => send('menu:toggle-sidebar') },
        { label: 'Toggle Files Panel', accelerator: 'Cmd+Shift+E', click: () => send('menu:toggle-files') },
        { label: 'Search Sessions', accelerator: 'Cmd+K', click: () => send('menu:search') },
        { type: 'separator' },
        { label: 'Interrupt Current Turn', accelerator: 'Cmd+.', click: () => send('menu:interrupt') }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
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

function notify(opts: { sessionId: string; title: string; body: string }): void {
  if (!store.settings.get().notifications) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title: opts.title, body: opts.body, silent: false })
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
    // Warm the login environment early; also pick a default editor on first run.
    const env = await getLoginShellEnv().catch(() => ({}) as Record<string, string>)
    if (!store.settings.get().editorCommand) {
      store.settings.update((s) => ({ ...s, editorCommand: detectEditorCommand({ ...process.env, ...env } as Record<string, string>) }))
    }
    manager = new SessionManager(store, {
      getEnv: () => getSpawnEnv(parseExtraEnv(store.settings.get().extraEnv)),
      getExecutable: () => resolveExecutable() || undefined,
      broadcast,
      notify,
      isWindowFocused: () => Boolean(mainWindow?.isFocused()),
      updateBadge: (count) => {
        if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '')
      },
      log
    })
    registerIpc({ store, manager, getWindow: () => mainWindow, resolveExecutable, sdkVersion: sdkVersion() })
    buildMenu()
    const iconPath = path.join(__dirname, '../../resources/icon.png')
    if (process.platform === 'darwin' && fs.existsSync(iconPath)) app.dock?.setIcon(nativeImage.createFromPath(iconPath))
    mainWindow = createWindow()
    if (process.env.CLAUDEGUI_DEBUG === '1') startDebugServer({ getWindow: () => mainWindow, manager, log })
    const proxyKeys = Object.keys(env).filter((k) => /proxy/i.test(k))
    log(`ClaudeGUI started. user=${os.userInfo().username} sdk=${sdkVersion()} exe=${resolveExecutable()} envVars=${Object.keys(env).length} proxyVars=${proxyKeys.join(',') || 'none'} log=${logFile}`)
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
    if (manager && manager.aliveCount() > 0) {
      e.preventDefault()
      quitting = true
      log('quitting: stopping sessions')
      Promise.race([manager.stopAll(), new Promise((r) => setTimeout(r, 6000))]).finally(() => {
        store.flush()
        app.quit()
      })
    } else {
      quitting = true
      store?.flush()
    }
  })
}
