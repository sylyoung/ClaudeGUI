import type { FileProbe, OpenFilesWith } from '@shared/types'
import { useStore } from '@/store'

/**
 * Where a plain click on a file goes — a path in the chat, a row in the file tree, a changed file in
 * the Git panel — following Settings → Files → "Clicking a file opens it". The default hands every
 * kind of file to the app Finder would use: the user asked that ".md files" and the like do not open
 * inside the app. The built-in viewer stays reachable from the right-click menus ("Open in viewer").
 *
 * `kind` may be passed when the caller has already probed the file; otherwise the file is probed here.
 */
export async function openFileFromClick(sessionId: string, path: string, line?: number, kind?: FileProbe['kind']): Promise<void> {
  const { openFile, toast, settings } = useStore.getState()
  const mode: OpenFilesWith = settings?.openFilesWith ?? 'system'
  const k = kind ?? (await window.api.fs.probe(path)).kind
  if (k === 'missing') {
    toast(`Not found: ${path}`, 'error')
    return
  }
  // A bundle (.pages, .app…) is a folder in disguise; only its own app can show it.
  const inViewer = mode === 'viewer' ? k !== 'bundle' && k !== 'dir' : mode === 'viewer-text' ? k === 'text' || k === 'image' : false
  if (inViewer) {
    openFile(sessionId, path, line)
    return
  }
  const err = await window.api.shell.openPath(path)
  if (err) toast(err, 'error')
}
