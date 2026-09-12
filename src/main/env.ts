import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Capture the environment the Claude Code CLI sees when the user runs `claude` from a terminal.
 * Electron apps launched from Finder/Dock only inherit a minimal environment, and many users
 * wrap `claude` in a shell function/alias that sets proxies or other variables.
 *
 * Strategy: run the login shell (zsh -ilc) and invoke `claude` with a stand-in executable placed
 * first on PATH; the stand-in prints its environment as JSON. Whatever wrapper function or alias
 * the user has defined therefore contributes exactly the variables it would give the real CLI.
 * Falls back to the plain login-shell environment.
 */
let cached: Promise<Record<string, string>> | null = null

export function getLoginShellEnv(): Promise<Record<string, string>> {
  if (!cached) cached = captureLoginEnv()
  return cached
}

export function resetLoginShellEnvCache(): void {
  cached = null
}

const MARKER = '__CLAUDEGUI_ENV_JSON__'
const DUMP_CMD = `printf '%s' '${MARKER}'; python3 -c 'import os,json;print(json.dumps(dict(os.environ)))' 2>/dev/null || env; printf '%s' '${MARKER}'`

function runLoginShell(script: string): Promise<string> {
  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', script], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
      if (err && !stdout) return resolve('')
      resolve(String(stdout || ''))
    })
  })
}

function parseDump(out: string): Record<string, string> | null {
  const start = out.indexOf(MARKER)
  const end = out.lastIndexOf(MARKER)
  if (start < 0 || end <= start) return null
  const body = out.slice(start + MARKER.length, end).trim()
  const result: Record<string, string> = {}
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') result[k] = v
      return result
    }
  } catch {
    for (const line of body.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) result[line.slice(0, i)] = line.slice(i + 1)
    }
    if (Object.keys(result).length) return result
  }
  return null
}

async function captureThroughClaudeWrapper(): Promise<Record<string, string> | null> {
  let dir: string | null = null
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegui-env-'))
    const fake = path.join(dir, 'claude')
    fs.writeFileSync(fake, `#!/bin/sh\n${DUMP_CMD}\n`, { mode: 0o755 })
    const out = await runLoginShell(`export PATH="${dir}:$PATH"; claude`)
    const env = parseDump(out)
    if (env) {
      // Remove the stand-in directory from PATH again.
      if (env.PATH) env.PATH = env.PATH.split(':').filter((p) => p !== dir).join(':')
      return env
    }
  } catch {
    /* fall through */
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
  return null
}

async function captureLoginEnv(): Promise<Record<string, string>> {
  const viaWrapper = await captureThroughClaudeWrapper()
  if (viaWrapper && viaWrapper.PATH) return viaWrapper
  const plain = parseDump(await runLoginShell(DUMP_CMD))
  if (plain && plain.PATH) return plain
  // Fallback: at least make common tool locations reachable.
  const home = os.homedir()
  return {
    PATH: [`${home}/.local/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || '']
      .filter(Boolean)
      .join(':')
  }
}

export interface LauncherCapture {
  env: Record<string, string>
  /** Arguments the launcher would have given the CLI ("--effort", "xhigh", "--permission-mode=..."). */
  argv: string[]
  stderr: string
  exitCode: number | null
}

/**
 * Run a launcher command (a shell function or alias such as `cc-gpt sol xhigh fast`) in the login
 * shell with a stand-in `claude` first on PATH. Whatever the launcher does first (health checks,
 * starting a local bridge, reading keys from the Keychain) happens as in the terminal; the stand-in
 * then records the environment and the arguments the real CLI would have received.
 */
export async function captureLauncher(command: string): Promise<LauncherCapture> {
  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegui-launch-'))
  try {
    const fake = path.join(dir, 'claude')
    const dump = `printf '%s' '${MARKER}'; python3 -c 'import os,json,sys;print(json.dumps({"env":dict(os.environ),"argv":sys.argv[1:]}))' "$@"; printf '%s' '${MARKER}'`
    fs.writeFileSync(fake, `#!/bin/sh\n${dump}\n`, { mode: 0o755 })
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      execFile(shell, ['-ilc', `export PATH="${dir}:$PATH"; ${command}`], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TERM: 'dumb' } }, (err, stdout, stderr) => {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? ((err as { code?: number }).code ?? 1) : 0 })
      })
    })
    const start = result.stdout.indexOf(MARKER)
    const end = result.stdout.lastIndexOf(MARKER)
    if (start < 0 || end <= start) return { env: {}, argv: [], stderr: result.stderr, exitCode: result.code }
    const parsed = JSON.parse(result.stdout.slice(start + MARKER.length, end).trim()) as { env: Record<string, unknown>; argv: unknown[] }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed.env ?? {})) if (typeof v === 'string') env[k] = v
    if (env.PATH) env.PATH = env.PATH.split(':').filter((p) => p !== dir).join(':')
    return { env, argv: (parsed.argv ?? []).map(String), stderr: result.stderr, exitCode: result.code }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Parse "KEY=VALUE" lines (comments with # allowed) into an object. */
export function parseExtraEnv(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    const key = line.slice(0, i).trim().replace(/^export\s+/, '')
    let value = line.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

/** Environment to give spawned tools: process.env overlaid with the login/wrapper env, then extras. */
export async function getSpawnEnv(extra: Record<string, string | undefined> = {}): Promise<Record<string, string>> {
  return mergeSpawnEnv(await getLoginShellEnv(), extra)
}

/** process.env overlaid with a captured shell environment, then extras, minus Electron's own variables. */
export function mergeSpawnEnv(captured: Record<string, string>, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') merged[k] = v
  for (const [k, v] of Object.entries(captured)) merged[k] = v
  for (const [k, v] of Object.entries(extra)) if (typeof v === 'string') merged[k] = v
  // Electron-specific variables must not leak into the CLI process.
  delete merged.ELECTRON_RUN_AS_NODE
  delete merged.ELECTRON_NO_ATTACH_CONSOLE
  delete merged.ORIGINAL_XDG_CURRENT_DESKTOP
  return merged
}
