import type { EffortLevel, PermissionMode } from '@shared/types'

/** Full permission-mode names with their meaning (no abbreviations). */
export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'default — ask before risky actions', hint: 'Claude asks for permission before running commands or editing files that are not pre-approved' },
  { value: 'acceptEdits', label: 'acceptEdits — accept file edits automatically', hint: 'File edits are applied without asking; other risky actions still ask' },
  { value: 'auto', label: 'auto — a classifier approves safe actions', hint: 'Safe actions are approved automatically, doubtful ones ask' },
  { value: 'plan', label: 'plan — read-only planning', hint: 'Claude may only read and plan; no edits or commands' },
  { value: 'dontAsk', label: 'dontAsk — deny anything not pre-approved', hint: 'Nothing is asked; actions that are not pre-approved are denied' },
  { value: 'bypassPermissions', label: 'bypassPermissions — skip all permission checks', hint: 'Every action runs without asking (use with care)' }
]

/**
 * The modes ⇧⇥ steps through in a chat, in the order the terminal uses: ask before risky actions,
 * then accept file edits, then read-only planning. The rarer modes stay in the picker in the chat
 * header so a key press cannot land on them by accident.
 */
export const CYCLE_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan']

export const EFFORTS: (EffortLevel | '')[] = ['', 'low', 'medium', 'high', 'xhigh', 'max']

export const EFFORT_LABELS: Record<string, string> = {
  '': 'default — the model decides',
  low: 'low — quick answers, little reasoning',
  medium: 'medium — balanced',
  high: 'high — thorough reasoning',
  xhigh: 'xhigh — extra high, very thorough',
  max: 'max — maximum reasoning (slowest)'
}

/** Short text for the closed control (the open list shows the full label). */
export const EFFORT_SHORT: Record<string, string> = { '': 'default', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
