import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import type { GitBranchInfo, GitCommitInfo, GitDiffResult, GitFileState, GitFileStatus, GitRepoInfo, GitStatusResult } from '@shared/types'

/**
 * Thin wrapper around the `git` (and optionally `gh`) command line tools. Every function takes the
 * spawn environment captured from the user's login shell so credential helpers, PATH and proxies
 * behave exactly like in a terminal.
 */

const MAX_FILES = 4000
const MAX_DIFF_BYTES = 1_500_000

type Env = Record<string, string>

interface RunOpts {
  cwd: string
  env: Env
  input?: string
  timeoutMs?: number
  /** Resolve with the exit code instead of rejecting on a non-zero exit. */
  allowFail?: boolean
}

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

export class GitError extends Error {}

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

function exec(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...opts.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null
        if (e && typeof e.code !== 'number') {
          const msg = e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH` : e.killed ? `${cmd} ${args[0]} timed out` : e.message
          return reject(new GitError(msg))
        }
        const res: RunResult = { stdout: String(stdout), stderr: String(stderr), code: e ? (e.code as number) : 0 }
        if (e && !opts.allowFail) return reject(new GitError((res.stderr || res.stdout || e.message).trim()))
        resolve(res)
      }
    )
    child.stdin?.end(opts.input ?? '')
  })
}

const git = (args: string[], opts: RunOpts) => exec('git', args, opts)

export function toWebUrl(remote: string): string | undefined {
  let m = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(remote)
  if (m) return `https://${m[1]}/${m[2]}`
  m = /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remote)
  if (m) return `https://${m[1]}/${m[2]}`
  m = /^(https?:\/\/)(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote)
  if (m) return `${m[1]}${m[2]}/${m[3]}`
  return undefined
}

export async function repoRoot(cwd: string, env: Env): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd, env, allowFail: true, timeoutMs: 10_000 })
  return r.code === 0 ? r.stdout.trim() : null
}

export async function getInfo(cwd: string, env: Env): Promise<GitRepoInfo> {
  const gitAvailable = Boolean(findOnPath('git', env.PATH))
  const ghAvailable = Boolean(findOnPath('gh', env.PATH))
  if (!gitAvailable) return { isRepo: false, gitAvailable, ghAvailable }
  let root: string | null
  try {
    root = await repoRoot(cwd, env)
  } catch {
    return { isRepo: false, gitAvailable: false, ghAvailable }
  }
  if (!root) return { isRepo: false, gitAvailable, ghAvailable }
  const o: RunOpts = { cwd: root, env, allowFail: true, timeoutMs: 10_000 }
  const [branch, upstream, ab, remotes, head, name, email, stash] = await Promise.all([
    git(['symbolic-ref', '--short', '-q', 'HEAD'], o),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], o),
    git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], o),
    git(['remote'], o),
    git(['log', '-1', '--format=%H%x1f%s%x1f%ct'], o),
    git(['config', 'user.name'], o),
    git(['config', 'user.email'], o),
    git(['stash', 'list'], o)
  ])
  const info: GitRepoInfo = { isRepo: true, gitAvailable, ghAvailable, root }
  if (branch.code === 0 && branch.stdout.trim()) info.branch = branch.stdout.trim()
  else {
    info.detached = true
    const h = await git(['rev-parse', '--short', 'HEAD'], o)
    info.branch = h.code === 0 ? h.stdout.trim() : undefined
  }
  if (upstream.code === 0) info.upstream = upstream.stdout.trim()
  if (ab.code === 0) {
    const [a, b] = ab.stdout.trim().split(/\s+/).map(Number)
    info.ahead = a
    info.behind = b
  }
  const remoteNames = remotes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (remoteNames.length) {
    const remoteName = remoteNames.includes('origin') ? 'origin' : remoteNames[0]
    info.remoteName = remoteName
    const url = await git(['remote', 'get-url', remoteName], o)
    if (url.code === 0) {
      info.remoteUrl = url.stdout.trim()
      info.remoteWebUrl = toWebUrl(info.remoteUrl)
    }
  }
  if (head.code === 0 && head.stdout.trim()) {
    const [hash, subject, ct] = head.stdout.trim().split('\x1f')
    info.head = { hash, subject, time: Number(ct) * 1000 }
    info.hasCommits = true
  } else info.hasCommits = false
  if (name.code === 0) info.userName = name.stdout.trim()
  if (email.code === 0) info.userEmail = email.stdout.trim()
  info.stashCount = stash.code === 0 ? stash.stdout.split('\n').filter(Boolean).length : 0
  return info
}

