import fs from 'fs'
import path from 'path'
import type { FileContent, FileProbe, FsEntry } from '@shared/types'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonl': 'json', '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.sh': 'bash', '.zsh': 'bash', '.bash': 'bash', '.fish': 'bash',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
  '.md': 'markdown', '.markdown': 'markdown', '.html': 'xml', '.htm': 'xml', '.xml': 'xml', '.svg': 'xml',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.sql': 'sql', '.r': 'r', '.R': 'r', '.m': 'matlab',
  '.tex': 'latex', '.bib': 'latex', '.lua': 'lua', '.pl': 'perl', '.dockerfile': 'dockerfile', '.diff': 'diff', '.patch': 'diff',
  '.txt': 'plaintext', '.log': 'plaintext', '.csv': 'plaintext', '.tsv': 'plaintext', '.env': 'bash', '.gitignore': 'plaintext'
}

export function languageFor(file: string): string {
  const base = path.basename(file).toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  if (base === 'claude.md') return 'markdown'
  const ext = path.extname(base)
  return LANGUAGES[ext] ?? 'plaintext'
}

/** macOS document bundles: directories that Finder shows (and opens) as single files. */
const BUNDLE_EXT = new Set([
  '.app', '.pages', '.numbers', '.key', '.xcodeproj', '.xcworkspace', '.bundle', '.framework', '.photoslibrary', '.rtfd', '.scptd',
  '.playground', '.band', '.logicx', '.fcpbundle', '.imovielibrary', '.sparsebundle', '.pbxproj', '.nib', '.lproj', '.kext', '.prefpane'
])

export function isBundle(p: string): boolean {
  return BUNDLE_EXT.has(path.extname(p).toLowerCase())
}

function matchesExclude(name: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (!pat) continue
    if (pat.startsWith('*.')) {
      if (name.toLowerCase().endsWith(pat.slice(1).toLowerCase())) return true
    } else if (pat.endsWith('*')) {
      if (name.startsWith(pat.slice(0, -1))) return true
    } else if (name === pat) return true
  }
  return false
}

export async function listDir(dir: string, showHidden: boolean, exclude: string[] = []): Promise<FsEntry[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true })
  const entries: FsEntry[] = []
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith('.')) continue
    if (exclude.length && matchesExclude(d.name, exclude)) continue
    const full = path.join(dir, d.name)
    let isDir = d.isDirectory()
    let size = 0
    let mtime = 0
    const isSymlink = d.isSymbolicLink()
    try {
      const st = await fs.promises.stat(full)
      isDir = st.isDirectory()
      size = st.size
      mtime = st.mtimeMs
    } catch {
      if (isSymlink) {
        // broken symlink; still list it
      } else continue
    }
    entries.push({ name: d.name, path: full, isDir, isSymlink, size, mtime, ext: isDir ? '' : path.extname(d.name).toLowerCase() })
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  })
  return entries
}

const MAX_TEXT = 1_500_000
const MAX_IMAGE = 20_000_000

/** Cheap classification of a path without reading the whole file (8 KB probe). */
export async function probeFile(file: string): Promise<FileProbe> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(file)
  } catch {
    return { kind: 'missing', size: 0, ext: '' }
  }
  const ext = path.extname(file).toLowerCase()
  if (st.isDirectory()) return { kind: isBundle(file) ? 'bundle' : 'dir', size: 0, ext }
  if (IMAGE_TYPES[ext]) return { kind: st.size > MAX_IMAGE ? 'too-large' : 'image', size: st.size, ext }
  if (st.size === 0) return { kind: 'text', size: 0, ext }
  const fh = await fs.promises.open(file, 'r')
  try {
    const probe = Buffer.alloc(Math.min(8192, st.size))
    await fh.read(probe, 0, probe.length, 0)
    if (probe.includes(0)) return { kind: 'binary', size: st.size, ext }
  } finally {
    await fh.close()
  }
  return { kind: 'text', size: st.size, ext }
}

export async function readFileContent(file: string, maxText = MAX_TEXT): Promise<FileContent> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(file)
  } catch {
    return { path: file, kind: 'missing', size: 0, mtime: 0 }
  }
  const ext = path.extname(file).toLowerCase()
  const base = { path: file, size: st.size, mtime: st.mtimeMs }
  if (st.isDirectory()) return { ...base, kind: 'binary' }
  if (IMAGE_TYPES[ext]) {
    if (st.size > MAX_IMAGE) return { ...base, kind: 'too-large' }
    const buf = await fs.promises.readFile(file)
    return { ...base, kind: 'image', base64: buf.toString('base64'), mimeType: IMAGE_TYPES[ext] }
  }
  const fh = await fs.promises.open(file, 'r')
  try {
    const probe = Buffer.alloc(Math.min(8192, st.size))
    await fh.read(probe, 0, probe.length, 0)
    if (probe.includes(0)) return { ...base, kind: 'binary' }
    const toRead = Math.min(st.size, maxText)
    const buf = Buffer.alloc(toRead)
    await fh.read(buf, 0, toRead, 0)
    return { ...base, kind: 'text', text: buf.toString('utf8'), language: languageFor(file), truncated: st.size > maxText }
  } finally {
    await fh.close()
  }
}

export async function pathExists(p: string): Promise<{ exists: boolean; isDir: boolean }> {
  try {
    const st = await fs.promises.stat(p)
    return { exists: true, isDir: st.isDirectory() }
  } catch {
    return { exists: false, isDir: false }
  }
}

/** Resolve a path mentioned in chat text against the session cwd. */
export function resolveMentionedPath(raw: string, cwd: string, home: string): string {
  let p = raw.trim()
  if (p.startsWith('~/') || p === '~') p = path.join(home, p.slice(1))
  if (!path.isAbsolute(p)) p = path.resolve(cwd, p)
  return p
}

type Listener = (dir: string) => void

export class DirWatcher {
  private watchers = new Map<string, fs.FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()
  constructor(private onChange: Listener) {}

  watch(dir: string): void {
    if (this.watchers.has(dir)) return
    if (this.watchers.size > 150) {
      const oldest = this.watchers.keys().next().value
      if (oldest) this.unwatch(oldest)
    }
    try {
      const w = fs.watch(dir, { persistent: false }, () => {
        const t = this.timers.get(dir)
        if (t) clearTimeout(t)
        this.timers.set(
          dir,
          setTimeout(() => {
            this.timers.delete(dir)
            this.onChange(dir)
          }, 250)
        )
      })
      w.on('error', () => this.unwatch(dir))
      this.watchers.set(dir, w)
    } catch {
      /* directory vanished or unreadable */
    }
  }

  unwatch(dir: string): void {
    const w = this.watchers.get(dir)
    if (w) {
      w.close()
      this.watchers.delete(dir)
    }
  }

  closeAll(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}
