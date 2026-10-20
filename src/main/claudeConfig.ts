import { createHash, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveSettings, type SettingSource } from '@anthropic-ai/claude-agent-sdk'
import type { AppSettings, SessionLiveState, SessionRecord } from '@shared/types'
import { compareVersions, parseVersion } from '@shared/util'
import {
  CONFIG_SCOPES, isConfigObject, redactConfig, restoreConfigSecrets, sameConfig, sessionConfig, validateClaudeConfig,
  type ClaudeConfigView, type ConfigLayer, type ConfigSaveRequest, type ConfigSaveResult, type ConfigScope, type ConfigValues, type NativeConfigSnapshot
} from '@shared/claudeConfig'

const MAX_CONFIG_BYTES = 2 * 1024 * 1024
export function configRevision(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}
interface ConfigFile {
  values: ConfigValues
  revision: string
  stat?: fs.Stats
  warning?: string
}

export function readConfigFile(file: string): ConfigFile {
  let stat: fs.Stats
  try { stat = fs.lstatSync(file) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { values: {}, revision: configRevision(`missing:${path.resolve(file)}`) }
    throw new Error('The settings file could not be read. Check its permissions.')
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('The settings file is a link or is not a regular file. Use your editor to inspect it; it will not be overwritten here.')
  if (stat.size > MAX_CONFIG_BYTES) throw new Error('The settings file is larger than the configuration editor’s 2 MB limit.')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let raw: string
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('The settings file changed while reading. Reload before editing it.')
    raw = fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
  let values: unknown
  try { values = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) } catch { throw new Error('The settings file is not valid JSON. Correct it in your editor before saving here.') }
  if (!isConfigObject(values)) throw new Error('The settings file must contain a JSON object.')
  return { values, revision: configRevision(`${path.resolve(file)}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${raw}`), stat }
}

/** One bounded JSON-file edit, with no settings merging or policy interpretation of its own. */
export function writeConfigFile(file: string, values: ConfigValues, revision: string): void {
  const before = readConfigFile(file)
  if (before.revision !== revision) throw new Error('These settings changed elsewhere. Reload before saving; nothing was overwritten.')
  const directory = path.dirname(file)
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('The settings directory is a symbolic link. It will not be overwritten here.')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    if (before.stat && process.platform === 'darwin') {
      // macOS cp preserves extended attributes and ACLs as well as ordinary file metadata.
      fs.closeSync(fd)
      fd = undefined
      execFileSync('/bin/cp', ['-p', file, temporary], { stdio: 'ignore' })
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW)
      fs.ftruncateSync(fd, 0)
    }
    if (before.stat) {
      fs.fchmodSync(fd, before.stat.mode & 0o777)
      if (typeof process.getuid === 'function' && (before.stat.uid !== process.getuid() || before.stat.gid !== process.getgid?.())) fs.fchownSync(fd, before.stat.uid, before.stat.gid)
    }
    fs.writeFileSync(fd, JSON.stringify(values, null, 2) + '\n', 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (readConfigFile(file).revision !== revision) throw new Error('These settings changed while saving. Reload before saving; nothing was overwritten.')
    fs.renameSync(temporary, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
}

interface ConfigHost {
  status: { version?: string }
  list(): Promise<{ records: SessionRecord[]; live: SessionLiveState[] }>
  claudeConfig(id: string): Promise<NativeConfigSnapshot>
  setClaudeConfig(id: string, values: ConfigValues, revision: string): Promise<{ pending: boolean; restartRequired?: string[] }>
  noteUserActivity?(id: string): Promise<void>
}

/** The CLI canonicalizes its local consent store to an owned Git root on POSIX. */
function localProjectRoot(cwd: string): string {
  if (typeof process.getuid !== 'function') return cwd
  try {
    const root = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    if (root === fs.realpathSync(os.homedir())) return cwd
    const uid = process.geteuid?.() ?? process.getuid()
    for (const entry of [root, path.join(root, '.git'), path.join(root, '.claude')]) {
      try { if (fs.lstatSync(entry).uid !== uid) return cwd } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return cwd }
    }
    return root
  } catch { return cwd }
}

export class ClaudeConfigService {
  constructor(private host: ConfigHost, private getSettings: () => AppSettings) {}

  private async context(id: string) {
    const sessions = await this.host.list()
    const record = sessions.records.find((r) => r.id === id)
    if (!record) throw new Error('This chat no longer exists.')
    const settings = this.getSettings()
    const enabled: SettingSource[] = ['user', ...(settings.useProjectSettings ? ['project' as const] : []), ...(settings.useLocalSettings ? ['local' as const] : [])]
    const resolved = await resolveSettings({ cwd: record.cwd })
    const paths: Record<Exclude<ConfigScope, 'chat'>, string> = {
      user: resolved.sources.find((s) => s.source === 'user')?.path ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'),
      project: resolved.sources.find((s) => s.source === 'project')?.path ?? path.join(record.cwd, '.claude', 'settings.json'),
      local: resolved.sources.find((s) => s.source === 'local')?.path ?? path.join(localProjectRoot(record.cwd), '.claude', 'settings.local.json')
    }
    const chatSupported = compareVersions(this.host.status.version ?? '0.0.0', '1.0.64') >= 0
    const idleCompactionMinimumHostVersion = record.provider && record.provider !== 'anthropic' ? '1.0.67' : '1.0.65'
    const idleCompactionSupported = Boolean(parseVersion(this.host.status.version ?? '') && compareVersions(this.host.status.version!, idleCompactionMinimumHostVersion) >= 0)
    const snapshot = chatSupported ? await this.host.claudeConfig(id) : { saved: sessionConfig(record) }
    const live = sessions.live.find((s) => s.id === id)
    const resetWarning = live?.configRestartRequired?.length ? `Resetting these startup overrides fully applies when this chat next starts: ${live.configRestartRequired.join(', ')}. The running process has not been stopped.` : undefined
    const configWarning = [live?.configError, live?.configPending ? 'Saved changes are waiting for the current turn to finish.' : undefined, resetWarning].filter(Boolean).join(' ') || undefined
    return { record, enabled, resolved, paths, chatSupported, idleCompactionSupported, idleCompactionMinimumHostVersion, snapshot, running: Boolean(live?.processAlive), configWarning }
  }

