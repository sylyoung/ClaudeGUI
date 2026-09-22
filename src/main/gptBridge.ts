import { execFile, spawn } from 'child_process'
import fs from 'fs'

/**
 * The bridge a GPT chat actually talks to, and the ChatGPT login it keeps for itself.
 *
 * The launcher (`cc-gpt`) starts a local proxy — claude-code-proxy — and points Claude Code at it.
 * That proxy signs in to ChatGPT on its own account storage (the macOS Keychain), which is a
 * different login from the Codex CLI's ~/.codex/auth.json: renewing one does nothing for the other.
 * It renews itself while it runs, but when that fails only a fresh sign-in through its own command
 * brings it back, so the app reads its expiry and offers that sign-in rather than guessing.
 *
 * The bridge binary is the user's own, pinned by them. Nothing here writes to it or to its storage:
 * the app runs its `codex auth status` to read the expiry, and its `codex auth login` only when the
 * user presses the button.
 */

export interface BridgeLogin {
  /** The binary that answers on the launcher's port. */
  path?: string
  account?: string
  /** When its ChatGPT token stops being accepted (epoch ms). */
  expiresAt?: number
  /** Where it keeps the login ("macOS Keychain"). */
  storage?: string
  /** Why nothing could be read. */
  error?: string
}

function portOf(baseUrl: string | undefined): number | null {
  if (!baseUrl) return null
  try {
    const port = Number(new URL(baseUrl).port)
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function run(file: string, args: string[], env?: Record<string, string>, timeout = 15_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : err ? 1 : 0
      resolve({ code, out: String(stdout), err: String(stderr || (err?.message ?? '')) })
    })
  })
}

/** The executable listening on the bridge's port, which is the bridge itself. */
export async function bridgePath(baseUrl: string | undefined): Promise<string | null> {
  const port = portOf(baseUrl)
  if (!port) return null
  const listeners = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  const pid = listeners.out.split('\n').map((l) => l.trim()).find(Boolean)
  if (!pid) return null
  const comm = await run('ps', ['-o', 'comm=', '-p', pid])
  const file = comm.out.trim()
  if (!file || !file.startsWith('/')) return null
  try {
    fs.accessSync(file, fs.constants.X_OK)
  } catch {
    return null
  }
  return file
}

/**
 * What the bridge says about its own ChatGPT login, from its `codex auth status`:
 *
 *   Account: ac5595a6-…
 *   Expires: 2026-09-22T13:03:45.287Z (in 30471s)
 *   Storage: macOS Keychain
 */
export async function readBridgeLogin(baseUrl: string | undefined, env: Record<string, string>): Promise<BridgeLogin> {
  const file = await bridgePath(baseUrl)
  if (!file) return { error: 'The GPT bridge is not running here, so its own ChatGPT login cannot be read.' }
  const res = await run(file, ['codex', 'auth', 'status'], env)
  if (res.code !== 0) return { path: file, error: res.err.trim().split('\n')[0] || `${file} codex auth status ended with code ${res.code}` }
  const field = (name: string): string | undefined => res.out.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim()
  const expires = field('Expires')?.replace(/\s*\(.*\)$/, '')
  const at = expires ? Date.parse(expires) : NaN
  return { path: file, account: field('Account'), storage: field('Storage'), expiresAt: Number.isFinite(at) ? at : undefined }
}

/**
 * Sign the bridge in again, with its own browser flow. It is left running on its own: the flow ends
 * in the browser, and the bridge writes the new login into its storage when it does.
 */
export async function signInBridge(baseUrl: string | undefined, env: Record<string, string>): Promise<{ path: string; message: string }> {
  const file = await bridgePath(baseUrl)
  if (!file) throw new Error('The GPT bridge is not running here, so it cannot be signed in from the app. Start a GPT chat first.')
  const child = spawn(file, ['codex', 'auth', 'login'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const message = await new Promise<string>((resolve) => {
    let text = ''
    const done = setTimeout(() => resolve(text.trim()), 4000)
    const read = (b: Buffer): void => {
      text += String(b)
      // The flow prints the address it opened; once that is out there is nothing more to wait for.
      if (/https?:\/\//.test(text)) {
        clearTimeout(done)
        resolve(text.trim())
      }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', (e) => {
      clearTimeout(done)
      resolve(`the sign-in could not be started: ${e.message}`)
    })
  })
  child.unref()
  const url = message.match(/https?:\/\/\S+/)?.[0]
  return { path: file, message: url ? `Finish the sign-in in the browser window that opened (${url}).` : 'Finish the sign-in in the browser window that opened.' }
}
