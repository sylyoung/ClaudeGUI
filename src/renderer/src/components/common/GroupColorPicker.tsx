import React, { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { GROUP_PALETTE, paletteEntry } from '@shared/colors'
import { useStore } from '@/store'
import { isDarkTheme } from '@/lib/theme'

/** Small floating palette to pick a group colour (macOS system colours + a custom colour). */
export function GroupColorPicker({ x, y, color, title, onPick, onClose }: { x: number; y: number; color?: string; title?: string; onPick: (color: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useStore((s) => s.theme)
  const settings = useStore((s) => s.settings)
  const dark = isDarkTheme(settings?.theme ?? 'system', theme.systemDark)
  const [custom, setCustom] = useState(color && !paletteEntry(color) ? color : '#888888')
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const current = paletteEntry(color)
  const left = Math.min(x, window.innerWidth - 232)
  const top = Math.min(y, window.innerHeight - 150)
  return (
    <div className="ctx-menu color-picker" ref={ref} style={{ left, top }}>
      {title && <div className="cp-title">{title}</div>}
      <div className="swatches">
        {GROUP_PALETTE.map((c) => (
          <button key={c.key} className={`swatch ${current?.key === c.key ? 'active' : ''}`} style={{ background: dark ? c.dark : c.light }} data-tip={c.label} onClick={() => onPick(c.light)}>
            {current?.key === c.key && <Check size={12} />}
          </button>
        ))}
        <label className={`swatch custom ${color && !current ? 'active' : ''}`} style={{ background: color && !current ? color : custom }} data-tip="Custom colour…">
          <input
            type="color"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value)
              onPick(e.target.value)
            }}
          />
          {color && !current && <Check size={12} />}
        </label>
      </div>
    </div>
  )
}