  async get(id: string): Promise<ClaudeConfigView> {
    const ctx = await this.context(id)
    const layers = {} as ClaudeConfigView['layers']
    for (const { value: scope } of CONFIG_SCOPES) {
      const sources = scope === 'chat' ? ctx.enabled : ctx.enabled.filter((s) => ['user', 'project', 'local'].indexOf(s) < ['user', 'project', 'local'].indexOf(scope))
      const inherited = redactConfig((await resolveSettings({ cwd: ctx.record.cwd, settingSources: sources })).effective as ConfigValues)
      if (scope === 'chat') {
        const values = ctx.snapshot.saved
        layers.chat = {
          values: redactConfig(values), inherited, revision: configRevision(values), enabled: true, writable: ctx.chatSupported,
          warning: ctx.chatSupported ? ctx.configWarning : 'The running session host predates chat configuration. Shared settings can be edited now. Chat overrides need the new host after you fully quit and reopen ClaudeGUI when your running work is finished. No chats have been stopped.'
        }
      } else {
        const layer: ConfigLayer = { values: {}, inherited, revision: '', path: ctx.paths[scope], enabled: ctx.enabled.includes(scope), writable: true }
        try {
          const file = readConfigFile(ctx.paths[scope])
          layer.values = redactConfig(file.values)
          layer.revision = file.revision
        } catch (err) {
          layer.writable = false
          layer.warning = (err as Error).message
        }
        if (!layer.enabled) layer.warning = [layer.warning, 'This settings source is disabled in Settings → Claude. New chat processes will not load it; already-running processes may retain their startup sources.'].filter(Boolean).join(' ')
        layers[scope] = layer
      }
    }
    const live = ctx.snapshot.effective ? redactConfig(ctx.snapshot.effective) : undefined
    return { layers, managedKeys: Object.keys(ctx.resolved.sources.find((s) => s.source === 'managed')?.settings ?? {}), running: ctx.running, chatSupported: ctx.chatSupported, idleCompactionSupported: ctx.idleCompactionSupported, idleCompactionMinimumHostVersion: ctx.idleCompactionMinimumHostVersion, live }
  }

  async save(id: string, request: ConfigSaveRequest): Promise<ConfigSaveResult> {
    if (!request || !CONFIG_SCOPES.some((s) => s.value === request.scope) || !isConfigObject(request.values) || typeof request.revision !== 'string') throw new Error('Invalid configuration save request.')
    const ctx = await this.context(id)
    const { scope } = request
    if (scope !== 'chat' && request.confirmShared !== true) throw new Error('Confirm the shared scope before saving settings that affect other chats.')
    const current = scope === 'chat' ? { values: ctx.snapshot.saved, revision: configRevision(ctx.snapshot.saved) } : readConfigFile(ctx.paths[scope])
    if (current.revision !== request.revision) throw new Error('These settings changed elsewhere. Reload before saving; nothing was overwritten.')
    const values = restoreConfigSecrets(request.values, current.values)
    const errors = validateClaudeConfig(values, current.values, scope === 'chat')
    if (errors.length) throw new Error(errors.join('\n'))
    await this.host.noteUserActivity?.(id)
    let message: string
    if (scope === 'chat') {
      if (!ctx.chatSupported) throw new Error('Chat configuration needs the new session host. Finish running work, then fully quit and reopen ClaudeGUI; nothing has been stopped or changed.')
      if (!ctx.idleCompactionSupported && !sameConfig(values.idleCompaction, current.values.idleCompaction)) throw new Error(`Idle compaction for this provider needs session host ${ctx.idleCompactionMinimumHostVersion} or later. Finish running work, then fully quit and reopen ClaudeGUI. No chat or settings were changed.`)
      const result = await this.host.setClaudeConfig(id, values, request.revision)
      message = result.pending ? 'Chat settings saved. Live changes wait until the current turn finishes; startup-only settings apply when this chat next starts. No process was stopped.' : 'Chat settings saved. Claude Code accepted the live settings; startup-only settings apply when this chat next starts. No process was stopped.'
      if (result.restartRequired?.length) message += ' Resetting startup overrides fully takes effect when this chat next starts; see the warning above.'
      if (!ctx.running) message = 'Chat settings saved. They apply when this chat next starts.'
    } else {
      writeConfigFile(ctx.paths[scope], values, request.revision)
      message = 'Shared settings saved. Claude Code reloads supported settings; others apply when affected chats next start. Chat overrides and administrator policy still take precedence. No process was stopped.'
    }
    return { view: await this.get(id), message }
  }
}
