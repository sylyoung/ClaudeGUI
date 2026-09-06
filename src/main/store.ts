import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { AppSettings, SessionRecord } from '@shared/types'

/** Tiny atomic JSON file store. */
class JsonFile<T> {
  private file: string
  private data: T
  private writeTimer: NodeJS.Timeout | null = null
  constructor(name: string, private defaults: T) {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, name)
    this.data = this.load()
  }
  private load(): T {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      return { ...this.defaults, ...parsed }
    } catch {
      return structuredClone(this.defaults)
    }
  }
  get(): T {
    return this.data
  }
  set(next: T): void {
    this.data = next
    this.scheduleWrite()
  }
  update(fn: (d: T) => T): T {
    this.data = fn(this.data)
    this.scheduleWrite()
    return this.data
  }
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.writeNow()
  }
  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.writeNow()
    }, 150)
  }
  private writeNow(): void {
    const tmp = this.file + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] write failed', this.file, err)
    }
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  // Claude
  claudeExecutable: '',
  defaultModel: '',
  defaultPermissionMode: 'default',
  defaultEffort: '',
  extraEnv: '',
  maxTurns: 0,
  maxThinkingTokens: 0,
  allowedTools: '',
  disallowedTools: '',
  useProjectSettings: true,
  useLocalSettings: true,
  autoTitle: true,
  // General
  notifications: true,
  notifyOnTurnFinished: true,
  notifyOnPermission: true,
  notifyOnError: true,
  notificationSound: true,
  dockBadge: true,
  resumeOnLaunch: 'none',
  confirmQuit: true,
  defaultCwd: '',
  sendWithEnter: true,
  recentDirectories: [],
  // Appearance
  theme: 'system',
  accent: 'system',
  fontSize: 14,
  uiFont: '',
  codeFont: '',
  codeFontSize: 12.5,
  density: 'comfortable',
  showTimestamps: true,
  thinkingDisplay: 'collapsed',
  toolCardsExpanded: false,
  chatMaxWidth: 980,
  groupSessionsByFolder: true,
  translucentSidebar: false,
  // Files
  editorCommand: '',
  showHiddenFiles: false,
  excludePatterns: 'node_modules, .git, __pycache__, .DS_Store',
  openBinaryWithSystemApp: true,
  doubleClickAction: 'system',
  autoRevealEditedFiles: false,
  maxPreviewKB: 1500,
  showFileSizes: true,
  // Git
  gitEnabled: true,
  gitShowStatusInTree: true,
  gitAutoRefreshSeconds: 30,
  gitAutoFetchMinutes: 0,
  gitPushAfterCommit: false,
  gitSignOff: false,
  gitCommitTemplate: '',
  // Usage
  usageRefreshMinutes: 5,
  usageWarnPercent: 80,
  showUsageStatus: true,
  showContextInSidebar: true,
  showTaskCountsInSidebar: true,
  // Advanced
  toolResultMaxChars: 60000,
  debugServer: false,
  debugPort: 45123
}

/** Split a comma/newline separated setting into trimmed, non-empty items. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

interface SessionsFile {
  sessions: SessionRecord[]
  activeSessionId?: string
}

export class AppStore {
  readonly settings = new JsonFile<AppSettings>('settings.json', DEFAULT_SETTINGS)
  readonly sessions = new JsonFile<SessionsFile>('sessions.json', { sessions: [] })

  listSessions(): SessionRecord[] {
    return this.sessions.get().sessions
  }
  getSession(id: string): SessionRecord | undefined {
    return this.listSessions().find((s) => s.id === id)
  }
  upsertSession(record: SessionRecord): void {
    this.sessions.update((d) => {
      const idx = d.sessions.findIndex((s) => s.id === record.id)
      const sessions = [...d.sessions]
      if (idx >= 0) sessions[idx] = record
      else sessions.unshift(record)
      return { ...d, sessions }
    })
  }
  removeSession(id: string): void {
    this.sessions.update((d) => ({ ...d, sessions: d.sessions.filter((s) => s.id !== id) }))
  }
  setActiveSession(id: string | undefined): void {
    this.sessions.update((d) => ({ ...d, activeSessionId: id }))
  }
  getActiveSession(): string | undefined {
    return this.sessions.get().activeSessionId
  }
  addRecentDirectory(dir: string): void {
    this.settings.update((s) => ({
      ...s,
      recentDirectories: [dir, ...s.recentDirectories.filter((d) => d !== dir)].slice(0, 20)
    }))
  }
  flush(): void {
    this.settings.flush()
    this.sessions.flush()
  }
}
