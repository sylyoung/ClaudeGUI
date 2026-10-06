import React, { useEffect } from 'react'
import { isComposing } from '@/lib/keys'

/** `tall` makes the dialog fill most of the window height; the content is then expected to scroll
 *  a `.grow` element inside it rather than the dialog itself. */
export function Modal({ title, onClose, children, width, tall }: { title: string; onClose: () => void; children: React.ReactNode; width?: number; tall?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the candidate list of an input method first; the dialog stays open.
      if (e.key === 'Escape' && !isComposing(e)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${tall ? 'tall' : ''}`} style={width ? { width } : undefined} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}
