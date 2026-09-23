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

/**
 * Incremental newline-delimited JSON parser.
 *
 * A socket hands over whatever bytes were ready, and on macOS a Unix socket hands them over 8 KB at
 * a time, so a chat history of several megabytes arrives in hundreds of chunks. The chunks are kept
 * as they came and only the new one is searched for the end of the frame; the frame is joined and
 * decoded once, when its newline arrives. Appending each chunk to the text read so far and searching
 * all of it again made one frame cost the square of its size: a 9 MB history (a chat that read PDFs,
 * whose pages come back as pictures) kept the app's main process busy for minutes, and every chat,
 * every prompt sent and every reply waited behind it.
 *
 * Decoding whole frames also keeps every character intact. A chunk can end in the middle of a
 * character — everything outside ASCII takes more than one byte in UTF-8 — but a frame cannot: the
 * newline byte never occurs inside a multi-byte character, so text cut at a newline is always whole.
 */
export class LineParser {
  private parts: Buffer[] = []
  constructor(private onFrame: (f: Frame) => void, private onBad: (line: string, err: Error) => void) {}
  feed(chunk: Buffer | string): void {
    let rest = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    let idx: number
    while ((idx = rest.indexOf(10)) >= 0) {
      const head = rest.subarray(0, idx)
      const line = (this.parts.length ? Buffer.concat([...this.parts, head]) : head).toString('utf8')
      this.parts = []
      rest = rest.subarray(idx + 1)
      if (!line.trim()) continue
      try {
        this.onFrame(JSON.parse(line) as Frame)
      } catch (err) {
        this.onBad(line, err as Error)
      }
    }
    if (rest.length) this.parts.push(rest)
  }
}

export function writeFrame(socket: Socket, frame: Frame): boolean {
  if (socket.destroyed || !socket.writable) return false
  return socket.write(JSON.stringify(frame) + '\n')
}
