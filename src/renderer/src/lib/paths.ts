/**
 * Detection of file paths inside chat text so they can be made clickable.
 * Conservative on purpose: absolute paths, ~ paths, ./ ../ paths, and relative
 * paths that contain a directory separator and a file extension.
 *
 * A segment may hold the letters and digits of any writing system, not only the Latin ones: a name
 * such as `中文目录/测试文件.md` is a path like any other, and matching `\w` stopped at the first
 * Chinese character and cut the path in half.
 */
const SEG = String.raw`[\p{L}\p{N}\p{M}_.\-+@%~()]+`
const ABS = String.raw`(?:~|\.{1,2})?\/(?:${SEG}\/)*${SEG}`
const REL = String.raw`(?<![\p{L}\p{N}_/.\-@:])${SEG}(?:\/${SEG})+\.[A-Za-z0-9]{1,8}`
const LINE = String.raw`(?::\d+(?::\d+)?)?`
export const PATH_REGEX = new RegExp(`(?<![\\p{L}\\p{N}_:/])(${ABS}|${REL})${LINE}(?![\\w/])`, 'gu')

/** Scripts that are written without spaces between words, so a sentence can run into a path. */
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u
/** A file extension at the end of the text, possibly followed by :line:column. */
const ENDS_WITH_EXT = /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/

export interface PathMatch {
  raw: string
  path: string
  line?: number
  column?: number
  start: number
  end: number
}

const TRAILING = /[.,;:)\]}'"`]+$/

/**
 * Chinese, Japanese and Korean sentences have no spaces, so the words that follow a path are glued
 * to it: `测试文件.md的内容` is the file `测试文件.md` and then the sentence going on. When the text
 * does not end in a file extension but contains one right before such a character, cut it there.
 */
function cutGluedSentence(raw: string): string {
  if (ENDS_WITH_EXT.test(raw)) return raw
  const m = /^(.*\.[A-Za-z0-9]{1,8})(?=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}])/u.exec(raw)
  return m ? m[1] : raw
}

/** The folders at the root of macOS, which show where an absolute path starts inside a run of text. */
const ROOT_DIR = /\/(?:Users|home|tmp|var|etc|usr|opt|private|Volumes|Applications|Library|System|mnt|srv)\//

/** The other side of the same problem: `还有打开/Users/me/文件.md` starts at `/Users`, not at `还`. */
function cutGluedPrefix(raw: string): string {
  const i = raw.search(ROOT_DIR)
  const head = i > 0 ? raw.slice(0, i) : ''
  return head && CJK.test(head) && !head.includes('/') ? raw.slice(i) : raw
}

export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = []
  if (!text.includes('/')) return out
  PATH_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_REGEX.exec(text))) {
    // strip trailing punctuation, and the sentence a language without spaces glued to either end
    const tail = cutGluedSentence(m[0].replace(TRAILING, ''))
    const raw = cutGluedPrefix(tail)
    const start = m.index + (tail.length - raw.length)
    const end = start + raw.length
    if (raw.length < 3) continue
    if (/^\/[^/]*$/.test(raw) && !raw.includes('.')) continue // "/", "/usr" or "/输出" alone
    if (/^\d+(\.\d+)*\/\d+/.test(raw)) continue // fractions like 3/4
    const parsed = splitLine(raw)
    if (!parsed.path.includes('/')) continue
    out.push({ raw, ...parsed, start, end })
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
  if (new RegExp(`^${SEG}(?:\\/${SEG})+(?:\\.[A-Za-z0-9]{1,8})?(?::\\d+)?(?::\\d+)?$`, 'u').test(t)) return true
  // bare file name with an extension, e.g. `greet.py`, `README.md:12` or `测试文件.md`
  return new RegExp(`^[\\p{L}\\p{N}\\p{M}_\\-+@%()]+(?:\\.[\\p{L}\\p{N}\\p{M}_\\-]+)*\\.[A-Za-z][A-Za-z0-9]{0,7}(?::\\d+)?(?::\\d+)?$`, 'u').test(t) && !/^\d+(\.\d+)+$/.test(t)
}

/** True when the text is written in a script that runs words together (Chinese, Japanese, Korean). */
export function hasCJK(text: string): boolean {
  return CJK.test(text)
}

export function isUrl(text: string): boolean {
  return /^(https?|mailto|ftp):/i.test(text.trim())
}
