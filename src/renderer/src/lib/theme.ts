import type { AccentColor, AppSettings, ThemeInfo, ThemeMode } from '@shared/types'
import hljsDark from 'highlight.js/styles/github-dark-dimmed.css?inline'
import hljsLight from 'highlight.js/styles/github.css?inline'

/** macOS system accent colours (light / dark variants). */
export const ACCENTS: Record<Exclude<AccentColor, 'system'>, { light: string; dark: string; label: string }> = {
  blue: { light: '#007aff', dark: '#0a84ff', label: 'Blue' },
  purple: { light: '#af52de', dark: '#bf5af2', label: 'Purple' },
  pink: { light: '#ff2d55', dark: '#ff375f', label: 'Pink' },
  red: { light: '#ff3b30', dark: '#ff453a', label: 'Red' },
  orange: { light: '#ff9500', dark: '#ff9f0a', label: 'Orange' },
  yellow: { light: '#ffcc00', dark: '#ffd60a', label: 'Yellow' },
  green: { light: '#34c759', dark: '#30d158', label: 'Green' },
  graphite: { light: '#8e8e93', dark: '#98989d', label: 'Graphite' },
  claude: { light: '#d97757', dark: '#d97757', label: 'Claude orange' }
}

export function isDarkTheme(theme: ThemeMode, systemDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark)
}

export function resolveAccent(accent: AccentColor, dark: boolean, systemAccent: string): string {
  if (accent === 'system') return systemAccent || ACCENTS.blue[dark ? 'dark' : 'light']
  const a = ACCENTS[accent] ?? ACCENTS.blue
  return dark ? a.dark : a.light
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export type AppearanceSettings = Pick<AppSettings, 'theme' | 'accent' | 'fontSize' | 'uiFont' | 'codeFont' | 'codeFontSize' | 'density' | 'chatMaxWidth' | 'translucentSidebar'>

/** Push the appearance settings into CSS variables / data attributes on <html>. */
export function applyTheme(s: AppearanceSettings, info: ThemeInfo): boolean {
  const dark = isDarkTheme(s.theme, info.systemDark)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.density = s.density || 'comfortable'
  root.dataset.translucent = s.translucentSidebar ? '1' : '0'
  const accent = resolveAccent(s.accent, dark, info.accent)
  const rgb = hexToRgb(accent)
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-rgb', rgb.join(', '))
  root.style.setProperty('--accent-text', luminance(rgb) > 0.5 ? '#1d1d1f' : '#ffffff')
  root.style.setProperty('--font-size', `${s.fontSize || 14}px`)
  root.style.setProperty('--code-size', `${s.codeFontSize || 12.5}px`)
  root.style.setProperty('--chat-max-width', `${s.chatMaxWidth || 980}px`)
  if (s.uiFont?.trim()) root.style.setProperty('--sans', s.uiFont)
  else root.style.removeProperty('--sans')
  if (s.codeFont?.trim()) root.style.setProperty('--mono', s.codeFont)
  else root.style.removeProperty('--mono')
  let el = document.getElementById('hljs-theme') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'hljs-theme'
    document.head.appendChild(el)
  }
  const css = dark ? hljsDark : hljsLight
  if (el.textContent !== css) el.textContent = css
  localStorage.setItem('theme-dark', dark ? '1' : '0')
  return dark
}
