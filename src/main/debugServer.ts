import http from 'http'
import fs from 'fs'
import type { BrowserWindow } from 'electron'
import type { HostClient } from './hostClient'
import type { Updater } from './updater'

/**
 * Development-only HTTP endpoint (CLAUDEGUI_DEBUG=1) used to drive and inspect the app
 * from the command line: screenshots, state dumps and renderer JS evaluation.
 */
export function startDebugServer(opts: { getWindow(): BrowserWindow | null; host: HostClient; updater: Updater; log(...a: unknown[]): void }): void {
  const port = Number(process.env.CLAUDEGUI_DEBUG_PORT || 45123)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body, null, 1))
    }
    const readBody = () => new Promise<string>((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)) })
    try {
      const win = opts.getWindow()
      switch (url.pathname) {
        case '/capture': {
          if (!win) return send(500, { error: 'no window' })
          const out = url.searchParams.get('out') || '/tmp/claudegui.png'
          const img = await win.webContents.capturePage()
          fs.writeFileSync(out, img.toPNG())
          return send(200, { ok: true, out, size: img.getSize() })
        }
        case '/state':
          return send(200, { active: opts.host.activeSessionId, host: opts.host.status, ...(await opts.host.list()) })
        case '/host':
          return send(200, { ...opts.host.status, info: opts.host.connected ? await opts.host.info() : null })
        case '/update':
          return send(200, opts.updater.state)
        case '/history': {
          const id = url.searchParams.get('id') || ''
          return send(200, await opts.host.history(id))
        }
        case '/send': {
          const id = url.searchParams.get('id') || ''
          const text = url.searchParams.get('text') || (await readBody())
          await opts.host.send(id, text)
          return send(200, { ok: true })
        }
        case '/eval': {
          if (!win) return send(500, { error: 'no window' })
          const code = await readBody()
          const value = await win.webContents.executeJavaScript(code, true)
          return send(200, { value })
        }
        case '/input': {
          // Mouse input as the page gets it from the system, at ?x=&y= (page pixels): ?type=click,
          // move, or wheel with ?dy= (positive scrolls down). Unlike a click() run in the page it goes
          // through the page's own hit testing, focus and scrolling — though not through the window's
          // drag regions, which macOS handles before the page sees anything.
          if (!win) return send(500, { error: 'no window' })
          const dbg = win.webContents.debugger
          if (!dbg.isAttached()) dbg.attach('1.3')
          const x = Number(url.searchParams.get('x'))
          const y = Number(url.searchParams.get('y'))
          const type = url.searchParams.get('type') || 'click'
          const mouse = (p: Record<string, unknown>) => dbg.sendCommand('Input.dispatchMouseEvent', { x, y, ...p })
          await mouse({ type: 'mouseMoved' })
          if (type === 'click') {
            await mouse({ type: 'mousePressed', button: 'left', clickCount: 1 })
            await mouse({ type: 'mouseReleased', button: 'left', clickCount: 1 })
          } else if (type === 'wheel') {
            await mouse({ type: 'mouseWheel', deltaX: 0, deltaY: Number(url.searchParams.get('dy') || 100) })
          }
          return send(200, { ok: true })
        }
        case '/heap': {
          // The window's JavaScript heap, and with ?gc=1 the same after a full garbage collection:
          // the part that survives it is what the window really holds, the rest is waiting to be freed.
          if (!win) return send(500, { error: 'no window' })
          const dbg = win.webContents.debugger
          if (!dbg.isAttached()) dbg.attach('1.3')
          const usage = async () => (await dbg.sendCommand('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number }
          const before = await usage()
          let after: { usedSize: number; totalSize: number } | null = null
          if (url.searchParams.get('gc') === '1') {
            await dbg.sendCommand('HeapProfiler.collectGarbage')
            after = await usage()
          }
          const metric = (await import('electron')).app.getAppMetrics().find((m) => m.pid === win.webContents.getOSProcessId())
          return send(200, { pid: win.webContents.getOSProcessId(), before, after, workingSetKB: metric?.memory.workingSetSize })
        }
        case '/profile': {
          // A CPU profile of the window for ?ms= milliseconds, written to ?out= (.cpuprofile).
          if (!win) return send(500, { error: 'no window' })
          const dbg = win.webContents.debugger
          if (!dbg.isAttached()) dbg.attach('1.3')
          const ms = Math.min(60_000, Number(url.searchParams.get('ms') || 10_000))
          const out = url.searchParams.get('out') || '/tmp/claudegui.cpuprofile'
          await dbg.sendCommand('Profiler.enable')
          await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 200 })
          await dbg.sendCommand('Profiler.start')
          await new Promise((r) => setTimeout(r, ms))
          const { profile } = (await dbg.sendCommand('Profiler.stop')) as { profile: unknown }
          fs.writeFileSync(out, JSON.stringify(profile))
          return send(200, { ok: true, out, ms })
        }
        case '/heapsnapshot': {
          if (!win) return send(500, { error: 'no window' })
          const out = url.searchParams.get('out') || '/tmp/claudegui.heapsnapshot'
          await win.webContents.takeHeapSnapshot(out)
          return send(200, { ok: true, out, bytes: fs.statSync(out).size })
        }
        default:
          return send(404, { error: 'unknown endpoint' })
      }
    } catch (err) {
      return send(500, { error: (err as Error).message })
    }
  })
  server.listen(port, '127.0.0.1', () => opts.log(`[debug] http server on 127.0.0.1:${port}`))
}
