import fs from 'fs'
import path from 'path'
import type { AppSettings, SessionRecord } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

export { DEFAULT_SETTINGS }

/** Tiny atomic JSON file store (no Electron dependency so the session host can use it too). */
export class JsonFile<T> {
  private file: string
  private data: T
  private writeTimer: NodeJS.Timeout | null = null
  constructor(dir: string, name: string, private defaults: T) {
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
  /** Re-read the file (used when another process may have written it). */
  reload(): T {
    this.data = this.load()
    return this.data
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

/** settings.json — owned by the app window process. */
export class SettingsStore {
  readonly settings: JsonFile<AppSettings>
  constructor(dir: string) {
    this.settings = new JsonFile<AppSettings>(dir, 'settings.json', DEFAULT_SETTINGS)
  }
  get(): AppSettings {
    return this.settings.get()
  }
  update(fn: (s: AppSettings) => AppSettings): AppSettings {
    return this.settings.update(fn)
  }
  addRecentDirectory(dir: string): void {
    this.settings.update((s) => ({
      ...s,
      recentDirectories: [dir, ...s.recentDirectories.filter((d) => d !== dir)].slice(0, 20)
    }))
  }
  flush(): void {
    this.settings.flush()
  }
}

interface SessionsFile {
  sessions: SessionRecord[]
  activeSessionId?: string
}

/** sessions.json — owned by the session host process. */
export class SessionsStore {
  readonly sessions: JsonFile<SessionsFile>
  constructor(dir: string) {
    this.sessions = new JsonFile<SessionsFile>(dir, 'sessions.json', { sessions: [] })
  }
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
  flush(): void {
    this.sessions.flush()
  }
}
