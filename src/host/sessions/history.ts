/**
 * Reading a chat's history without putting the session host at risk.
 *
 * Claude Code hands back a chat's history by walking its whole transcript file, so the memory a
 * read needs grows with the file, not with the number of messages it returns: a 1.2 GB transcript
 * costs about 2.7 GB for the moment of the read and returns six messages. The session host has a
 * fixed ceiling of roughly 4 GB (Electron builds V8 with compressed pointers, so it cannot be
 * raised), and two such reads at the same time went through it and killed the host, taking every
 * running chat with it.
 *
 * So: a big transcript is read in a separate process (historyReader.ts) whose memory is released
 * when it exits, and no two reads ever run at the same time.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getSessionMessages, getSubagentMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'

/** Transcripts smaller than this are read in the host itself; the read costs a few megabytes. */
const READ_HERE_MAX_BYTES = 64 * 1024 * 1024
/** A read that has not finished by then is given up on, and the reading process is stopped. */
const READ_TIMEOUT_MS = 180_000

/** One history read at a time: it is two of them together that the memory ceiling cannot take. */
let queue: Promise<unknown> = Promise.resolve()

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** out/main/historyReader.mjs, next to the session host's own bundle. */
function readerScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'historyReader.mjs')
}

/** Run one read in its own process and parse what it printed. */
function readElsewhere(args: string[]): Promise<SessionMessage[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [readerScript(), ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL')
    }, READ_TIMEOUT_MS)
    timer.unref?.()
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => (err += String(b)))
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code, signal) => {
      finish(() => {
        if (signal) return reject(new Error(`the reading process was stopped (${signal}) after ${READ_TIMEOUT_MS / 1000}s`))
        if (code !== 0) return reject(new Error(err.trim() || `the reading process ended with code ${code}`))
        try {
          resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as SessionMessage[])
        } catch (e) {
          reject(new Error(`the reading process printed no history (${(e as Error).message})`))
        }
      })
    })
  })
}

/** How the read was done, for the log line the caller writes. */
export interface HistoryRead {
  messages: SessionMessage[]
  /** Size of the transcript file, in megabytes, rounded. */
  fileMB: number
  /** True when the read happened in a separate process because the transcript is large. */
  elsewhere: boolean
}

/** A chat's history, as Claude Code hands it back. */
export function readSessionHistory(sessionId: string, dir: string, file: string): Promise<HistoryRead> {
  const size = sizeOf(file)
  const elsewhere = size > READ_HERE_MAX_BYTES
  return oneAtATime(async () => ({
    messages: elsewhere
      ? await readElsewhere(['session', sessionId, dir])
      : await getSessionMessages(sessionId, { dir, includeSystemMessages: true }),
    fileMB: Math.round(size / 1048576),
    elsewhere
  }))
}

/** One subagent's messages, the same way. */
export function readSubagentHistory(sessionId: string, agentId: string, dir: string, file: string): Promise<SessionMessage[]> {
  const elsewhere = sizeOf(file) > READ_HERE_MAX_BYTES
  return oneAtATime(async () =>
    elsewhere ? readElsewhere(['subagent', sessionId, dir, agentId]) : getSubagentMessages(sessionId, agentId, { dir })
  )
}
