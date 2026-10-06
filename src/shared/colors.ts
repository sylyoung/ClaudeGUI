import type { SessionGroup } from './types'

/**
 * Group colours: the macOS system palette (one light and one dark variant each, like the Finder
 * tags and the accent colours). New groups get the first colour that no other group uses yet.
 */
export interface PaletteColor {
  key: string
  label: string
  light: string
  dark: string
}

export const GROUP_PALETTE: PaletteColor[] = [
  { key: 'blue', label: 'Blue', light: '#007aff', dark: '#0a84ff' },
  { key: 'purple', label: 'Purple', light: '#af52de', dark: '#bf5af2' },
  { key: 'orange', label: 'Orange', light: '#ff9500', dark: '#ff9f0a' },
  { key: 'green', label: 'Green', light: '#34c759', dark: '#30d158' },
  { key: 'pink', label: 'Pink', light: '#ff2d55', dark: '#ff375f' },
  { key: 'teal', label: 'Teal', light: '#30b0c7', dark: '#40c8e0' },
  { key: 'yellow', label: 'Yellow', light: '#ffcc00', dark: '#ffd60a' },
  { key: 'indigo', label: 'Indigo', light: '#5856d6', dark: '#5e5ce6' },
  { key: 'red', label: 'Red', light: '#ff3b30', dark: '#ff453a' },
  { key: 'mint', label: 'Mint', light: '#00c7be', dark: '#63e6e2' },
  { key: 'brown', label: 'Brown', light: '#a2845e', dark: '#ac8e68' },
  { key: 'graphite', label: 'Graphite', light: '#8e8e93', dark: '#98989d' }
]

/** Colour stored on a group: the light variant (the renderer maps it to the dark variant in dark mode). */
export function nextGroupColor(groups: SessionGroup[]): string {
  const used = new Set(groups.map((g) => (g.color ?? '').toLowerCase()))
  const free = GROUP_PALETTE.find((c) => !used.has(c.light.toLowerCase()))
  if (free) return free.light
  return GROUP_PALETTE[groups.length % GROUP_PALETTE.length].light
}

/** The palette entry a stored colour belongs to (undefined for custom colours). */
export function paletteEntry(color: string | undefined): PaletteColor | undefined {
  if (!color) return undefined
  const c = color.toLowerCase()
  return GROUP_PALETTE.find((p) => p.light.toLowerCase() === c || p.dark.toLowerCase() === c)
}

/** Colour to draw for a group in the current theme. */
export function groupColorFor(group: { color?: string } | null | undefined, dark: boolean): string | undefined {
  if (!group?.color) return undefined
  const entry = paletteEntry(group.color)
  return entry ? (dark ? entry.dark : entry.light) : group.color
}
