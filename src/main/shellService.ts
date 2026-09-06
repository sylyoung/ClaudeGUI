import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { shell } from 'electron'

export function findOnPath(cmd: string, envPath: string | undefined): string | null {
  for (const dir of (envPath ?? '').split(':')) {
    if (!dir) continue
    const full = path.join(dir, cmd)
    try {
      fs.accessSync(full, fs.constants.X_OK)
      return full
    } catch {
      /* next */
    }
  }
  return null
}

/** Pick a sensible default editor command from what is installed. */
export function detectEditorCommand(env: Record<string, string>): string {
  const p = env.PATH
  if (findOnPath('subl', p)) return 'subl {path}:{line}'
  if (findOnPath('cursor', p)) return 'cursor -g {path}:{line}'
  if (findOnPath('code', p)) return 'code -g {path}:{line}'
  if (findOnPath('zed', p)) return 'zed {path}:{line}'
  return 'open -t {path}'
}

function splitArgs(template: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export function openInEditor(command: string, file: string, line: number | undefined, env: Record<string, string>): void {
  const args = splitArgs(command).map((a) => a.replace('{path}', file).replace('{line}', String(line ?? 1)).replace(/:$/, ''))
  if (!args.length) return
  // If the template had ":{line}" but no line is known, strip the trailing ":1".
  const argv = args.map((a) => (line == null ? a.replace(/:1$/, '') : a))
  const [cmd, ...rest] = argv
  const child = spawn(cmd, rest, { env, detached: true, stdio: 'ignore' })
  child.on('error', (err) => {
    console.error('[shell] editor launch failed', err)
    shell.openPath(file)
  })
  child.unref()
}

export async function openExternal(url: string): Promise<void> {
  await shell.openExternal(url)
}

export async function openPath(p: string): Promise<string> {
  return shell.openPath(p)
}

export function showItemInFolder(p: string): void {
  shell.showItemInFolder(p)
}

export function openTerminal(dir: string, env: Record<string, string>): void {
  // Prefer Ghostty (the user's terminal), then iTerm, then Terminal.app.
  const candidates = ['Ghostty', 'iTerm', 'Terminal']
  for (const appName of candidates) {
    if (fs.existsSync(`/Applications/${appName}.app`)) {
      const child = spawn('open', ['-a', appName, dir], { env, detached: true, stdio: 'ignore' })
      child.unref()
      return
    }
  }
  const child = spawn('open', ['-a', 'Terminal', dir], { env, detached: true, stdio: 'ignore' })
  child.unref()
}

/** Open a file with a specific application bundle (`open -a App file`). */
export function openWithApp(appPath: string, file: string, env: Record<string, string>): void {
  const child = spawn('open', ['-a', appPath, file], { env, detached: true, stdio: 'ignore' })
  child.on('error', (err) => console.error('[shell] open -a failed', err))
  child.unref()
}
