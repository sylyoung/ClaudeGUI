import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface PopupOption {
  value: string
  /** Full text shown in the open list ("acceptEdits — accept file edits automatically"). */
  label: string
  /** Short text shown on the closed control ("acceptEdits"); defaults to the full label. */
  short?: string
  /** Explanation shown as a tooltip while hovering the option. */
  hint?: string
  disabled?: boolean
  /** A group title in the open list (not a choice). */
  heading?: boolean
}

/**
 * Compact drop-down: the closed control shows a short label so several of them fit on one line,
 * the open list shows the full text of every option (with its explanation as a tooltip).
 */
export function PopupSelect({ label, value, options, onChange, tip, className, minWidth = 220 }: { label?: string; value: string; options: PopupOption[]; onChange: (value: string) => void; tip?: string; className?: string; minWidth?: number }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (list.current && !list.current.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', () => setOpen(false))
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const rect = btn.current?.getBoundingClientRect()
  const width = Math.max(minWidth, rect?.width ?? 0)
  const left = rect ? Math.min(rect.left, window.innerWidth - width - 8) : 8
  const top = rect ? rect.bottom + 4 : 40
  const fullTip = [tip, current ? `Current: ${current.label}` : ''].filter(Boolean).join('\n')
  return (
    <>
      <button ref={btn} className={`popup-select no-drag ${open ? 'open' : ''} ${className ?? ''}`} onClick={() => setOpen((o) => !o)} data-tip={fullTip}>
        {label && <span className="ps-label">{label}</span>}
        <span className="ps-value">{current?.short ?? current?.label ?? value}</span>
        <ChevronDown size={12} className="ps-arrow" />
      </button>
      {open && (
        <div className="ctx-menu popup-list" ref={list} style={{ left, top, width, maxHeight: Math.max(160, window.innerHeight - top - 12) }}>
          {options.map((o) =>
            o.heading ? (
              <div key={o.value} className="popup-heading" data-tip={o.hint}>{o.label}</div>
            ) : (
              <button
                key={o.value}
                className={o.value === value ? 'checked' : ''}
                disabled={o.disabled}
                data-tip={o.hint}
                onClick={() => {
                  setOpen(false)
                  if (o.value !== value) onChange(o.value)
                }}
              >
                <span className="ctx-label">{o.label}</span>
                {o.value === value && <Check size={12} className="ctx-check" />}
              </button>
            )
          )}
        </div>
      )}
    </>
  )
}
