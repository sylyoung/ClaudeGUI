import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * The ChatGPT login the Codex CLI keeps in ~/.codex/auth.json, and its renewal.
 *
 * A Codex access token lives exactly ten days. The CLI renews it while it runs, but ClaudeGUI only
 * ever read it, so a stretch of ten days in which the CLI was not used ended with ChatGPT refusing
 * the token (HTTP 401) and the user having to sign in again. The renewal here is the same exchange
 * the CLI performs: the refresh token is presented to https://auth.openai.com/oauth/token with
 * Codex's own client id, and the three tokens that come back are written into the same file, with
 * the rest of the document left as it was.
 *
 * Nothing here logs a token, and the file is rewritten only after a complete answer has arrived:
 * a failed renewal leaves the previous login in place.
 */

/** Codex's own OAuth client, as it appears in the CLI binary. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'

export interface CodexLogin {
  accessToken: string
  refreshToken?: string
  accountId?: string
  /** When the access token stops being accepted, from its own `exp` claim (epoch ms). */
  expiresAt?: number
  /** When it was last renewed, from the file's own `last_refresh` (epoch ms). */
  lastRefresh?: number
}

/** POST a JSON document and read the answer; the caller provides it so this module spawns nothing. */
export type PostJson = (url: string, body: string) => Promise<{ status: number; json: unknown }>

export function codexAuthFile(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(home, 'auth.json')
}

/** The payload of a JWT, without verifying it: only the app's own reading of its expiry. */
function claimsOf(token: string | undefined): Record<string, unknown> | null {
  const part = token?.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function expiryOf(accessToken: string): number | undefined {
  const exp = claimsOf(accessToken)?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}

/** The account the id token belongs to, which the CLI also keeps beside the tokens. */
function accountIdOf(idToken: string | undefined): string | undefined {
  const auth = claimsOf(idToken)?.['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined
  return auth?.chatgpt_account_id
}

interface AuthDoc {
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }
  last_refresh?: string
  [key: string]: unknown
}

function readDoc(): AuthDoc | null {
  try {
    return JSON.parse(fs.readFileSync(codexAuthFile(), 'utf8')) as AuthDoc
  } catch {
    return null
  }
}

/** The stored login, read straight from the CLI's own file the same way the CLI reads it. */
export function readCodexLogin(): CodexLogin | null {
  const doc = readDoc()
  const accessToken = doc?.tokens?.access_token
  if (!accessToken) return null
  const lastRefresh = doc?.last_refresh ? Date.parse(doc.last_refresh) : NaN
  return {
    accessToken,
    refreshToken: doc?.tokens?.refresh_token,
    accountId: doc?.tokens?.account_id,
    expiresAt: expiryOf(accessToken),
    lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : undefined
  }
}

/**
 * Renew the stored login and write it back.
 *
 * The answer carries a new refresh token as well, so it has to reach the file: the one presented
 * here may not be accepted a second time. The file is replaced in one step (write, then rename) so
 * a login is never half-written, and only when all three tokens have arrived.
 */
export async function renewCodexLogin(post: PostJson): Promise<CodexLogin> {
  const doc = readDoc()
  const refreshToken = doc?.tokens?.refresh_token
  if (!doc || !refreshToken) throw new Error(`no Codex login to renew in ${codexAuthFile()}`)
  const body = JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' })
  const res = await post(TOKEN_URL, body)
  if (res.status !== 200) {
    const detail = (res.json as { error_description?: string; error?: string } | null)?.error_description ?? (res.json as { error?: string } | null)?.error
    throw new Error(
      res.status === 400 || res.status === 401
        ? `ChatGPT refused to renew the Codex login${detail ? ` (${detail})` : ''}; sign in again with "codex login".`
        : `the renewal request to auth.openai.com returned HTTP ${res.status}${detail ? ` (${detail})` : ''}`
    )
  }
  const tokens = res.json as { id_token?: string; access_token?: string; refresh_token?: string } | null
  if (!tokens?.access_token || !tokens.refresh_token || !tokens.id_token) throw new Error('the renewal answer did not carry a complete login, so the stored one was left alone')
  const next: AuthDoc = {
    ...doc,
    tokens: {
      ...doc.tokens,
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: accountIdOf(tokens.id_token) ?? doc.tokens?.account_id
    },
    last_refresh: new Date().toISOString()
  }
  const file = codexAuthFile()
  const tmp = `${file}.claudegui-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: next.tokens?.account_id,
    expiresAt: expiryOf(tokens.access_token),
    lastRefresh: Date.now()
  }
}
