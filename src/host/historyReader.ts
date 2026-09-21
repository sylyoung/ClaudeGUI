/**
 * Reads one chat's history and prints it as JSON on stdout.
 *
 * This is a whole process of its own, started by the session host for one read and gone again a
 * second later. Claude Code reads a chat's history by going through its entire transcript file and
 * keeping everything written since the last compaction, which for a chat of several hundred
 * megabytes costs gigabytes of memory for a moment. The session host cannot afford that: its
 * memory ceiling is about 4 GB and cannot be raised (Electron builds V8 with compressed pointers),
 * and when two such reads overlapped the host was killed — with every running chat in it. Here the
 * cost belongs to a process that exits immediately afterwards, and the host receives only the
 * messages themselves.
 *
 * Arguments: session <sessionId> <cwd> | subagent <sessionId> <cwd> <agentId>
 */
import { getSessionMessages, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk'

const [kind, sessionId, dir, agentId] = process.argv.slice(2)

async function read(): Promise<unknown[]> {
  if (kind === 'subagent') return getSubagentMessages(sessionId, agentId, { dir })
  return getSessionMessages(sessionId, { dir, includeSystemMessages: true })
}

read().then(
  (messages) => {
    // stdout is a pipe here, so the write has to be finished before the process may exit.
    process.stdout.write(JSON.stringify(messages), () => process.exit(0))
  },
  (err: Error) => {
    process.stderr.write(err.message)
    process.exit(1)
  }
)
