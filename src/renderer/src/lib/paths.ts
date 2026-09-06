/**
 * Detection of file paths inside chat text so they can be made clickable.
 * Conservative on purpose: absolute paths, ~ paths, ./ ../ paths, and relative
 * paths that contain a directory separator and a file extension.
 */
const ABS = String.raw`(?:~|\.{1,2})?\/(?:[\w.\-+@%~()]+\/)*[\w.\-+@%~()]+`
const REL = String.raw`(?<![\w/.\-@:])[\w.\-+@%()]+(?:\/[\w.\-+@%()]+)+\.[A-Za-z0-9]{1,8}`
const LINE = String.raw`(?::\d+(?::\d+)?)?`
export const PATH_REGEX = new RegExp(`(?<![\\w:/])(${ABS}|${REL})${LINE}(?![\\w/])`, 'g')

export interface PathMatch {
  raw: string
  path: string
  line?: number
  column?: number
  start: number
  end: number
}

const TRAILING = /[.,;:)\]}'"`]+$/

export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = []
  if (!text.includes('/')) return out
  PATH_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_REGEX.exec(text))) {
    let raw = m[0]
    // strip trailing punctuation that is not part of a path
    const stripped = raw.replace(TRAILING, '')
    const end = m.index + stripped.length
    raw = stripped
    if (raw.length < 3) continue
    if (/^\/(?:[a-z]+)?$/i.test(raw) && !raw.includes('.')) continue // "/" or "/usr" alone
    if (/^\d+(\.\d+)*\/\d+/.test(raw)) continue // fractions like 3/4
    const parsed = splitLine(raw)
    if (!parsed.path.includes('/')) continue
    out.push({ raw, ...parsed, start: m.index, end })
  }
  return out
}

export function splitLine(raw: string): { path: string; line?: number; column?: number } {
  const m = raw.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
  if (!m) return { path: raw }
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined, column: m[3] ? Number(m[3]) : undefined }
}

export function isProbablyPath(text: string): boolean {
  const t = text.trim()
  if (t.length < 3 || t.length > 400 || /\s/.test(t) || t.includes('://')) return false
  if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('./') || t.startsWith('../')) return true
  if (/^[\w.\-+@%()]+(?:\/[\w.\-+@%()]+)+(?:\.[A-Za-z0-9]{1,8})?(?::\d+)?(?::\d+)?$/.test(t)) return true
  // bare file name with an extension, e.g. `greet.py` or `README.md:12`
  return /^[\w\-+@%()]+(?:\.[\w\-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?(?::\d+)?$/.test(t) && !/^\d+(\.\d+)+$/.test(t)
}

export function isUrl(text: string): boolean {
  return /^(https?|mailto|ftp):/i.test(text.trim())
}
