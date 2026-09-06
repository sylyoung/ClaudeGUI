import { useEffect, useRef } from 'react'
import { useStore } from '@/store'

/**
 * Keeps the git status of a session fresh: on mount, after file-system changes inside the
 * working directory, when a turn finishes, on window focus, and on the configured intervals.
 */
export function useGitAutoRefresh(sessionId: string, cwd: string, enabled: boolean): void {
  const refreshGit = useStore((s) => s.refreshGit)
  const status = useStore((s) => s.live[sessionId]?.status)
  const interval = useStore((s) => s.settings?.gitAutoRefreshSeconds ?? 30)
  const fetchMinutes = useStore((s) => s.settings?.gitAutoFetchMinutes ?? 0)
  const prevStatus = useRef(status)

  useEffect(() => {
    if (enabled) void refreshGit(sessionId, { quiet: true, log: true })
  }, [sessionId, enabled, refreshGit])

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.api.events.onFsChanged((dir) => {
      if (dir === cwd || dir.startsWith(cwd + '/')) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void refreshGit(sessionId, { quiet: true }), 1200)
      }
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, cwd, enabled, refreshGit])

  useEffect(() => {
    if (enabled && prevStatus.current !== 'idle' && status === 'idle' && prevStatus.current !== undefined) void refreshGit(sessionId, { quiet: true, log: true })
    prevStatus.current = status
  }, [status, sessionId, enabled, refreshGit])

  useEffect(() => {
    if (!enabled || !(interval > 0)) return
    const t = setInterval(() => {
      if (document.hasFocus()) void refreshGit(sessionId, { quiet: true })
    }, Math.max(5, interval) * 1000)
    return () => clearInterval(t)
  }, [sessionId, enabled, interval, refreshGit])

  useEffect(() => {
    if (!enabled || !(fetchMinutes > 0)) return
    const t = setInterval(() => void refreshGit(sessionId, { fetch: true, quiet: true }), Math.max(1, fetchMinutes) * 60_000)
    return () => clearInterval(t)
  }, [sessionId, enabled, fetchMinutes, refreshGit])

  useEffect(() => {
    if (!enabled) return
    const onFocus = () => void refreshGit(sessionId, { quiet: true })
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [sessionId, enabled, refreshGit])
}