const STATE: Record<string, GitFileState> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflicted' }

function entry(root: string, p: string, index: GitFileState | null, worktree: GitFileState | null): GitFileStatus {
  return { path: p, absPath: path.join(root, p), index, worktree, isDir: p.endsWith('/') }
}

export async function getStatus(cwd: string, env: Env): Promise<GitStatusResult> {
  const info = await getInfo(cwd, env)
  const checkedAt = Date.now()
  if (!info.isRepo || !info.root) return { info, files: [], checkedAt }
  const root = info.root
  const r = await git(['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--ignored=matching'], { cwd: root, env, timeoutMs: 60_000 })
  const tokens = r.stdout.split('\0')
  const files: GitFileStatus[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t || t[0] === '#') continue
    const type = t[0]
    if (type === '?' || type === '!') {
      files.push(entry(root, t.slice(2), null, type === '?' ? 'untracked' : 'ignored'))
      continue
    }
    if (type === '1' || type === '2' || type === 'u') {
      const parts = t.split(' ')
      const xy = parts[1] ?? '..'
      let p: string
      let orig: string | undefined
      if (type === '1') p = parts.slice(8).join(' ')
      else if (type === '2') {
        p = parts.slice(9).join(' ')
        orig = tokens[++i]
      } else p = parts.slice(10).join(' ')
      const idx = type === 'u' ? 'conflicted' : STATE[xy[0]] ?? null
      const wt = type === 'u' ? 'conflicted' : STATE[xy[1]] ?? null
      files.push({ ...entry(root, p, idx, wt), origPath: orig })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const truncated = files.length > MAX_FILES
  return { info, files: truncated ? files.slice(0, MAX_FILES) : files, truncated, checkedAt }
}

// ------------------------------------------------------------------ mutations

export async function stage(root: string, paths: string[], env: Env, force = false): Promise<void> {
  if (!paths.length) return
  await git(['add', '-A', ...(force ? ['-f'] : []), '--', ...paths], { cwd: root, env })
}

export async function stageAll(root: string, env: Env): Promise<void> {
  await git(['add', '-A'], { cwd: root, env })
}

export async function unstage(root: string, paths: string[], env: Env): Promise<void> {
  if (!paths.length) return
  const r = await git(['restore', '--staged', '--', ...paths], { cwd: root, env, allowFail: true })
  // On a branch without commits there is no HEAD to restore from; drop the paths from the index instead.
  if (r.code !== 0) await git(['rm', '-r', '--cached', '--quiet', '--', ...paths], { cwd: root, env })
}

export async function unstageAll(root: string, env: Env): Promise<void> {
  const r = await git(['restore', '--staged', '--', '.'], { cwd: root, env, allowFail: true })
  if (r.code !== 0) await git(['rm', '-r', '--cached', '--quiet', '--', '.'], { cwd: root, env, allowFail: true })
}

/** Stop tracking files but keep them on disk (they become untracked). */
export async function untrack(root: string, paths: string[], env: Env): Promise<void> {
  if (!paths.length) return
  await git(['rm', '-r', '--cached', '--quiet', '--', ...paths], { cwd: root, env })
}

export interface DiscardEntry {
  path: string
  origPath?: string
  index: GitFileState | null
  worktree: GitFileState | null
}

/**
 * Throw away local changes. Tracked files are restored from HEAD, newly added files are unstaged
 * (kept on disk), untracked files are moved to the Trash.
 */
export async function discard(root: string, entries: DiscardEntry[], env: Env): Promise<{ trashed: number }> {
  const restore: string[] = []
  const unstageOnly: string[] = []
  const trash: string[] = []
  for (const e of entries) {
    if (e.worktree === 'untracked' || e.worktree === 'ignored') trash.push(e.path)
    else if (e.index === 'renamed' || e.index === 'copied') {
      unstageOnly.push(e.path)
      if (e.origPath && e.index === 'renamed') restore.push(e.origPath)
    } else if (e.index === 'added') unstageOnly.push(e.path)
    else restore.push(e.path)
  }
  if (unstageOnly.length) await unstage(root, unstageOnly, env)
  if (restore.length) await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore], { cwd: root, env })
  let trashed = 0
  for (const p of trash) {
    await shell.trashItem(path.join(root, p.replace(/\/$/, '')))
    trashed += 1
  }
  return { trashed }
}

