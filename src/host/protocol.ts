/**
 * Wire protocol between the app window process (client) and the detached session host.
 * Newline-delimited JSON over a Unix domain socket. Keep `hello`/`welcome`/`shutdown`
 * stable across versions so a newer app can always talk to an older host at least far
 * enough to stop it.
 */
import type { Socket } from 'net'
import type { AppSettings, SessionEvent } from '@shared/types'
import type { RateLimitEventInfo } from './sessions/SessionRuntime'

export const HOST_PROTOCOL = 1

/** Written by the host next to the socket so a (re)started app can find and authenticate it. */
export interface HostFile {
  pid: number
  socketPath: string
  token: string
  version: string
  protocol: number
  startedAt: number
  logFile: string
}

export interface HelloFrame {
  k: 'hello'
  token: string
  protocol: number
  appVersion: string
  settings: AppSettings
  focused: boolean
}

export interface WelcomeFrame {
  k: 'welcome'
  protocol: number
  pid: number
  version: string
  startedAt: number
  aliveSessions: number
  sdkVersion: string
}

export interface RequestFrame {
  k: 'req'
  id: number
  m: string
  p: unknown[]
}

export type ResponseFrame = { k: 'res'; id: number; ok: true; v: unknown } | { k: 'res'; id: number; ok: false; e: string }

export type HostEvent =
  | { e: 'session'; d: SessionEvent }
  | { e: 'notify'; d: { sessionId: string; title: string; body: string; kind: 'turn' | 'permission' | 'error' } }
  | { e: 'badge'; d: { count: number } }
  | { e: 'rateLimit'; d: { info: RateLimitEventInfo; ts: number } }
  | { e: 'turnFinished'; d: Record<string, never> }
  | { e: 'replaced'; d: Record<string, never> }
  | { e: 'exiting'; d: { reason: string } }

export type EventFrame = { k: 'ev' } & HostEvent
export type ErrorFrame = { k: 'error'; e: string }

export type Frame = HelloFrame | WelcomeFrame | RequestFrame | ResponseFrame | EventFrame | ErrorFrame

/** Incremental newline-delimited JSON parser. */
export class LineParser {
  private buf = ''
  constructor(private onFrame: (f: Frame) => void, private onBad: (line: string, err: Error) => void) {}
  feed(chunk: Buffer | string): void {
    this.buf += chunk.toString()
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        this.onFrame(JSON.parse(line) as Frame)
      } catch (err) {
        this.onBad(line, err as Error)
      }
    }
  }
}

export function writeFrame(socket: Socket, frame: Frame): boolean {
  if (socket.destroyed || !socket.writable) return false
  return socket.write(JSON.stringify(frame) + '\n')
}
