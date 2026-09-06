/**
 * In-app updater for a locally built, unsigned app.
 *
 * Releases are git tags (v1.0.2 …) of the ClaudeGUI repository. "Check" clones or fetches the
 * repository into the update work folder and looks for a tag newer than the running version.
 * "Install" checks that tag out, installs dependencies when the lock file changed, builds the
 * bundle into a staging folder and verifies its version. "Apply" starts a small shell helper that
 * waits for the app to quit, swaps the bundle at the app's current location and reopens it. The
 * session host (a separate process) keeps every Claude process alive during the restart.
 */
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AppSettings, StartupNotice, UpdateState, UpdateStatus } from '@shared/types'
import { DEFAULT_UPDATE_REPO } from '@shared/defaults'
import { compareVersions, parseVersion } from '@shared/util'
import { findOnPath } from './shellService'

export interface UpdaterDeps {
  appVersion: string
  bundlePath: string | undefined
  userDataPath: string
  getSettings(): AppSettings
  getEnv(): Promise<Record<string, string>>
  emit(state: UpdateState): void
  /** Quit the app without stopping the session host; the helper script relaunches it. */
  requestRestart(): void
  log(...args: unknown[]): void
}

interface PendingMarker {
  from: string
  to: string
  at: number
  bundlePath: string
  logFile: string
}

const LOG_TAIL = 400
const STEP_COUNT = 4

export class Updater {
  state: UpdateState
  private child: ChildProcess | null = null
  private cancelled = false
  private busy = false
  private latestTag: string | undefined
  private emitTimer: NodeJS.Timeout | null = null
  private emitDirty = false

  constructor(private deps: UpdaterDeps) {
    const supported = Boolean(deps.bundlePath)
    this.state = {
      status: supported ? 'idle' : 'unsupported',
      currentVersion: deps.appVersion,
      log: [],
      autoRestart: deps.getSettings().updateAutoRestart !== false,
      bundlePath: deps.bundlePath,
      workDir: this.workDir,
      logFile: this.logFile,
      error: supported ? undefined : 'In-app updates work only when running the built ClaudeGUI.app (not in development mode).'
    }
  }

  // ------------------------------------------------------------- locations

  get workDir(): string {
    const custom = this.deps.getSettings().updateWorkDir?.trim()
    return process.env.CLAUDEGUI_UPDATE_DIR || custom || path.join(os.homedir(), 'Library', 'Caches', 'ClaudeGUI', 'update')
  }
  get srcDir(): string {
    return path.join(this.workDir, 'src')
  }
  get stagingDir(): string {
    return path.join(this.workDir, 'staging')
  }
  get logFile(): string {
    return path.join(this.workDir, 'update.log')
  }
  get repo(): string {
    return this.deps.getSettings().updateRepo?.trim() || DEFAULT_UPDATE_REPO
  }
  private get markerPath(): string {
    return path.join(this.deps.userDataPath, 'pending-update.json')
  }

  /** Read (and clear) the note left by the previous run's apply step. */
  takeStartupNotice(): StartupNotice | null {
    let marker: PendingMarker | null = null
    try {
      marker = JSON.parse(fs.readFileSync(this.markerPath, 'utf8')) as PendingMarker
      fs.unlinkSync(this.markerPath)
    } catch {
      return null
    }
    if (!marker) return null
    if (marker.to === this.deps.appVersion) {
      this.deps.log(`[update] applied ${marker.from} -> ${marker.to}`)
      return { kind: 'success', text: `Updated to ClaudeGUI ${marker.to}. Sessions and their background tasks kept running.` }
    }
    this.deps.log(`[update] marker says ${marker.to} but running ${this.deps.appVersion}`)
    return { kind: 'error', text: `The update to ${marker.to} was not applied (still running ${this.deps.appVersion}). See the update log in Settings → About.` }
  }

