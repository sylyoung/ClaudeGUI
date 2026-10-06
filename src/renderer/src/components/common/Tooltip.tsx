import React, { useEffect, useState } from 'react'
import { useStore } from '@/store'

interface Tip {
  text: string
  x: number
  y: number
  side: 'top' | 'bottom'
}

/**
 * Global hover explanations: any element with a `data-tip` attribute gets a styled tooltip after a
 * short delay (also on keyboard focus). Multi-line text is allowed. Disabled by the
 * "Hover explanations" setting.
 */
export function TooltipLayer() {
  const enabled = useStore((s) => s.settings?.showTooltips ?? true)
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    if (!enabled) {
      setTip(null)
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let current: Element | null = null
    const hide = () => {
      if (timer) clearTimeout(timer)
      timer = null
      current = null
      setTip(null)
    }
    const show = (el: Element) => {
      const text = el.getAttribute('data-tip')
      if (!text || !el.isConnected) return
      const r = el.getBoundingClientRect()
      const side: 'top' | 'bottom' = r.bottom + 90 > window.innerHeight ? 'top' : 'bottom'
      setTip({ text, x: Math.min(Math.max(r.left + r.width / 2, 180), Math.max(180, window.innerWidth - 180)), y: side === 'bottom' ? r.bottom + 7 : r.top - 7, side })
    }
    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null
      if (el === current) return
      if (timer) clearTimeout(timer)
      current = el
      setTip(null)
      if (el) timer = setTimeout(() => show(el), 380)
    }
    const onFocus = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null
      if (!el) return
      current = el
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => show(el), 500)
    }
    const onLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) hide()
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onLeave)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onLeave)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      if (timer) clearTimeout(timer)
    }
  }, [enabled])

  if (!tip) return null
  return (
    <div className={`tooltip ${tip.side}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.text}
    </div>
  )
}
