import type { SessionGroup, SessionLiveState, SessionRecord } from '@shared/types'
import type { MenuItem } from '@/components/common/ContextMenu'
import { shortenPath } from '@/lib/format'
import { useStore } from '@/store'

/**
 * A folder path short enough for a menu row. The end of a path is the part that says which folder
 * it is, so a long one keeps its last two names and loses its head.
 */
function menuPath(p: string, home: string | undefined): string {
  const short = shortenPath(p, home)
  if (short.length <= 44) return short
  return '…/' + short.split('/').slice(-2).join('/')
}

export interface SessionMenuOpts {
  groups: SessionGroup[]
  toast: (text: string, kind?: 'info' | 'error' | 'success') => void
  onRename?: () => void
  onNewGroup?: () => void
}

/** Context-menu entries shared by the sidebar rows, the status-board chips and the chat header. */
export function sessionMenuItems(r: SessionRecord, l: SessionLiveState | undefined, o: SessionMenuOpts): MenuItem[] {
  const fail = (err: unknown) => o.toast((err as Error).message, 'error')
  const groupItems: MenuItem[] = [
    ...[...o.groups].sort((a, b) => a.order - b.order).map((g) => ({
      label: g.name,
      checked: r.groupId === g.id,
      onClick: () => window.api.sessions.moveSession(r.id, { groupId: g.id }).catch(fail)
    })),
    { label: '', onClick: () => undefined, separator: true },
    { label: 'No group', checked: !r.groupId, onClick: () => window.api.sessions.moveSession(r.id, {}).catch(fail) }
  ]
  if (o.onNewGroup) groupItems.push({ label: 'New group…', onClick: o.onNewGroup })
  const items: MenuItem[] = []
  // The folder is no longer written on the chat's row in the sidebar — for most chats it is the
  // chat's own name — so this is where it can be read, and copied.
  items.push(
    {
      label: `Folder: ${menuPath(r.cwd, useStore.getState().appInfo?.homeDir)}`,
      tip: `${r.cwd}\nThe folder this chat works in. Click to copy the path.`,
      onClick: async () => {
        await window.api.shell.copy(r.cwd)
        o.toast('Folder path copied', 'success')
      }
    },
    { label: '', onClick: () => undefined, separator: true }
  )
  if (o.onRename) items.push({ label: 'Rename…', onClick: o.onRename })
  items.push({ label: 'Fork chat', tip: "Copy this conversation into a new chat in the same folder, as Claude Code's /branch does. The original chat is not changed.", onClick: () => void useStore.getState().forkSession(r.id) })
  items.push(
    { label: r.pinned ? 'Unpin' : 'Pin to top of group', tip: 'Pinned sessions stay at the top of their group', onClick: () => window.api.sessions.setPinned(r.id, !r.pinned).catch(fail) },
    { label: r.archived ? 'Unarchive' : 'Archive', tip: 'Archived sessions are hidden unless "show archived" is on', onClick: () => window.api.sessions.setArchived(r.id, !r.archived).catch(fail) },
    { label: 'Move to group', children: groupItems, onClick: () => undefined },
    { label: '', onClick: () => undefined, separator: true },
    {
      label: 'Change working directory…',
      tip: 'Point this session at another folder (for example after renaming it). The transcript moves along so history is kept.',
      onClick: () =>
        window.api.sessions
          .relocate(r.id)
          .then((rec) => rec && o.toast(`Working directory is now ${rec.cwd}`, 'success'))
          .catch(fail)
    },
    { label: 'Open folder in Terminal', onClick: () => window.api.shell.openTerminal(r.cwd).catch(fail) },
    { label: 'Reveal folder in Finder', onClick: () => window.api.shell.openPath(r.cwd).catch(fail) },
    { label: 'Copy resume command', onClick: async () => { await window.api.shell.copy(`cd "${r.cwd}" && claude --resume ${r.claudeSessionId}`); o.toast('Copied: claude --resume …', 'success') } },
    { label: 'Copy session id', onClick: async () => { await window.api.shell.copy(r.claudeSessionId); o.toast('Session id copied', 'success') } },
    { label: '', onClick: () => undefined, separator: true },
    {
      label: l?.processAlive ? 'Stop process (keeps history)' : 'Start process',
      tip: l?.processAlive ? 'Ends the Claude process and its background tasks; the next message starts a new one with the same history' : 'Start the Claude process now',
      onClick: () => (l?.processAlive ? window.api.sessions.stop(r.id) : window.api.sessions.start(r.id)).catch(fail)
    },
    {
      label: 'Delete session…',
      danger: true,
      onClick: () => {
        if (confirm(`Delete "${r.title}" from ClaudeGUI?\n\nThe Claude Code transcript on disk is kept unless you also choose to delete it next.`)) {
          const del = confirm('Also delete the transcript file from ~/.claude/projects? (Cancel = keep it)')
          void window.api.sessions.remove(r.id, del).catch(fail)
        }
      }
    }
  )
  return items
}
