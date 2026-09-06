import React, { useEffect, useRef } from 'react'

/** Small anchored panel that closes on outside click, Escape or window blur. */
export function Popover({ anchor, onClose, children, width = 360, align = 'right' }: { anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode; width?: number; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(anchor && anchor.contains(e.target as Node))) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, anchor])
  const rect = anchor?.getBoundingClientRect()
  const top = (rect?.bottom ?? 40) + 6
  const style: React.CSSProperties = { top, width, maxWidth: 'calc(100vw - 24px)' }
  if (align === 'right') style.right = Math.max(8, window.innerWidth - (rect?.right ?? window.innerWidth))
  else style.left = Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - width - 8))
  return (
    <div className="popover" style={style} ref={ref}>
      {children}
    </div>
  )
}
