import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * The login Claude Code stored when it was signed in (macOS Keychain, or ~/.claude/.credentials.json).
 * The app only reads it: the access token for the plan-usage check, the dates to warn before the
 * login ends. Renewing the login is Claude Code's own job; a second renewer would invalidate the
 * refresh token Claude Code holds, so nothing here writes or renews anything.
 */
export interface StoredLogin {
  accessToken: string
  subscription?: string
  /** When the access token expires (epoch ms); Claude Code renews it with its refresh token. */
  accessExpiresAt?: number
  /** When the refresh token stops being accepted (epoch ms), when the login server said so. */
  refreshExpiresAt?: number
}

function parseLogin(raw: string): StoredLogin | null {
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string; expiresAt?: number; refreshTokenExpiresAt?: number } }
    const o = j?.claudeAiOauth
    if (!o?.accessToken) return null
    return {
      accessToken: String(o.accessToken),
      subscription: o.subscriptionType ? String(o.subscriptionType) : undefined,
      accessExpiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
      refreshExpiresAt: typeof o.refreshTokenExpiresAt === 'number' ? o.refreshTokenExpiresAt : undefined
    }
  } catch {
    return null
  }
}

export async function readStoredLogin(): Promise<StoredLogin | null> {
  if (process.platform === 'darwin') {
    try {
      const raw = await new Promise<string>((resolve, reject) =>
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 10_000, encoding: 'utf8' }, (e, out) => (e ? reject(e) : resolve(String(out))))
      )
      const login = parseLogin(raw.trim())
      if (login) return login
    } catch {
      /* not in the keychain */
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  try {
    return parseLogin(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}
