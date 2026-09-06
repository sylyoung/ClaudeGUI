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

export const EFFORTS: (EffortLevel | '')[] = ['', 'low', 'medium', 'high', 'xhigh', 'max']

export const EFFORT_LABELS: Record<string, string> = {
  '': 'default — the model decides',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh — extra high',
  max: 'max — maximum'
}