export async function discardAll(root: string, env: Env): Promise<void> {
  await git(['reset', '-q', '--hard', 'HEAD'], { cwd: root, env })
}

/** Delete files: tracked ones through `git rm`, everything else to the Trash. */
export async function deletePaths(root: string, absPaths: string[], env: Env): Promise<void> {
  for (const p of absPaths) {
    const tracked = await git(['ls-files', '--error-unmatch', '--', p], { cwd: root, env, allowFail: true })
    if (tracked.code === 0) await git(['rm', '-r', '-f', '--quiet', '--', p], { cwd: root, env })
    else await shell.trashItem(p)
  }
}

export function addToGitignore(root: string, relPaths: string[]): string[] {
  const file = path.join(root, '.gitignore')
  let cur = ''
  try {
    cur = fs.readFileSync(file, 'utf8')
  } catch {
    /* new file */
  }
  const existing = new Set(cur.split('\n').map((l) => l.trim()))
  const add = relPaths.map((p) => '/' + p.replace(/^\/+/, '')).filter((l) => !existing.has(l))
  if (add.length) fs.writeFileSync(file, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + add.join('\n') + '\n')
  return add
}

export async function commit(root: string, message: string, opts: { amend?: boolean; signoff?: boolean }, env: Env): Promise<string> {
  const args = ['commit', '-q', '-F', '-']
  if (opts.amend) args.push('--amend')
  if (opts.signoff) args.push('--signoff')
  await git(args, { cwd: root, env, input: message })
  const h = await git(['log', '-1', '--format=%h'], { cwd: root, env, allowFail: true })
  return h.stdout.trim()
}

export async function push(root: string, info: { upstream?: string; remoteName?: string; branch?: string }, env: Env): Promise<string> {
  const args = info.upstream ? ['push'] : ['push', '-u', info.remoteName ?? 'origin', info.branch ?? 'HEAD']
  const r = await git(args, { cwd: root, env, timeoutMs: 180_000 })
  return (r.stderr + r.stdout).trim()
}

export async function pull(root: string, rebase: boolean, env: Env): Promise<string> {
  const r = await git(['pull', ...(rebase ? ['--rebase'] : ['--no-rebase', '--no-edit'])], { cwd: root, env, timeoutMs: 180_000 })
  return (r.stdout + r.stderr).trim()
}

export async function fetch(root: string, env: Env): Promise<void> {
  await git(['fetch', '--prune', '--quiet'], { cwd: root, env, timeoutMs: 120_000 })
}

