import React, { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
  checked?: boolean
  /** Nested items open in a submenu on hover. */
  children?: MenuItem[]
  /** Explanation shown as a hover tooltip. */
  tip?: string
}

function Items({ items, onClose, depth }: { items: MenuItem[]; onClose: () => void; depth: number }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  return (
    <>
      {items.map((it, i) =>
        it.separator ? (
          <div className="sep" key={i} />
        ) : (
          <div key={i} className="ctx-item-wrap" onMouseEnter={() => setOpenIdx(it.children ? i : null)}>
            <button
              className={`${it.danger ? 'danger' : ''} ${it.children ? 'has-children' : ''} ${it.checked ? 'checked' : ''}`}
              disabled={it.disabled}
              data-tip={it.tip}
              onClick={() => {
                if (it.children) {
                  setOpenIdx(i)
                  return
                }
                onClose()
                it.onClick()
              }}
            >
              <span className="ctx-label">{it.label}</span>
              {it.checked && <span className="ctx-check">✓</span>}
              {it.children && <ChevronRight size={12} className="ctx-arrow" />}
            </button>
            {it.children && openIdx === i && (
              <div className={`ctx-menu submenu depth-${depth + 1}`}>
                {it.children.length ? <Items items={it.children} onClose={onClose} depth={depth + 1} /> : <div className="ctx-empty">Nothing here</div>}
              </div>
            )}
          </div>
        )
      )}
    </>
  )
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
  const visible = items.filter((i) => !i.separator).length
  const style: React.CSSProperties = { left: Math.min(x, window.innerWidth - 240), top: Math.min(y, Math.max(8, window.innerHeight - visible * 30 - 24)) }
  return (
    <div className="ctx-menu" style={style} ref={ref}>
      <Items items={items} onClose={onClose} depth={0} />
    </div>
  )
}
