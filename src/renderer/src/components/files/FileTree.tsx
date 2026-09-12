import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, ChevronDown, ChevronRight, File, FileCode, FileImage, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { FileSort, FsEntry, GitFileState, GitFileStatus, GitStatusResult } from '@shared/types'
import { useStore } from '@/store'
import { editedFiles } from '@/lib/editedFiles'
import { basename, formatBytes } from '@/lib/format'
import { openFileFromClick } from '@/lib/openFiles'
import { ContextMenu, type MenuItem } from '../common/ContextMenu'
import { gitLetter } from '../git/GitPanel'

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.sh', '.json', '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.sql', '.r', '.m', '.tex', '.lua', '.swift', '.kt'])
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])
/** Directory bundles that macOS treats as documents (opened with their app, not expanded). */
const BUNDLE_EXT = new Set(['.app', '.pages', '.numbers', '.key', '.xcodeproj', '.xcworkspace', '.bundle', '.framework', '.photoslibrary', '.rtfd', '.scptd', '.playground', '.band', '.logicx', '.fcpbundle', '.imovielibrary'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The orders offered above the tree; folders always come before files. */
const SORTS: { key: FileSort; label: string; tip: string }[] = [
  { key: 'name', label: 'Name (A → Z)', tip: 'Alphabetical, numbers in natural order' },
  { key: 'name-desc', label: 'Name (Z → A)', tip: 'Reverse alphabetical' },
  { key: 'modified', label: 'Recently changed first', tip: 'Newest change at the top' },
  { key: 'size', label: 'Largest first', tip: 'Biggest files at the top' },
  { key: 'type', label: 'Type, then name', tip: 'Grouped by file extension' }
]

function sortEntries(list: FsEntry[], mode: FileSort): FsEntry[] {
  const byName = (a: FsEntry, b: FsEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  const cmp = (a: FsEntry, b: FsEntry): number => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    switch (mode) {
      case 'name-desc': return -byName(a, b)
      case 'modified': return b.mtime - a.mtime || byName(a, b)
      case 'size': return b.size - a.size || byName(a, b)
      case 'type': return a.ext.localeCompare(b.ext) || byName(a, b)
      default: return byName(a, b)
    }
  }
  return [...list].sort(cmp)
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

function iconFor(e: FsEntry, open: boolean) {
  if (e.isDir) return open ? <FolderOpen size={14} color="var(--folder)" /> : <Folder size={14} color="var(--folder)" />
  if (IMG_EXT.has(e.ext)) return <FileImage size={14} />
  if (CODE_EXT.has(e.ext)) return <FileCode size={14} />
  if (e.ext === '.md' || e.ext === '.txt') return <FileText size={14} />
  return <File size={14} />
}

interface GitIndex {
  byPath: Map<string, GitFileStatus>
  dirs: Map<string, 'changed' | 'untracked'>
  root?: string
}

function buildGitIndex(status: GitStatusResult | undefined): GitIndex {
  const byPath = new Map<string, GitFileStatus>()
  const dirs = new Map<string, 'changed' | 'untracked'>()
  if (!status?.info.isRepo || !status.info.root) return { byPath, dirs }
  const root = status.info.root
  for (const f of status.files) {
    const abs = f.absPath.replace(/\/$/, '')
    byPath.set(abs, f)
    if (f.worktree === 'ignored') continue
    const kind: 'changed' | 'untracked' = f.worktree === 'untracked' && !f.index ? 'untracked' : 'changed'
    let cur = abs
    while (cur.length > root.length) {
      cur = cur.slice(0, cur.lastIndexOf('/'))
      if (cur.length < root.length) break
      const prev = dirs.get(cur)
      if (prev !== 'changed') dirs.set(cur, kind)
    }
  }
  return { byPath, dirs, root }
}

function gitStateFor(entry: FsEntry, idx: GitIndex): { state: GitFileState | null; staged: boolean } {
  const exact = idx.byPath.get(entry.path)
  if (exact) return { state: exact.worktree ?? exact.index, staged: !exact.worktree && Boolean(exact.index) }
  let cur = entry.path
  while (cur.includes('/')) {
    cur = cur.slice(0, cur.lastIndexOf('/'))
    if (idx.root && cur.length < idx.root.length) break
    const d = idx.byPath.get(cur)
    if (d && d.isDir) return { state: d.worktree, staged: false }
  }
  return { state: null, staged: false }
}

export function FileTree({ sessionId, root }: { sessionId: string; root: string }) {
  const files = useStore((s) => s.files[sessionId])
  const expanded = files?.expanded ?? []
  const active = files?.active
  const revealPath = files?.revealPath
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const openFile = useStore((s) => s.openFile)
  const setRevealPath = useStore((s) => s.setRevealPath)
  const bumpFileVersion = useStore((s) => s.bumpFileVersion)
  const toast = useStore((s) => s.toast)
  const runGit = useStore((s) => s.runGit)
  const settings = useStore((s) => s.settings)
  const showHidden = settings?.showHiddenFiles ?? false
  const showSizes = settings?.showFileSizes ?? true
  const excludePatterns = settings?.excludePatterns ?? ''
  const openMode = settings?.openFilesWith ?? 'system'
  const doubleClick = settings?.doubleClickAction ?? 'system'
  const autoReveal = settings?.autoRevealEditedFiles ?? false
  const gitBadges = (settings?.gitEnabled ?? true) && (settings?.gitShowStatusInTree ?? true)
  const sortMode: FileSort = settings?.fileSort ?? 'name'
  const setSettings = useStore((s) => s.setSettings)
  const gitStatus = useStore((s) => s.git[sessionId]?.status)
  const messages = useStore((s) => s.messages[sessionId])
  const gitIndex = useMemo(() => (gitBadges ? buildGitIndex(gitStatus) : { byPath: new Map(), dirs: new Map() }), [gitStatus, gitBadges])
  // Files Claude changed in this chat get a dot; recomputed only when the transcript changes.
  const edited = useMemo(() => editedFiles(messages, root), [messages, root])
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const seenEdits = useRef(new Set<string>())
  const mountedAt = useRef(Date.now())

  const load = useCallback(
    async (dir: string) => {
      try {
        const list = await window.api.fs.list(dir, showHidden)
        setChildren((c) => ({ ...c, [dir]: list }))
        void window.api.fs.watch(dir)
      } catch {
        setChildren((c) => ({ ...c, [dir]: [] }))
      }
    },
    [showHidden]
  )

  // load root + expanded dirs
  useEffect(() => {
    void load(root)
    for (const d of expanded) if (d.startsWith(root)) void load(d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, expanded.join('|'), showHidden, excludePatterns])

  // refresh on fs changes
  useEffect(() => {
    return window.api.events.onFsChanged((dir) => {
      if (dir === root || expanded.includes(dir)) void load(dir)
      // A file inside dir may have changed: refresh open viewers for files in that dir.
      const list = children[dir]
      if (list) for (const e of list) if (!e.isDir) bumpFileVersion(e.path)
    })
  }, [root, expanded, load, children, bumpFileVersion])

  // reveal: expand ancestors and scroll
  useEffect(() => {
    if (!revealPath) return
    const parts = revealPath.slice(root.length).split('/').filter(Boolean)
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur + '/' + parts[i]
      toggleExpanded(sessionId, cur, true)
    }
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector(`[data-path="${CSS.escape(revealPath)}"]`)
      el?.scrollIntoView({ block: 'center' })
      setRevealPath(sessionId, undefined)
    }, 350)
    return () => clearTimeout(t)
  }, [revealPath, root, sessionId, toggleExpanded, setRevealPath])

  // reveal files Claude just edited (Settings → Files)
  useEffect(() => {
    if (!autoReveal || !messages?.length) return
    let latest: string | undefined
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - 20; i--) {
      const m = messages[i]
      if (m.kind !== 'assistant') continue
      for (const b of m.blocks) {
        if (b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name) || b.status !== 'done' || b.startedAt < mountedAt.current || seenEdits.current.has(b.id)) continue
        seenEdits.current.add(b.id)
        const p = (b.input.file_path ?? b.input.notebook_path) as string | undefined
        if (p && p.startsWith(root + '/')) latest = p
      }
    }
    if (latest) setRevealPath(sessionId, latest)
  }, [messages, autoReveal, root, sessionId, setRevealPath])

  const openExternally = (p: string) => window.api.shell.openPath(p).then((err) => err && toast(err, 'error'))

  /** Single click: folders expand; files open the way Settings → Files says (default: their macOS app). */
  const activate = async (e: FsEntry) => {
    if (e.isDir) {
      if (BUNDLE_EXT.has(extOf(e.name))) return openExternally(e.path)
      toggleExpanded(sessionId, e.path)
      return
    }
    try {
      await openFileFromClick(sessionId, e.path)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  const onDouble = (e: FsEntry) => {
    if (e.isDir && !BUNDLE_EXT.has(extOf(e.name))) return
    // The single click has already handed the file to its app; do not open it a second time.
    if (doubleClick === 'system' && (openMode === 'system' || e.isDir)) return
    if (doubleClick === 'editor') void window.api.shell.openInEditor(e.path)
    else if (doubleClick === 'viewer') openFile(sessionId, e.path)
    else void openExternally(e.path)
  }

  const entryMenu = (e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault()
    e.stopPropagation()
    const rel = entry.path.startsWith(root + '/') ? entry.path.slice(root.length + 1) : entry.path
    const g = gitStateFor(entry, gitIndex)
    const inRepo = Boolean(gitStatus?.info.isRepo) && (settings?.gitEnabled ?? true)
    const cwd = root
    const run = (label: string, fn: () => Promise<unknown>) => runGit(sessionId, label, fn)
    const items: MenuItem[] = [
      ...(entry.isDir ? [] : [{ label: 'Open in viewer', onClick: () => openFile(sessionId, entry.path) }]),
      { label: 'Open with default app', onClick: () => openExternally(entry.path) },
      { label: 'Open with…', onClick: () => window.api.shell.openWith(entry.path) },
      ...(entry.isDir ? [] : [{ label: 'Open in editor', onClick: () => window.api.shell.openInEditor(entry.path) }]),
      { label: 'Reveal in Finder', onClick: () => window.api.shell.showInFolder(entry.path) },
      ...(entry.isDir ? [{ label: 'Open in Terminal', onClick: () => window.api.shell.openTerminal(entry.path) }] : [])
    ]
    if (inRepo) {
      items.push({ label: '', onClick: () => undefined, separator: true })
      const tracked = g.state !== null && g.state !== 'untracked' && g.state !== 'ignored'
      if (g.state === 'ignored') items.push({ label: 'Git: track anyway (force add)', onClick: () => run('Stage', () => window.api.git.stage(cwd, [entry.path], true)) })
      else if (g.staged) items.push({ label: 'Git: unstage', onClick: () => run('Unstage', () => window.api.git.unstage(cwd, [entry.path])) })
      else items.push({ label: g.state === 'untracked' || g.state === null ? (g.state === null ? 'Git: stage (already tracked)' : 'Git: track (stage)') : 'Git: stage changes', onClick: () => run('Stage', () => window.api.git.stage(cwd, [entry.path])) })
      if (tracked || g.state === null) items.push({ label: 'Git: untrack (keep file)', onClick: () => run('Untrack', () => window.api.git.untrack(cwd, [entry.path])) })
      if (g.state !== 'ignored') items.push({ label: 'Git: add to .gitignore', onClick: () => run('Ignore', () => window.api.git.ignore(cwd, [rel + (entry.isDir ? '/' : '')])) })
      if (g.state && g.state !== 'untracked' && g.state !== 'ignored') items.push({ label: 'Git: discard changes…', danger: true, onClick: () => { if (confirm(`Restore ${rel} from the last commit?`)) void run('Discard', () => window.api.git.discard(cwd, [{ path: rel, index: g.staged ? g.state : null, worktree: g.staged ? null : g.state }])) } })
    }
    items.push({ label: '', onClick: () => undefined, separator: true })
    items.push({
      label: inRepo ? 'Delete… (git rm / Trash)' : 'Move to Trash…',
      danger: true,
      onClick: () => {
        if (!confirm(`Delete ${entry.name}?${inRepo ? '\n\nTracked files are removed with git rm; other files go to the Trash.' : '\n\nIt will be moved to the Trash.'}`)) return
        if (inRepo) void run('Delete', () => window.api.git.delete(cwd, [entry.path]))
        else window.api.fs.trash(entry.path).then(() => load(entry.path.slice(0, entry.path.lastIndexOf('/')))).catch((err) => toast(err.message, 'error'))
      }
    })
    items.push({ label: '', onClick: () => undefined, separator: true })
    items.push({ label: 'Copy path', onClick: () => window.api.shell.copy(entry.path) })
    items.push({ label: 'Copy relative path', onClick: () => window.api.shell.copy(rel) })
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const raw = children[dir]
    if (!raw) return <div className="faint" style={{ paddingLeft: 12 + depth * 14, fontSize: 11.5 }}>loading…</div>
    if (!raw.length) return <div className="faint" style={{ paddingLeft: 12 + depth * 14, fontSize: 11.5 }}>(empty)</div>
    const list = sortEntries(raw, sortMode)
    return list.map((e) => {
      const isBundle = e.isDir && BUNDLE_EXT.has(extOf(e.name))
      const isOpen = e.isDir && !isBundle && expanded.includes(e.path)
      const g = gitBadges ? gitStateFor(e, gitIndex) : { state: null, staged: false }
      const dirMark = gitBadges && e.isDir ? gitIndex.dirs.get(e.path) : undefined
      const cls = g.state ? `git-${g.state}${g.staged ? ' git-staged' : ''}` : ''
      return (
        <div key={e.path}>
          <div
            className={`tree-row ${active === e.path ? 'selected' : ''} ${cls}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            data-path={e.path}
            onClick={(ev) => {
              // The second click of a double click is not another single click.
              if (ev.detail > 1) return
              if (ev.altKey || ev.metaKey) void window.api.shell.openInEditor(e.path)
              else void activate(e)
            }}
            onDoubleClick={() => onDouble(e)}
            onContextMenu={(ev) => entryMenu(ev, e)}
            data-tip={`${e.path}${g.state ? `\n(git: ${g.state}${g.staged ? ', staged' : ''})` : ''}`}
          >
            <span className="chev">{e.isDir && !isBundle ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}</span>
            {iconFor(e, isOpen)}
            <span className={`name ${e.isDir ? 'dir' : 'file'}`}>{e.name}</span>
            {dirMark && !g.state && <span className={`dir-mark ${dirMark}`} data-tip={dirMark === 'untracked' ? 'contains untracked files' : 'contains changes'} />}
            {g.state && !(e.isDir && !isBundle && g.state !== 'untracked' && g.state !== 'ignored') && <span className={`g-badge st-${g.state}`}>{gitLetter(g.state)}</span>}
            {!e.isDir && edited.has(e.path) && <span className="edited-mark" data-tip="Claude edited this file in this chat" />}
            {!e.isDir && showSizes && <span className="size">{formatBytes(e.size)}</span>}
          </div>
          {isOpen && renderDir(e.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div className="tree" ref={containerRef}>
      <div className="tree-root" data-tip={root}>
        <Folder size={13} color="var(--folder)" /> <span className="ellipsis">{basename(root)}</span>
        {gitBadges && gitStatus?.info.isRepo && gitStatus.info.branch && <span className="faint mono" style={{ fontSize: 10.5, fontWeight: 400 }}>⎇ {gitStatus.info.branch}</span>}
        <button
          className="btn ghost icon"
          style={{ marginLeft: 'auto' }}
          data-tip={`Order of the files: ${SORTS.find((o) => o.key === sortMode)?.label ?? 'Name (A → Z)'} — click to change`}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenu({
              x: r.left,
              y: r.bottom + 4,
              items: SORTS.map((o) => ({
                label: o.label,
                checked: o.key === sortMode,
                onClick: () => void setSettings({ fileSort: o.key })
              }))
            })
          }}
        >
          <ArrowDownUp size={12} />
        </button>
        <button className="btn ghost icon" data-tip="Refresh" onClick={() => { void load(root); for (const d of expanded) void load(d) }}>
          <RefreshCw size={12} />
        </button>
      </div>
      {renderDir(root, 0)}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
