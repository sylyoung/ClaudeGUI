import React, { createContext, useContext } from 'react'

export interface ChatCtx {
  sessionId: string
  cwd: string
  openPath: (raw: string, line?: number, opts?: { inEditor?: boolean }) => void
  showPathMenu: (raw: string, line: number | undefined, x: number, y: number) => void
}

const Ctx = createContext<ChatCtx | null>(null)

export function ChatProvider({ value, children }: { value: ChatCtx; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useChatCtx(): ChatCtx | null {
  return useContext(Ctx)
}
