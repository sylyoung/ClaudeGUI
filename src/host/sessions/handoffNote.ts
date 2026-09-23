/**
 * The note a chat is left with when its process is stopped with work still in hand — by a quit, by
 * a restart of the session host, by a provider switch or by Stop. Everything a chat has running is
 * a child of its Claude Code process: a background shell, a monitor, a subagent, a "!" command.
 * None of them survives the process and none can be reattached to by the process that resumes the
 * conversation (measured 2026-09-13: the shell's pid was gone the moment the chat was stopped), so
 * the work is only picked up again by someone deciding to start it again.
 *
 * The note is therefore written for two readers at once: the user, who finds it waiting in the
 * chat's input box and decides what still matters, and Claude, who reads it as the next prompt if
 * the user sends it as it stands.
 */
import type { BackgroundTaskView, ChatMessage } from '@shared/types'
export { mergeHandoffNote } from '@shared/handoffNote'

/**
 * What a chat still had in hand at the moment its process ended. It has to be taken before the
 * process is gone: the queue is emptied, the tools in flight are dropped and the background tasks
 * are forgotten as the process exits.
 */
export interface HandoffSnapshot {
  stoppedAt: number
  /** Background shells, monitors and subagents that were still working. */
  tasks: BackgroundTaskView[]
  /** Tool calls of the turn that was being answered. */
  tools: { toolName: string; toolUseId: string; elapsedSeconds: number }[]
  /** Prompts that were being answered when the process ended. */
  working: string[]
  /** Prompts still waiting in Claude Code's queue, which it had not started. */
  queued: string[]
  /** Shell commands typed after "!" that were still running. */
  shells: string[]
  /** Tools that were waiting for a permission answer. */
  permissions: { toolName: string; detail?: string }[]
  /** A turn was being worked on (Claude was thinking, writing or running tools). */
  turnInFlight: boolean
  /** Claude Code's own last recap of the chat, when it still describes where the chat stands. */
  recap?: string
}

/** Nothing was lost: a chat that was only sitting idle needs no note. */
export function hasUnfinishedWork(s: HandoffSnapshot): boolean {
  return (
    s.turnInFlight ||
    s.tasks.length > 0 ||
    s.tools.length > 0 ||
    s.working.length > 0 ||
    s.queued.length > 0 ||
    s.shells.length > 0 ||
    s.permissions.length > 0
  )
}

const MAX_LINE = 300
const MAX_ITEMS = 12

/** One line of text out of anything: no line breaks, no runaway length. */
function oneLine(text: string, max = MAX_LINE): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** "Sep 23, 03:52" — the same way the rest of the app writes a date and time. */
function whenText(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "4m", "35s" — how long something had been running. */
function elapsedText(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The command or prompt behind a tool call, read from the tool call itself. */
function toolInputs(messages: ChatMessage[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of messages) {
    if (m.kind !== 'assistant') continue
    for (const b of m.blocks) {
      if (b.type !== 'tool_use') continue
      const i = b.input
      const text =
        typeof i.command === 'string'
          ? i.command
          : typeof i.prompt === 'string'
            ? i.prompt
            : typeof i.file_path === 'string'
              ? i.file_path
              : typeof i.pattern === 'string'
                ? i.pattern
                : ''
      if (text) out.set(b.id, text)
    }
  }
  return out
}

/** How a background task is called in a sentence: "subagent", "background shell", "monitor". */
function taskKind(taskType: string): string {
  if (/agent|teammate/i.test(taskType)) return 'subagent'
  if (taskType === 'local_bash') return 'background shell'
  return taskType.replace(/^local_/, '').replace(/_/g, ' ')
}

/**
 * The note itself. It names what was unfinished, each item on its own line, and ends with what the
 * chat is to do about it, so that sending the note as written is a sensible instruction.
 */
export function handoffNote(s: HandoffSnapshot, messages: ChatMessage[]): string {
  const inputs = toolInputs(messages)
  const lines: string[] = []

  if (s.turnInFlight) {
    const running = s.tools
      .map((t) => {
        const what = inputs.get(t.toolUseId)
        return `${t.toolName} (${what ? `\`${oneLine(what, 80)}\`, ` : ''}${elapsedText(t.elapsedSeconds)} in)`
      })
      .slice(0, 3)
    lines.push(
      running.length
        ? `- the turn you were working on, cut off while it was running ${running.join(', ')}`
        : '- the turn you were working on, cut off before it finished'
    )
  }
  for (const t of s.tasks) {
    const what = t.description || 'no description given'
    const command = t.toolUseId ? inputs.get(t.toolUseId) : undefined
    lines.push(`- ${taskKind(t.taskType)}: ${oneLine(what)}${command && command !== what ? `\n  \`${oneLine(command)}\`` : ''}`)
  }
  for (const c of s.shells) lines.push(`- a command run from the input box: \`${oneLine(c)}\``)
  for (const p of s.permissions) lines.push(`- ${p.toolName} was waiting for permission${p.detail ? `: \`${oneLine(p.detail, 120)}\`` : ''}`)
  for (const p of s.working) lines.push(`- a prompt that was being answered: "${oneLine(p)}"`)
  for (const p of s.queued) lines.push(`- a prompt that was waiting in the queue and never started: "${oneLine(p)}"`)

  const shown = lines.slice(0, MAX_ITEMS)
  if (lines.length > shown.length) shown.push(`- and ${lines.length - shown.length} more`)

  const out = [
    `ClaudeGUI stopped this chat on ${whenText(s.stoppedAt)}, while it still had work in hand. Everything below ended with the chat's process and cannot be reattached to; a background shell, a monitor or a subagent only comes back by being started again.`,
    '',
    ...shown
  ]
  if (s.recap) out.push('', `Where the chat stood, from your own recap: ${oneLine(s.recap, 600)}`)
  out.push('', 'Work out what of this still needs doing, start again what is needed, and carry on from there.')
  return out.join('\n')
}
