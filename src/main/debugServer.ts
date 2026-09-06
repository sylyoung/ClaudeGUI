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
        default:
          return send(404, { error: 'unknown endpoint' })
      }
    } catch (err) {
      return send(500, { error: (err as Error).message })
    }
  })
  server.listen(port, '127.0.0.1', () => opts.log(`[debug] http server on 127.0.0.1:${port}`))
}
