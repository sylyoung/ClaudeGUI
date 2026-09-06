import fs from 'fs'
import path from 'path'
import { screen, type BrowserWindow, type Rectangle } from 'electron'

interface WindowState extends Rectangle {
  maximized?: boolean
}

/** Remember window position and size across restarts (window-state.json in the data folder). */
export function loadWindowState(userDataPath: string): WindowState | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userDataPath, 'window-state.json'), 'utf8')) as WindowState
    if (typeof s.width !== 'number' || typeof s.height !== 'number') return null
    const bounds = { x: s.x, y: s.y, width: Math.max(900, s.width), height: Math.max(600, s.height) }
    // Only reuse the position when it still lands on a connected display.
    const display = screen.getDisplayMatching(bounds)
    const a = display.workArea
    const visible = bounds.x + bounds.width > a.x + 40 && bounds.x < a.x + a.width - 40 && bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 40
    return visible ? { ...bounds, maximized: s.maximized } : { width: bounds.width, height: bounds.height, x: undefined as never, y: undefined as never }
  } catch {
    return null
  }
}

export function trackWindowState(win: BrowserWindow, userDataPath: string): void {
  const file = path.join(userDataPath, 'window-state.json')
  let timer: NodeJS.Timeout | null = null
  const save = () => {
    timer = null
    if (win.isDestroyed()) return
    const maximized = win.isMaximized() || win.isFullScreen()
    const b = maximized ? win.getNormalBounds() : win.getBounds()
    try {
      fs.writeFileSync(file, JSON.stringify({ ...b, maximized }, null, 2))
    } catch {
      /* best effort */
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', save)
}
