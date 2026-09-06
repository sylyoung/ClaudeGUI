import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, File, FileCode, FileImage, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { FsEntry } from '@shared/types'
import { useStore } from '@/store'
import { basename, formatBytes } from '@/lib/format'
import { ContextMenu, type MenuItem } from '../common/ContextMenu'

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.sh', '.json', '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.sql', '.r', '.m', '.tex', '.lua', '.swift', '.kt'])
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

function iconFor(e: FsEntry, open: boolean) {
  if (e.isDir) return open ? <FolderOpen size={14} color="var(--amber)" /> : <Folder size={14} color="var(--amber)" />
  if (IMG_EXT.has(e.ext)) return <FileImage size={14} />
  if (CODE_EXT.has(e.ext)) return <FileCode size={14} />
  if (e.ext === '.md' || e.ext === '.txt') return <FileText size={14} />
  return <File size={14} />
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
  const showHidden = useStore((s) => s.settings?.showHiddenFiles ?? false)
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

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
  }, [root, expanded.join('|'), showHidden])

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
    }, 250)
    return () => clearTimeout(t)
  }, [revealPath, root, sessionId, toggleExpanded, setRevealPath])

  const entryMenu = (e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [
      ...(entry.isDir ? [] : [{ label: 'Open in viewer', onClick: () => openFile(sessionId, entry.path) }, { label: 'Open in editor', onClick: () => window.api.shell.openInEditor(entry.path) }]),
      { label: 'Open with default app', onClick: () => window.api.shell.openPath(entry.path) },
      { label: 'Reveal in Finder', onClick: () => window.api.shell.showInFolder(entry.path) },
      ...(entry.isDir ? [{ label: 'Open in Terminal', onClick: () => window.api.shell.openTerminal(entry.path) }] : []),
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Copy path', onClick: () => window.api.shell.copy(entry.path) },
      { label: 'Copy relative path', onClick: () => window.api.shell.copy(entry.path.startsWith(root + '/') ? entry.path.slice(root.length + 1) : entry.path) }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const list = children[dir]
    if (!list) return <div className="faint" style={{ paddingLeft: 12 + depth * 14, fontSize: 11.5 }}>loading…</div>
    if (!list.length) return <div className="faint" style={{ paddingLeft: 12 + depth * 14, fontSize: 11.5 }}>(empty)</div>
    return list.map((e) => {
      const isOpen = e.isDir && expanded.includes(e.path)
      return (
        <div key={e.path}>
          <div
            className={`tree-row ${active === e.path ? 'selected' : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            data-path={e.path}
            onClick={() => (e.isDir ? toggleExpanded(sessionId, e.path) : openFile(sessionId, e.path))}
            onDoubleClick={() => !e.isDir && window.api.shell.openInEditor(e.path)}
            onContextMenu={(ev) => entryMenu(ev, e)}
            title={e.path}
          >
            <span className="chev">{e.isDir ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}</span>
            {iconFor(e, isOpen)}
            <span className={`name ${e.isDir ? 'dir' : 'file'}`}>{e.name}</span>
            {!e.isDir && <span className="size">{formatBytes(e.size)}</span>}
          </div>
          {isOpen && renderDir(e.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div className="tree" ref={containerRef}>
      <div className="tree-root" title={root}>
        <Folder size={13} color="var(--amber)" /> <span className="ellipsis">{basename(root)}</span>
        <button className="btn ghost icon" style={{ marginLeft: 'auto' }} title="Refresh" onClick={() => { void load(root); for (const d of expanded) void load(d) }}>
          <RefreshCw size={12} />
        </button>
      </div>
      {renderDir(root, 0)}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
