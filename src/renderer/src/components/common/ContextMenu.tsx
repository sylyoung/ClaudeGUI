import React, { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  separator?: boolean
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
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
  }, [onClose])
  const style: React.CSSProperties = { left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - items.length * 30 - 20) }
  return (
    <div className="ctx-menu" style={style} ref={ref}>
      {items.map((it, i) =>
        it.separator ? (
          <div className="sep" key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}