export async function log(root: string, limit: number, env: Env): Promise<GitCommitInfo[]> {
  const r = await git(['log', `-n${limit}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%D%x1e'], { cwd: root, env, allowFail: true })
  if (r.code !== 0) return []
  return r.stdout
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((s) => {
      const [hash, shortHash, subject, author, ct, refs] = s.split('\x1f')
      return { hash, shortHash, subject, author, time: Number(ct) * 1000, refs: refs?.trim() || undefined }
    })
}

function isBinary(s: string): boolean {
  return s.slice(0, 8192).includes('\0')
}

export async function diff(root: string, relPath: string, staged: boolean, env: Env): Promise<GitDiffResult> {
  const o: RunOpts = { cwd: root, env, allowFail: true }
  const show = async (spec: string) => {
    const r = await git(['show', spec], o)
    return r.code === 0 ? r.stdout : ''
  }
  let before: string
  let after: string
  let beforeLabel: string
  let afterLabel: string
  if (staged) {
    before = await show(`HEAD:${relPath}`)
    after = await show(`:${relPath}`)
    beforeLabel = 'HEAD'
    afterLabel = 'staged'
  } else {
    before = await show(`:${relPath}`)
    try {
      after = fs.readFileSync(path.join(root, relPath), 'utf8')
    } catch {
      after = ''
    }
    beforeLabel = 'staged / HEAD'
    afterLabel = 'working tree'
  }
  const binary = isBinary(before) || isBinary(after)
  const tooLarge = before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES
  if (binary || tooLarge) return { path: relPath, before: '', after: '', beforeLabel, afterLabel, binary, tooLarge }
  return { path: relPath, before, after, beforeLabel, afterLabel, binary: false }
}

export async function showCommit(root: string, hash: string, env: Env): Promise<string> {
  const r = await git(['show', '--stat', '--format=%H%n%an <%ae>%n%ad%n%n%B', hash], { cwd: root, env })
  return r.stdout
}

export async function branches(root: string, env: Env): Promise<GitBranchInfo[]> {
  const r = await git(['branch', '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)'], { cwd: root, env, allowFail: true })
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, upstream, head] = l.split('\t')
      return { name, upstream: upstream || undefined, current: head === '*' }
    })
}

export async function checkout(root: string, branch: string, env: Env): Promise<void> {
  await git(['switch', branch], { cwd: root, env })
}

export async function createBranch(root: string, name: string, env: Env): Promise<void> {
  await git(['switch', '-c', name], { cwd: root, env })
}

export async function init(cwd: string, env: Env): Promise<void> {
  await git(['init', '-q', '-b', 'main'], { cwd, env })
}

/** Undo the last commit but keep its changes staged. */
export async function undoLastCommit(root: string, env: Env): Promise<void> {
  const count = await git(['rev-list', '--count', 'HEAD'], { cwd: root, env, allowFail: true })
  if (count.code === 0 && Number(count.stdout.trim()) > 1) await git(['reset', '-q', '--soft', 'HEAD~1'], { cwd: root, env })
  else await git(['update-ref', '-d', 'HEAD'], { cwd: root, env })
}

export async function revertCommit(root: string, hash: string, env: Env): Promise<void> {
  await git(['revert', '--no-edit', hash], { cwd: root, env })
}

export async function stashPush(root: string, env: Env): Promise<void> {
  await git(['stash', 'push', '-u', '-q', '-m', 'ClaudeGUI stash'], { cwd: root, env })
}

export async function stashPop(root: string, env: Env): Promise<void> {
  await git(['stash', 'pop', '-q'], { cwd: root, env })
}

/** Create a GitHub repository with `gh` and push the current branch to it. */
export async function publish(root: string, name: string, visibility: 'public' | 'private', env: Env): Promise<string> {
  if (!findOnPath('gh', env.PATH)) throw new GitError('GitHub CLI (gh) is not installed. Install it with `brew install gh` and run `gh auth login`.')
  const r = await exec('gh', ['repo', 'create', name, `--${visibility}`, `--source=${root}`, '--remote=origin', '--push'], { cwd: root, env, timeoutMs: 180_000 })
  return (r.stdout + r.stderr).trim()
}
