import os from 'os'
import path from 'path'

/** ~/.claude/projects/<encoded cwd> — Claude Code replaces every non-alphanumeric character with '-'. */
export function projectDirFor(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}
