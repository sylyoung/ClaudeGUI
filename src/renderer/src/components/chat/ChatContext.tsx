import React, { createContext, useContext } from 'react'

export interface ChatCtx {
  sessionId: string
  cwd: string
  openPath: (raw: string, line?: number, opts?: { inEditor?: boolean }) => void
  showPathMenu: (raw: string, line: number | undefined, x: number, y: number) => void
  /** Open the rewind window for one of your own prompts. */
  rewindTo: (messageId: string) => void
  /** Right-click menu of one of your own prompts (copy, rewind). */
  showPromptMenu: (messageId: string, text: string, x: number, y: number) => void
}

const Ctx = createContext<ChatCtx | null>(null)

export function ChatProvider({ value, children }: { value: ChatCtx; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useChatCtx(): ChatCtx | null {
  return useContext(Ctx)
}
