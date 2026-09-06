import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, Archive, ChevronDown, ChevronRight, Download, Ellipsis, ExternalLink, EyeOff, GitBranch, History, Loader2, Minus, Plus, RefreshCw, Trash2, Undo2, Upload
} from 'lucide-react'
import type { GitCommitInfo, GitFileState, GitFileStatus, SessionRecord } from '@shared/types'
import { useStore, type GitSelection } from '@/store'
import { ContextMenu, type MenuItem } from '../common/ContextMenu'
import { DiffView } from '../common/DiffView'
import { basename, relativeTime, timeAgo } from '@/lib/format'

const LETTER: Record<GitFileState, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflicted: '!', untracked: 'U', ignored: 'i'
}

export function gitLetter(state: GitFileState | null | undefined): string {
  return state ? LETTER[state] : ''
}

/** Draft commit messages survive tab switches (keyed by session id). */
const drafts = new Map<string, string>()

function splitPath(p: string): { dir: string; base: string } {
  const clean = p.replace(/\/$/, '')
  const i = clean.lastIndexOf('/')
  return i < 0 ? { dir: '', base: p } : { dir: clean.slice(0, i + 1), base: p.slice(i + 1) }
}

export function GitPanel({ record }: { record: SessionRecord }) {
  const git = useStore((s) => s.git[record.id])
  const refreshGit = useStore((s) => s.refreshGit)
  const selectGitFile = useStore((s) => s.selectGitFile)
  const runGit = useStore((s) => s.runGit)
  const openFile = useStore((s) => s.openFile)
  const toast = useStore((s) => s.toast)
  const pushAfterCommit = useStore((s) => s.settings?.gitPushAfterCommit ?? false)
  const signOff = useStore((s) => s.settings?.gitSignOff ?? false)
  const template = useStore((s) => s.settings?.gitCommitTemplate ?? '')
  const [message, setMessage] = useState(drafts.get(record.id) ?? template)
  const [amend, setAmend] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [form, setForm] = useState<null | { kind: 'publish' | 'branch' }>(null)
  const [formName, setFormName] = useState('')
  const [formVisibility, setFormVisibility] = useState<'public' | 'private'>('private')
  const [showIgnored, setShowIgnored] = useState(false)
  const [showLog, setShowLog] = useState(true)
  const [commitDetail, setCommitDetail] = useState<{ hash: string; text: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    drafts.set(record.id, message)
  }, [record.id, message])

  const cwd = record.cwd
  const status = git?.status
  const info = status?.info
  const files = status?.files ?? []
  const groups = useMemo(() => {
    const staged: GitFileStatus[] = []
    const changed: GitFileStatus[] = []
    const untracked: GitFileStatus[] = []
    const ignored: GitFileStatus[] = []
    const conflicts: GitFileStatus[] = []
    for (const f of files) {
      if (f.index === 'conflicted' || f.worktree === 'conflicted') conflicts.push(f)
      else {
        if (f.index) staged.push(f)
        if (f.worktree === 'untracked') untracked.push(f)
        else if (f.worktree === 'ignored') ignored.push(f)
        else if (f.worktree) changed.push(f)
      }
    }
    return { staged, changed, untracked, ignored, conflicts }
  }, [files])

  const run = (label: string, fn: () => Promise<unknown>, successToast?: string) => runGit(record.id, label, fn, { successToast })
  const busy = git?.busy

  const commit = async (andPush: boolean) => {
    const msg = message.trim()
    if (!msg && !amend) {
      toast('Enter a commit message first.', 'error')
      return
    }
    if (!groups.staged.length && !amend) {
      const pending = groups.changed.length + groups.untracked.length
      if (!pending) {
        toast('Nothing to commit.', 'info')
        return
      }
      if (!confirm(`No staged changes. Stage all ${pending} changed file${pending === 1 ? '' : 's'} and commit?`)) return
      const ok = await run('Stage all', () => window.api.git.stageAll(cwd))
      if (!ok) return
    }
    const ok = await run('Commit', async () => {
      const hash = await window.api.git.commit(cwd, msg || ' ', { amend, signoff: signOff })
      return hash
    }, andPush ? undefined : 'Committed')
    if (!ok) return
    setMessage(template)
    setAmend(false)
    if (andPush) await run('Push', () => window.api.git.push(cwd), 'Pushed')
  }

  const discard = async (list: GitFileStatus[]) => {
    const untracked = list.filter((f) => f.worktree === 'untracked' || f.worktree === 'ignored')
    const tracked = list.length - untracked.length
    const parts: string[] = []
    if (tracked) parts.push(`restore ${tracked} tracked file${tracked === 1 ? '' : 's'} from the last commit`)
    if (untracked.length) parts.push(`move ${untracked.length} untracked item${untracked.length === 1 ? '' : 's'} to the Trash`)
    if (!parts.length) return
    if (!confirm(`This will ${parts.join(' and ')}. Continue?`)) return
    await run('Discard', () => window.api.git.discard(cwd, list.map((f) => ({ path: f.path, origPath: f.origPath, index: f.index, worktree: f.worktree }))))
  }

  const del = async (f: GitFileStatus) => {
    if (!confirm(`Delete ${f.path}?\n\nTracked files are removed with git rm; other files go to the Trash.`)) return
    await run('Delete', () => window.api.git.delete(cwd, [f.absPath]))
  }

  const fileMenu = (e: React.MouseEvent, f: GitFileStatus, staged: boolean) => {
    e.preventDefault()
    const rel = f.path
    const items: MenuItem[] = []
    if (!f.isDir) items.push({ label: 'Open in viewer', onClick: () => openFile(record.id, f.absPath) })
    items.push({ label: 'Open in editor', onClick: () => window.api.shell.openInEditor(f.absPath) })
    items.push({ label: 'Reveal in Finder', onClick: () => window.api.shell.showInFolder(f.absPath) })
    items.push({ label: '', onClick: () => undefined, separator: true })
    if (staged) items.push({ label: 'Unstage', onClick: () => run('Unstage', () => window.api.git.unstage(cwd, [rel])) })
    else if (f.worktree === 'ignored') items.push({ label: 'Track anyway (force add)', onClick: () => run('Stage', () => window.api.git.stage(cwd, [rel], true)) })
    else items.push({ label: f.worktree === 'untracked' ? 'Track (stage)' : 'Stage', onClick: () => run('Stage', () => window.api.git.stage(cwd, [rel])) })
    if (f.worktree !== 'untracked' && f.worktree !== 'ignored') items.push({ label: 'Untrack (keep file, stop tracking)', onClick: () => run('Untrack', () => window.api.git.untrack(cwd, [rel])) })
    if (f.worktree !== 'ignored') items.push({ label: 'Add to .gitignore', onClick: () => run('Ignore', () => window.api.git.ignore(cwd, [rel])) })
    items.push({ label: f.worktree === 'untracked' ? 'Move to Trash…' : 'Discard changes…', danger: true, onClick: () => discard([f]) })
    items.push({ label: 'Delete…', danger: true, onClick: () => del(f) })
    items.push({ label: '', onClick: () => undefined, separator: true })
    items.push({ label: 'Copy path', onClick: () => window.api.shell.copy(f.absPath) })
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const commitMenu = (e: React.MouseEvent, c: GitCommitInfo) => {
    e.preventDefault()
    const items: MenuItem[] = [
      { label: 'Show details', onClick: async () => setCommitDetail({ hash: c.hash, text: await window.api.git.showCommit(cwd, c.hash).catch((err) => String(err.message)) }) },
      { label: 'Copy hash', onClick: () => window.api.shell.copy(c.hash) },
      ...(info?.remoteWebUrl ? [{ label: 'Open on GitHub', onClick: () => window.api.shell.openExternal(`${info.remoteWebUrl}/commit/${c.hash}`) }] : []),
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Revert this commit…', danger: true, onClick: () => { if (confirm(`Create a new commit that reverts "${c.subject}"?`)) void run('Revert', () => window.api.git.revertCommit(cwd, c.hash), 'Reverted') } }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const moreMenu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [
      { label: 'Refresh', onClick: () => refreshGit(record.id, { log: true }) },
      { label: 'Fetch from remote', onClick: () => run('Fetch', () => window.api.git.fetch(cwd), 'Fetched') },
      { label: 'Pull (rebase)', onClick: () => run('Pull', () => window.api.git.pull(cwd, true), 'Pulled') },
      { label: '', onClick: () => undefined, separator: true },
      ...(info?.remoteWebUrl ? [{ label: 'Open repository on GitHub', onClick: () => window.api.shell.openExternal(info.remoteWebUrl!) }] : []),
      ...(!info?.remoteUrl ? [{ label: 'Publish to GitHub…', onClick: () => { setFormName(basename(cwd)); setForm({ kind: 'publish' }) } }] : []),
      { label: 'New branch…', onClick: () => { setFormName(''); setForm({ kind: 'branch' }) } },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Stash all changes', onClick: () => run('Stash', () => window.api.git.stash(cwd), 'Stashed') },
      ...(info?.stashCount ? [{ label: `Pop latest stash (${info.stashCount})`, onClick: () => run('Stash pop', () => window.api.git.stashPop(cwd), 'Stash applied') }] : []),
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Undo last commit (keep changes staged)…', onClick: () => { if (confirm(`Undo the last commit "${info?.head?.subject ?? ''}"? The changes stay staged.`)) void run('Undo commit', () => window.api.git.undoLastCommit(cwd), 'Last commit undone') } },
      { label: 'Discard ALL local changes…', danger: true, onClick: () => { if (confirm('Reset every tracked file to the last commit? Untracked files are kept. This cannot be undone.')) void run('Discard all', () => window.api.git.discardAll(cwd)) } },
      { label: '', onClick: () => undefined, separator: true },
      { label: 'Open folder in Terminal', onClick: () => window.api.shell.openTerminal(cwd) }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const branchMenu = async (e: React.MouseEvent) => {
    const x = e.clientX
    const y = e.clientY
    try {
      const list = await window.api.git.branches(cwd)
      const items: MenuItem[] = list.map((b) => ({
        label: `${b.current ? '● ' : '   '}${b.name}${b.upstream ? `  →  ${b.upstream}` : ''}`,
        onClick: () => { if (!b.current) void run('Switch branch', () => window.api.git.checkout(cwd, b.name), `Switched to ${b.name}`) }
      }))
      items.push({ label: '', onClick: () => undefined, separator: true })
      items.push({ label: 'New branch…', onClick: () => { setFormName(''); setForm({ kind: 'branch' }) } })
      setMenu({ x, y, items })
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  const submitForm = async () => {
    const name = formName.trim()
    if (!name) return
    if (form?.kind === 'publish') {
      const ok = await run('Publish', () => window.api.git.publish(cwd, name, formVisibility), `Published ${name} to GitHub`)
      if (ok) setForm(null)
    } else if (form?.kind === 'branch') {
      const ok = await run('New branch', () => window.api.git.createBranch(cwd, name), `Created branch ${name}`)
      if (ok) setForm(null)
    }
  }

  const select = (f: GitFileStatus, staged: boolean) => {
    setCommitDetail(null)
    void selectGitFile(record.id, { path: f.path, staged })
  }

  // ------------------------------------------------------------ rendering

  if (!status) {
    return (
      <div className="git">
        <div className="faint" style={{ padding: 16 }}>
          {git?.error ? `Git: ${git.error}` : 'Reading repository status…'}
        </div>
      </div>
    )
  }
  if (!info?.gitAvailable) {
    return (
      <div className="git">
        <div className="git-empty">
          <GitBranch size={28} />
          <b>git is not installed</b>
          <div className="faint">Install the Xcode command line tools (`xcode-select --install`) or Homebrew git, then reload.</div>
        </div>
      </div>
    )
  }
  if (!info.isRepo) {
    return (
      <div className="git">
        <div className="git-empty">
          <GitBranch size={28} />
          <b>Not a git repository</b>
          <div className="faint">{cwd}</div>
          <button data-tip="Create a new git repository in this folder" className="btn primary" disabled={Boolean(busy)} onClick={() => run('Init', () => window.api.git.init(cwd), 'Repository initialized')}>
            <Plus size={13} /> Initialize repository
          </button>
        </div>
      </div>
    )
  }

  const changeCount = groups.staged.length + groups.changed.length + groups.untracked.length + groups.conflicts.length
  const sel = git?.selected
  const isSelected = (f: GitFileStatus, staged: boolean) => sel?.path === f.path && sel.staged === staged

  const row = (f: GitFileStatus, staged: boolean, actions: React.ReactNode) => {
    const state = staged ? f.index : f.worktree
    const { dir, base } = splitPath(f.path)
    return (
      <div key={`${staged ? 's' : 'w'}:${f.path}`} className={`git-row st-${state} ${isSelected(f, staged) ? 'selected' : ''}`} onClick={() => select(f, staged)} onDoubleClick={() => !f.isDir && openFile(record.id, f.absPath)} onContextMenu={(e) => fileMenu(e, f, staged)} data-tip={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
        <span className={`g-badge st-${state}`}>{gitLetter(state)}</span>
        <span className="g-path">
          {dir && <span className="g-dir">{dir}</span>}
          <span className="g-base">{base}</span>
        </span>
        <span className="g-actions">{actions}</span>
      </div>
    )
  }
  const iconBtn = (title: string, icon: React.ReactNode, onClick: () => void, danger = false) => (
    <button className={`btn ghost icon ${danger ? 'danger' : ''}`} data-tip={title} disabled={Boolean(busy)} onClick={(e) => { e.stopPropagation(); onClick() }}>
      {icon}
    </button>
  )

  return (
    <div className="git">
      <div className="git-head">
        <button className="git-branch" onClick={branchMenu} data-tip="Switch branch">
          <GitBranch size={13} />
          <span className="ellipsis">{info.branch ?? '(no branch)'}</span>
          {info.detached && <span className="faint">detached</span>}
          <ChevronDown size={12} />
        </button>
        <span className="spacer" />
        {info.remoteUrl ? (
          <button className="git-remote" data-tip={info.remoteUrl} onClick={() => info.remoteWebUrl && window.api.shell.openExternal(info.remoteWebUrl)}>
            <ExternalLink size={11} /> {info.remoteName}
            {info.upstream ? '' : ' · no upstream'}
          </button>
        ) : (
          <button className="git-remote" data-tip="Create a GitHub repository for this folder and push" onClick={() => { setFormName(basename(cwd)); setForm({ kind: 'publish' }) }}>
            <Upload size={11} /> publish
          </button>
        )}
        {(info.ahead ?? 0) > 0 && <span className="pill blue" data-tip="Commits not yet pushed"><ArrowUp size={10} /> {info.ahead}</span>}
        {(info.behind ?? 0) > 0 && <span className="pill amber" data-tip="Commits on the remote not yet pulled"><ArrowDown size={10} /> {info.behind}</span>}
      </div>
      <div className="git-actions-bar">
        <button className="btn sm" disabled={Boolean(busy)} data-tip="git fetch --prune" onClick={() => run('Fetch', () => window.api.git.fetch(cwd), 'Fetched')}>
          <RefreshCw size={12} /> Fetch
        </button>
        <button className="btn sm" disabled={Boolean(busy)} data-tip="git pull" onClick={() => run('Pull', () => window.api.git.pull(cwd, false), 'Pulled')}>
          <Download size={12} /> Pull
        </button>
        <button className={`btn sm ${(info.ahead ?? 0) > 0 ? 'primary' : ''}`} disabled={Boolean(busy)} data-tip={info.upstream ? 'git push' : `git push -u ${info.remoteName ?? 'origin'} ${info.branch}`} onClick={() => run('Push', () => window.api.git.push(cwd), 'Pushed')}>
          <Upload size={12} /> Push{(info.ahead ?? 0) > 0 ? ` ${info.ahead}` : ''}
        </button>
        <span className="spacer" />
        {busy ? <span className="faint" style={{ fontSize: 11.5 }}><Loader2 size={11} className="spin" /> {busy}…</span> : git?.loading ? <Loader2 size={12} className="spin faint" /> : null}
        <button className="btn ghost icon" data-tip="Refresh status" onClick={() => refreshGit(record.id, { log: true })}>
          <RefreshCw size={13} />
        </button>
        <button className="btn ghost icon" data-tip="More" onClick={moreMenu}>
          <Ellipsis size={14} />
        </button>
      </div>

      {form && (
        <div className="git-form">
          <input className="input" autoFocus placeholder={form.kind === 'publish' ? 'repository name' : 'new branch name'} value={formName} onChange={(e) => setFormName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submitForm(); if (e.key === 'Escape') setForm(null) }} spellCheck={false} />
          {form.kind === 'publish' && (
            <select className="select" value={formVisibility} onChange={(e) => setFormVisibility(e.target.value as 'public' | 'private')}>
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
          )}
          <button className="btn primary sm" disabled={Boolean(busy) || !formName.trim()} onClick={submitForm}>{form.kind === 'publish' ? 'Create & push' : 'Create'}</button>
          <button className="btn sm" onClick={() => setForm(null)}>Cancel</button>
        </div>
      )}

      <div className="git-commit">
        <textarea className="input" rows={2} placeholder={info.hasCommits === false ? 'Initial commit message' : 'Commit message (⌘⏎ to commit)'} value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(pushAfterCommit) } }} spellCheck={true} />
        <div className="git-commit-row">
          <label className="faint" data-tip="Replace the last commit instead of creating a new one">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> amend
          </label>
          {!info.userName && <span className="pill amber" data-tip="Set git config user.name / user.email">no git identity</span>}
          <span className="spacer" />
          <button className="btn sm" disabled={Boolean(busy)} onClick={() => commit(true)} data-tip="Commit, then push">
            Commit & push
          </button>
          <button data-tip="Create a commit from the staged changes (⌘⏎ in the message box)" className="btn primary sm" disabled={Boolean(busy)} onClick={() => commit(false)}>
            Commit{groups.staged.length ? ` (${groups.staged.length})` : ''}
          </button>
        </div>
      </div>

      <div className="git-body">
        <div className="git-list" ref={listRef}>
          {changeCount === 0 && groups.ignored.length === 0 && <div className="faint" style={{ padding: '10px 12px' }}>Working tree clean.</div>}
          {groups.conflicts.length > 0 && (
            <div className="git-section">
              <div className="git-section-head"><span className="red">Conflicts</span><span className="count">{groups.conflicts.length}</span></div>
              {groups.conflicts.map((f) => row(f, false, iconBtn('Mark resolved (stage)', <Plus size={12} />, () => run('Stage', () => window.api.git.stage(cwd, [f.path])))))}
            </div>
          )}
          {groups.staged.length > 0 && (
            <div className="git-section">
              <div className="git-section-head">
                <span>Staged changes</span>
                <span className="count">{groups.staged.length}</span>
                <span className="spacer" />
                {iconBtn('Unstage all', <Minus size={12} />, () => run('Unstage all', () => window.api.git.unstageAll(cwd)))}
              </div>
              {groups.staged.map((f) =>
                row(f, true, (
                  <>
                    {iconBtn('Unstage', <Minus size={12} />, () => run('Unstage', () => window.api.git.unstage(cwd, [f.path])))}
                    {iconBtn('Discard changes', <Undo2 size={12} />, () => discard([f]), true)}
                  </>
                ))
              )}
            </div>
          )}
          {groups.changed.length > 0 && (
            <div className="git-section">
              <div className="git-section-head">
                <span>Changes</span>
                <span className="count">{groups.changed.length}</span>
                <span className="spacer" />
                {iconBtn('Discard all changes', <Undo2 size={12} />, () => discard(groups.changed), true)}
                {iconBtn('Stage all changes', <Plus size={12} />, () => run('Stage all', () => window.api.git.stage(cwd, groups.changed.map((f) => f.path))))}
              </div>
              {groups.changed.map((f) =>
                row(f, false, (
                  <>
                    {iconBtn('Discard changes', <Undo2 size={12} />, () => discard([f]), true)}
                    {iconBtn('Stage', <Plus size={12} />, () => run('Stage', () => window.api.git.stage(cwd, [f.path])))}
                  </>
                ))
              )}
            </div>
          )}
          {groups.untracked.length > 0 && (
            <div className="git-section">
              <div className="git-section-head">
                <span>Untracked</span>
                <span className="count">{groups.untracked.length}</span>
                <span className="spacer" />
                {iconBtn('Track all (stage)', <Plus size={12} />, () => run('Stage all', () => window.api.git.stage(cwd, groups.untracked.map((f) => f.path))))}
              </div>
              {groups.untracked.map((f) =>
                row(f, false, (
                  <>
                    {iconBtn('Add to .gitignore', <EyeOff size={12} />, () => run('Ignore', () => window.api.git.ignore(cwd, [f.path])))}
                    {iconBtn('Move to Trash', <Trash2 size={12} />, () => discard([f]), true)}
                    {iconBtn('Track (stage)', <Plus size={12} />, () => run('Stage', () => window.api.git.stage(cwd, [f.path])))}
                  </>
                ))
              )}
            </div>
          )}
          {groups.ignored.length > 0 && (
            <div className="git-section">
              <div className="git-section-head clickable" onClick={() => setShowIgnored((v) => !v)}>
                {showIgnored ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Ignored</span>
                <span className="count">{groups.ignored.length}</span>
              </div>
              {showIgnored && groups.ignored.map((f) => row(f, false, iconBtn('Track anyway (force add)', <Plus size={12} />, () => run('Stage', () => window.api.git.stage(cwd, [f.path], true)))))}
            </div>
          )}
          {status.truncated && <div className="faint" style={{ padding: 8 }}>List truncated.</div>}

          <div className="git-section">
            <div className="git-section-head clickable" onClick={() => setShowLog((v) => !v)}>
              {showLog ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <History size={12} />
              <span>Commits</span>
              {info.head && <span className="faint ellipsis" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> · {timeAgo(info.head.time)}</span>}
            </div>
            {showLog &&
              (git?.log ?? []).map((c) => (
                <div key={c.hash} className={`commit-row ${commitDetail?.hash === c.hash ? 'selected' : ''}`} onClick={async () => { setCommitDetail({ hash: c.hash, text: await window.api.git.showCommit(cwd, c.hash).catch((err) => String(err.message)) }); void selectGitFile(record.id, undefined) }} onContextMenu={(e) => commitMenu(e, c)} data-tip={`${c.hash}\n${c.author} · ${new Date(c.time).toLocaleString()}`}>
                  <span className="c-hash">{c.shortHash}</span>
                  <span className="c-subject ellipsis">{c.subject}</span>
                  {c.refs && <span className="c-refs ellipsis">{c.refs}</span>}
                  <span className="c-time">{timeAgo(c.time)}</span>
                </div>
              ))}
            {showLog && !(git?.log ?? []).length && <div className="faint" style={{ padding: '4px 12px' }}>No commits yet.</div>}
          </div>
        </div>

        <div className="git-diff">
          {commitDetail ? (
            <>
              <div className="git-diff-head">
                <Archive size={12} />
                <span className="ellipsis">commit {commitDetail.hash.slice(0, 10)}</span>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={() => setCommitDetail(null)}>close</button>
              </div>
              <pre className="git-commit-detail">{commitDetail.text}</pre>
            </>
          ) : sel ? (
            <DiffPane sel={sel} sessionId={record.id} />
          ) : (
            <div className="faint git-diff-empty">Select a file to see its diff. Double-click opens it in the viewer.</div>
          )}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function DiffPane({ sel, sessionId }: { sel: GitSelection; sessionId: string }) {
  const git = useStore((s) => s.git[sessionId])
  const d = git?.diff
  return (
    <>
      <div className="git-diff-head">
        <span className={`g-badge ${sel.staged ? 'st-added' : 'st-modified'}`}>{sel.staged ? 'S' : 'W'}</span>
        <span className="ellipsis mono" data-tip={sel.path}>{sel.path}</span>
        <span className="faint">{sel.staged ? 'staged vs HEAD' : 'working tree vs staged'}</span>
        <span className="spacer" />
        {git?.diffLoading && <Loader2 size={12} className="spin" />}
        <span className="faint" data-tip="Last status check">{git?.status ? relativeTime(git.status.checkedAt) : ''}</span>
      </div>
      <div className="git-diff-body">
        {d && d.path === sel.path && (d.binary ? <div className="faint" style={{ padding: 12 }}>Binary file.</div> : d.tooLarge ? <div className="faint" style={{ padding: 12 }}>File too large to diff.</div> : d.before === d.after ? <div className="faint" style={{ padding: 12 }}>No textual difference.</div> : <DiffView before={d.before} after={d.after} context={3} />)}
      </div>
    </>
  )
}
