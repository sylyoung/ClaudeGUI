import { execFile, spawn, type ChildProcess } from 'child_process'
import type { AuthState } from '@shared/types'
import { readStoredLogin } from './claudeLogin'

export interface AuthDeps {
  getEnv(): Promise<Record<string, string>>
  getExecutable(): string
  emit(state: AuthState): void
  /** Chats have just become unable to run: say so outside the window too. */
  notifySignedOut(): void
  onSignedIn(): void
  log(...args: unknown[]): void
}

const CHECK_EVERY_MS = 10 * 60_000
// eslint-disable-next-line no-control-regex
const TERMINAL_CODES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * Whether Claude Code can authenticate, and signing it in again from the app.
 *
 * Claude Code renews its 8-hour access token by itself with a refresh token. When the login server
 * no longer accepts that refresh token (it has an end date of its own, or was revoked), Claude Code
 * removes the stored login and every chat fails with "authentication_failed"; only signing in again
 * in a browser brings it back. This service notices that, and runs `claude auth login` — the same
 * command as in a terminal — so it can be done from the window.
 */
export class AuthService {
  state: AuthState = { status: 'unknown', checkedAt: 0 }
  /** The newest chat authentication failure already looked into (epoch ms). */
  lastFailureSeen = 0
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<AuthState> | null = null
  private signInChild: ChildProcess | null = null

  constructor(private deps: AuthDeps) {}

  start(): void {
    void this.check('startup')
    this.timer = setInterval(() => void this.check('timer'), CHECK_EVERY_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.cancelSignIn()
  }

  /** The login state, checked again when the last check is older than `maxAgeMs`. */
  async current(maxAgeMs = 60_000): Promise<AuthState> {
    if (this.state.status !== 'unknown' && Date.now() - this.state.checkedAt < maxAgeMs) return this.state
    return this.check('asked')
  }

  check(reason: string): Promise<AuthState> {
    if (!this.checking) this.checking = this.doCheck(reason).finally(() => (this.checking = null))
    return this.checking
  }

  private async doCheck(reason: string): Promise<AuthState> {
    const before = this.state.status
    let status: AuthState['status'] = 'unknown'
    let subscription: string | undefined
    let loginEndsAt: number | undefined
    const login = await readStoredLogin().catch(() => null)
    if (login) {
      status = 'signed-in'
      subscription = login.subscription
      loginEndsAt = login.refreshExpiresAt
    } else {
      const s = await this.authStatus()
      if (s) {
        status = !s.loggedIn ? 'signed-out' : s.authMethod === 'claude.ai' ? 'signed-in' : 'api-key'
        subscription = s.subscriptionType ?? undefined
      }
    }
    const statusSince = status !== before || !this.state.statusSince ? Date.now() : this.state.statusSince
    this.state = { ...this.state, status, statusSince, subscription, loginEndsAt, checkedAt: Date.now() }
    if (status !== before) this.deps.log(`[auth] ${reason}: ${before} -> ${status}`)
    if (status === 'signed-out' && before !== 'signed-out') this.deps.notifySignedOut()
    this.deps.emit(this.state)
    return this.state
  }

  /** `claude auth status --json`, reduced to what the app needs (no e-mail address, no organisation). */
  private async authStatus(): Promise<{ loggedIn: boolean; authMethod?: string; subscriptionType?: string | null } | null> {
    const exe = this.deps.getExecutable()
    if (!exe) return null
    const env = await this.deps.getEnv()
    return new Promise((resolve) => {
      // It exits with an error code when signed out, but still prints its answer.
      execFile(exe, ['auth', 'status', '--json'], { env, timeout: 20_000, encoding: 'utf8' }, (_err, stdout) => {
        try {
          const j = JSON.parse(String(stdout)) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string | null }
          resolve({ loggedIn: Boolean(j.loggedIn), authMethod: j.authMethod, subscriptionType: j.subscriptionType })
        } catch {
          resolve(null)
        }
      })
    })
  }

  /**
   * Sign Claude Code in again with `claude auth login`. It opens the browser by itself and prints the
   * page to use if the browser did not open; when the page shows a code instead of returning to
   * Claude Code by itself, the code is handed over with submitSignInCode().
   */
  async signIn(): Promise<AuthState> {
    if (this.signInChild) return this.state
    const exe = this.deps.getExecutable()
    if (!exe) throw new Error('The Claude Code executable was not found (Settings → Claude → Claude Code executable).')
    const env = await this.deps.getEnv()
    this.setSignIn({ phase: 'starting' })
    const child = spawn(exe, ['auth', 'login'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.signInChild = child
    this.deps.log('[auth] sign-in started from the app')
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const url = /https?:\/\/\S+/.exec(out.replace(TERMINAL_CODES, ''))?.[0]
      if (url && this.state.signIn?.url !== url) this.setSignIn({ phase: 'waiting', url })
      else if (this.state.signIn?.phase === 'starting' && /Opening browser/i.test(out)) this.setSignIn({ phase: 'waiting' })
    })
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', (e) => (err += e.message))
    child.on('close', (code) => {
      if (this.signInChild !== child) return // cancelled
      this.signInChild = null
      if (code === 0) {
        this.deps.log('[auth] signed in from the app')
        this.setSignIn({ phase: 'done' })
        void this.check('signed in').then(() => this.deps.onSignedIn())
        return
      }
      const lines = `${err}\n${out}`.replace(TERMINAL_CODES, '').split('\n').map((l) => l.trim()).filter(Boolean)
      const message = lines.find((l) => /failed|error/i.test(l)) ?? lines.pop() ?? `claude auth login exited with code ${code}`
      this.deps.log(`[auth] sign-in failed (exit ${code})`)
      this.setSignIn({ phase: 'failed', message })
    })
    return this.state
  }

  /** Hand the code the sign-in page shows to the running `claude auth login`. */
  submitSignInCode(code: string): void {
    const c = code.trim()
    if (c && this.signInChild?.stdin?.writable) this.signInChild.stdin.write(`${c}\n`)
  }

  cancelSignIn(): void {
    const child = this.signInChild
    if (!child) return
    this.signInChild = null
    child.kill('SIGTERM')
    this.deps.log('[auth] sign-in cancelled')
    this.setSignIn({ phase: 'cancelled' })
  }

  private setSignIn(signIn: AuthState['signIn']): void {
    this.state = { ...this.state, signIn }
    this.deps.emit(this.state)
  }
}
