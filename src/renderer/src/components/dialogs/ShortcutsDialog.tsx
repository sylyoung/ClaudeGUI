import React from 'react'
import { Modal } from '../common/Modal'

/**
 * Everything the keyboard does, written out — the counterpart of the "? for shortcuts" list in the
 * terminal. It is reachable from a button beside the input box and from the Session menu, because a
 * key that cannot be found is a key that does not exist.
 */
const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'The input box',
    rows: [
      ['⏎', 'Send the message (⇧⏎ makes a new line). With "send with Enter" switched off it is ⌘⏎ that sends.'],
      ['↑ / ↓', 'Walk through the prompts you typed in this chat. A prompt Claude Code has not taken yet is pulled out of the queue when you bring it back here.'],
      ['/', 'Commands and skills, anywhere in the sentence — not only at the start of the box.'],
      ['⌘L', 'Put the cursor in the input box.'],
      ['paste, drop', 'Text stays text; an image is attached only when the clipboard holds no text.']
    ]
  },
  {
    title: 'The running turn',
    rows: [
      ['esc', 'Stop the turn that is running. The prompt goes back into the input box so you can change it and send it again.'],
      ['esc esc', 'Rewind: pick one of your earlier prompts; everything after it is removed from the chat, and the next window asks whether the files should be put back as well.'],
      ['⇧⇥', 'Next permission mode: ask before risky actions → accept file edits → read-only planning.'],
      ['⌘.', 'Stop the turn that is running (also in the Session menu).'],
      ['⌘⏎', 'Allow the permission that is waiting.']
    ]
  },
  {
    title: 'Sessions and panels',
    rows: [
      ['⌘K', 'Search the sessions in the sidebar.'],
      ['⌘1 … ⌘9', 'Jump to the first nine sessions of the sidebar.'],
      ['⌘⇧] / ⌘⇧[', 'Next / previous session.'],
      ['⌘N', 'New session; ⌘⇧I imports one from the terminal.'],
      ['⌘B', 'Show or hide the sidebar; ⌘⇧E the folder panel, ⌘⇧G the Git panel, ⌘⇧S the statistics bar.']
    ]
  }
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={760}>
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <div key={g.title} className="sc-group">
            <h3>{g.title}</h3>
            {g.rows.map(([keys, what]) => (
              <div key={keys} className="sc-row">
                <span className="kbd">{keys}</span>
                <span>{what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}
