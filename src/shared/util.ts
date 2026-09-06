/** Split a comma/newline separated setting into trimmed, non-empty items. */
export function splitList(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Parse "v1.2.3" / "1.2.3-beta.1" into comparable parts; null when not a version. */
export function parseVersion(text: string): { major: number; minor: number; patch: number; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

/** Semantic-version comparison: negative when a < b, positive when a > b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return a.localeCompare(b)
  for (const k of ['major', 'minor', 'patch'] as const) if (pa[k] !== pb[k]) return pa[k] - pb[k]
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x.localeCompare(y)
  }
  return 0
}