  // ---------------------------------------------------------------- state

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch, workDir: this.workDir, logFile: this.logFile, autoRestart: this.deps.getSettings().updateAutoRestart !== false }
    this.emit(patch.status !== undefined)
  }

  private emit(now = false): void {
    this.emitDirty = true
    if (now) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer)
        this.emitTimer = null
      }
      this.emitDirty = false
      this.deps.emit(this.state)
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      if (this.emitDirty) {
        this.emitDirty = false
        this.deps.emit(this.state)
      }
    }, 120)
  }

  private logLine(line: string): void {
    const text = line.replace(/\r/g, '').trimEnd()
    if (!text) return
    const log = this.state.log.length >= LOG_TAIL ? this.state.log.slice(-LOG_TAIL + 1) : this.state.log.slice()
    log.push(text)
    this.state = { ...this.state, log }
    try {
      fs.mkdirSync(this.workDir, { recursive: true })
      fs.appendFileSync(this.logFile, `[${new Date().toISOString()}] ${text}\n`)
    } catch {
      /* logging only */
    }
    this.emit()
  }

  private step(index: number, label: string): void {
    this.logLine(`── ${label}`)
    this.set({ step: label, stepIndex: index, stepCount: STEP_COUNT })
  }

  private fail(err: unknown, fallbackStatus: UpdateStatus = 'error'): void {
    const message = (err as Error)?.message ?? String(err)
    this.logLine(`✗ ${message}`)
    this.deps.log(`[update] ${message}`)
    if (this.cancelled) this.set({ status: this.latestTag ? 'available' : 'idle', step: undefined, error: undefined })
    else this.set({ status: fallbackStatus, step: undefined, error: message })
  }

  // ---------------------------------------------------------- processes

  private async toolEnv(): Promise<Record<string, string>> {
    const env = { ...(await this.deps.getEnv()) }
    const https = env.HTTPS_PROXY || env.https_proxy
    const http = env.HTTP_PROXY || env.http_proxy
    if (https || http) {
      // @electron/get (Electron download during npm ci / electron-builder) needs these to use a proxy.
      env.ELECTRON_GET_USE_PROXY = '1'
      env.GLOBAL_AGENT_HTTPS_PROXY = https || http || ''
      env.GLOBAL_AGENT_HTTP_PROXY = http || https || ''
      const noProxy = env.NO_PROXY || env.no_proxy
      if (noProxy) env.GLOBAL_AGENT_NO_PROXY = noProxy
    }
    env.FORCE_COLOR = '0'
    env.NO_COLOR = '1'
    env.npm_config_color = 'false'
    env.npm_config_progress = 'false'
    delete env.ELECTRON_RUN_AS_NODE
    return env
  }

  private need(cmd: string, env: Record<string, string>): string {
    const found = findOnPath(cmd, env.PATH)
    if (!found) throw new Error(`"${cmd}" was not found on your shell PATH. Install it (or fix PATH) and try again.`)
    return found
  }

  private run(cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string>; label: string; capture?: boolean }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.cancelled) return reject(new Error('Cancelled'))
      this.logLine(`$ ${[path.basename(cmd), ...args].join(' ')}`)
      const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      let out = ''
      let rest = { out: '', err: '' }
      const feed = (key: 'out' | 'err', chunk: Buffer) => {
        const text = rest[key] + chunk.toString()
        const lines = text.split('\n')
        rest[key] = lines.pop() ?? ''
        for (const l of lines) {
          if (opts.capture && key === 'out') out += l + '\n'
          else this.logLine(l)
        }
      }
      child.stdout?.on('data', (c: Buffer) => feed('out', c))
      child.stderr?.on('data', (c: Buffer) => feed('err', c))
      child.on('error', (err) => {
        this.child = null
        reject(new Error(`${opts.label}: ${err.message}`))
      })
      child.on('close', (code, signal) => {
        this.child = null
        if (rest.out) (opts.capture ? (out += rest.out) : this.logLine(rest.out))
        if (rest.err) this.logLine(rest.err)
        rest = { out: '', err: '' }
        if (this.cancelled) return reject(new Error('Cancelled'))
        if (code === 0) return resolve(out)
        reject(new Error(`${opts.label} failed (exit ${code ?? signal ?? '?'})`))
      })
    })
  }

  cancel(): void {
    if (!this.busy) return
    this.cancelled = true
    const child = this.child
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    this.logLine('cancelled by user')
  }

  // ----------------------------------------------------------------- source

  private async ensureSource(git: string, env: Record<string, string>): Promise<void> {
    fs.mkdirSync(this.workDir, { recursive: true })
    const gitDir = path.join(this.srcDir, '.git')
    if (fs.existsSync(gitDir)) {
      const url = (await this.run(git, ['-C', this.srcDir, 'remote', 'get-url', 'origin'], { env, label: 'git remote', capture: true })).trim()
      if (url !== this.repo) await this.run(git, ['-C', this.srcDir, 'remote', 'set-url', 'origin', this.repo], { env, label: 'git remote set-url' })
      try {
        await this.run(git, ['-C', this.srcDir, 'fetch', '--tags', '--prune', '--force', '--quiet', 'origin'], { env, label: 'git fetch' })
        return
      } catch (err) {
        if (this.cancelled) throw err
        this.logLine(`fetch failed (${(err as Error).message}); cloning again`)
        fs.rmSync(this.srcDir, { recursive: true, force: true })
      }
    }
    fs.rmSync(this.srcDir, { recursive: true, force: true })
    await this.run(git, ['clone', '--quiet', this.repo, this.srcDir], { env, label: 'git clone' })
  }

  private async notesFor(git: string, env: Record<string, string>, tag: string, version: string): Promise<string | undefined> {
    try {
      const md = await this.run(git, ['-C', this.srcDir, 'show', `${tag}:CHANGELOG.md`], { env, label: 'git show', capture: true })
      const lines = md.split('\n')
      const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(\\s|$)`).test(l))
      if (start < 0) return undefined
      let end = lines.length
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) {
          end = i
          break
        }
      }
      return lines.slice(start, end).join('\n').trim()
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------------ check

  async check(): Promise<UpdateState> {
    if (this.state.status === 'unsupported' || this.busy) return this.state
    this.busy = true
    this.cancelled = false
    try {
      this.set({ status: 'checking', error: undefined, step: 'Fetching release tags', stepIndex: undefined, log: [], notes: undefined })
      const env = await this.toolEnv()
      const git = this.need('git', env)
      this.logLine(`repository: ${this.repo}`)
      await this.ensureSource(git, env)
      const out = await this.run(git, ['-C', this.srcDir, 'tag', '--list'], { env, label: 'git tag', capture: true })
      const tags = out
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => parseVersion(t) !== null)
        .sort(compareVersions)
      const latestTag = tags[tags.length - 1]
      const latest = latestTag ? latestTag.replace(/^v/, '') : undefined
      const checkedAt = Date.now()
      this.logLine(`tags: ${tags.join(', ') || '(none)'}; running ${this.state.currentVersion}`)
      if (!latest || compareVersions(latest, this.state.currentVersion) <= 0) {
        this.latestTag = undefined
        this.set({ status: 'up-to-date', latestVersion: latest, checkedAt, step: undefined, notes: undefined })
        return this.state
      }
      this.latestTag = latestTag
      const notes = await this.notesFor(git, env, latestTag, latest)
      this.set({ status: 'available', latestVersion: latest, notes, checkedAt, step: undefined })
      return this.state
    } catch (err) {
      this.fail(err)
      return this.state
    } finally {
      this.busy = false
    }
  }

  // ---------------------------------------------------------------- install

  private lockChanged(): boolean {
    const lock = path.join(this.srcDir, 'package-lock.json')
    const marker = path.join(this.srcDir, 'node_modules', '.claudegui-lock-sha256')
    if (!fs.existsSync(path.join(this.srcDir, 'node_modules')) || !fs.existsSync(lock)) return true
    const hash = createHash('sha256').update(fs.readFileSync(lock)).digest('hex')
    try {
      return fs.readFileSync(marker, 'utf8').trim() !== hash
    } catch {
      return true
    }
  }

  private writeLockMarker(): void {
    const lock = path.join(this.srcDir, 'package-lock.json')
    const marker = path.join(this.srcDir, 'node_modules', '.claudegui-lock-sha256')
    try {
      fs.writeFileSync(marker, createHash('sha256').update(fs.readFileSync(lock)).digest('hex'))
    } catch {
      /* next time: reinstall */
    }
  }

  private newBundlePath(): string {
    return path.join(this.stagingDir, 'mac-arm64', 'ClaudeGUI.app')
  }

  private bundleVersion(bundle: string): string | undefined {
    try {
      const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')
      const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
      return m?.[1]
    } catch {
      return undefined
    }
  }

  /** Build the latest version into the staging folder; restarts automatically when configured. */
  async install(): Promise<UpdateState> {
    if (this.state.status === 'unsupported' || this.busy) return this.state
    if (!this.latestTag) {
      await this.check()
      if (this.state.status !== 'available' || !this.latestTag) return this.state
    }
    const tag = this.latestTag
    const version = this.state.latestVersion || tag.replace(/^v/, '')
    this.busy = true
    this.cancelled = false
    try {
      this.set({ status: 'building', error: undefined, startedAt: Date.now(), finishedAt: undefined, log: [] })
      const env = await this.toolEnv()
      const git = this.need('git', env)
      const npm = this.need('npm', env)
      this.need('node', env)

      this.step(1, `Checking out ${tag}`)
      await this.ensureSource(git, env)
      await this.run(git, ['-C', this.srcDir, 'checkout', '--force', '--detach', `tags/${tag}`], { env, label: 'git checkout' })
      await this.run(git, ['-C', this.srcDir, 'clean', '-fdx', '-e', 'node_modules', '--quiet'], { env, label: 'git clean' })

      this.step(2, 'Installing dependencies')
      if (this.lockChanged()) {
        await this.run(npm, ['ci', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: this.srcDir, env, label: 'npm ci' })
        this.writeLockMarker()
      } else this.logLine('dependencies unchanged (lock file hash matches); skipping npm ci')

      this.step(3, `Building ClaudeGUI ${version}`)
      fs.rmSync(this.stagingDir, { recursive: true, force: true })
      await this.run(npm, ['run', 'build:mac', '--', `--config.directories.output=${this.stagingDir}`], { cwd: this.srcDir, env, label: 'build' })

      this.step(4, 'Verifying the new bundle')
      const bundle = this.newBundlePath()
      const built = this.bundleVersion(bundle)
      if (!built) throw new Error(`No app bundle found at ${bundle}`)
      if (built !== version) throw new Error(`Built bundle reports version ${built}, expected ${version}`)
      this.logLine(`✓ ClaudeGUI ${built} built at ${bundle}`)
      this.set({ status: 'ready', step: undefined, finishedAt: Date.now() })
      if (this.state.autoRestart) {
        this.logLine('restarting into the new version in 2 seconds…')
        setTimeout(() => void this.apply().catch((err) => this.fail(err)), 2000)
      }
      return this.state
    } catch (err) {
      this.fail(err)
      return this.state
    } finally {
      this.busy = false
    }
  }

  // ------------------------------------------------------------------ apply

  /** Hand over to the helper script and quit; the script swaps the bundle and reopens the app. */
  async apply(): Promise<void> {
    if (this.state.status !== 'ready') throw new Error('No update has been built yet')
    const target = this.deps.bundlePath
    const source = this.newBundlePath()
    if (!target) throw new Error('Cannot determine the running app bundle')
    if (!fs.existsSync(source)) throw new Error(`Built bundle is missing: ${source}`)
    this.set({ status: 'applying', step: 'Restarting into the new version…' })
    const script = path.join(this.workDir, 'apply-update.sh')
    fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o755 })
    const marker: PendingMarker = { from: this.state.currentVersion, to: this.state.latestVersion || '?', at: Date.now(), bundlePath: target, logFile: this.logFile }
    fs.writeFileSync(this.markerPath, JSON.stringify(marker, null, 2))
    this.logLine(`handing over to ${script}`)
    // `open` does not forward the environment; keep ClaudeGUI's own overrides (isolated data dir, debug port…).
    const envArgs: string[] = []
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('CLAUDEGUI_') && typeof v === 'string') envArgs.push('--env', `${k}=${v}`)
    const child = spawn('/bin/bash', [script, String(process.pid), target, source, this.logFile, ...envArgs], { detached: true, stdio: 'ignore', cwd: this.workDir })
    child.unref()
    this.deps.requestRestart()
  }
}

const APPLY_SCRIPT = `#!/bin/bash
# ClaudeGUI update helper: wait for the app to exit, swap the bundle in place, reopen the app.
# Usage: apply-update.sh <app pid> <installed bundle> <new bundle> <log file> [--env VAR=value ...]
PID="$1"; TARGET="$2"; NEW="$3"; LOG="$4"; shift 4
exec >>"$LOG" 2>&1
stamp() { date '+%Y-%m-%dT%H:%M:%S'; }
launch() { open "$@" "$TARGET"; }
echo "[$(stamp)] apply: waiting for pid $PID to exit"
for i in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PID" 2>/dev/null; then echo "[$(stamp)] apply: app still running after 60 s, giving up"; exit 1; fi
OLD="\${TARGET%.app}.previous.app"
rm -rf "$OLD"
if [ -e "$TARGET" ]; then
  mv "$TARGET" "$OLD" || { echo "[$(stamp)] apply: cannot move the installed bundle aside"; launch "$@"; exit 1; }
fi
if mv "$NEW" "$TARGET"; then
  echo "[$(stamp)] apply: installed new bundle at $TARGET"
  if launch "$@"; then
    sleep 2
    rm -rf "$OLD"
    echo "[$(stamp)] apply: previous bundle removed, done"
    exit 0
  fi
  echo "[$(stamp)] apply: could not launch the new bundle, rolling back"
  mv "$TARGET" "\${NEW%.app}.failed.app"
  mv "$OLD" "$TARGET"
  launch "$@"
  exit 1
fi
echo "[$(stamp)] apply: moving the new bundle failed, rolling back"
mv "$OLD" "$TARGET"
launch "$@"
exit 1
`
