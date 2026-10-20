import catalogue from './claudeSettingsSchema.json'
import type { SessionRecord } from './types'

export type ConfigValues = Record<string, unknown>
export type ConfigScope = 'chat' | 'user' | 'project' | 'local'
export interface SettingSchema {
  type?: string
  const?: unknown
  enum?: unknown[]
  anyOf?: SettingSchema[]
  properties?: Record<string, SettingSchema>
  required?: string[]
  additionalProperties?: boolean | SettingSchema
  items?: SettingSchema
  prefixItems?: SettingSchema[]
  minItems?: number
  maxItems?: number
  description?: string
}
export interface ConfigLayer {
  values: ConfigValues
  inherited: ConfigValues
  revision: string
  path?: string
  enabled: boolean
  writable: boolean
  warning?: string
}
export interface ClaudeConfigView {
  layers: Record<ConfigScope, ConfigLayer>
  managedKeys: string[]
  running: boolean
  chatSupported: boolean
  idleCompactionSupported?: boolean
  idleCompactionMinimumHostVersion?: string
  live?: ConfigValues
}
export interface NativeConfigSnapshot {
  saved: ConfigValues
  effective?: ConfigValues
}
export interface ConfigSaveRequest {
  scope: ConfigScope
  values: ConfigValues
  revision: string
  confirmShared?: boolean
}
export interface ConfigSaveResult {
  view: ClaudeConfigView
  message: string
}

export const SETTINGS_SDK_VERSION = catalogue.sdkVersion
export const SETTINGS_SCHEMA = catalogue as unknown as SettingSchema
export const SETTINGS = SETTINGS_SCHEMA.properties!
export const CONFIG_SCOPES: { value: ConfigScope; label: string; hint: string }[] = [
  { value: 'chat', label: 'This chat', hint: 'Overrides saved for this chat only. Other chats and Claude Code in the terminal are unchanged.' },
  { value: 'user', label: 'User', hint: 'Shared by all your Claude Code chats and projects, including the terminal.' },
  { value: 'project', label: 'Project', hint: 'Shared project settings. This file may be committed and shared with other people.' },
  { value: 'local', label: 'Local project', hint: 'Private settings for chats in this project. Do not commit this file.' }
]
export const REDACTED_CONFIG_VALUE = '•••• (unchanged secret)'
export const IDLE_COMPACTION_MIN_TOKENS_ENV = 'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'
const PRIVATE_KEY = /token|password|secret|credential|authorization|api.?key|access.?key|private.?key|cookie/i
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const TITLES: Record<string, string> = {
  autoCompactEnabled: 'Automatic compaction',
  autoCompactWindow: 'Automatic compaction context limit (tokens)',
  precomputeCompactionEnabled: 'Prepare compaction in the background',
  idleCompaction: 'Idle compaction',
  env: 'Environment variables',
  permissions: 'Tool permissions',
  effortLevel: 'Reasoning effort',
  fastMode: 'Fast mode',
  autoMemoryEnabled: 'Automatic memory',
  hooks: 'Hooks',
  model: 'Model'
}
export function settingTitle(key: string): string {
  return TITLES[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase())
}
export function settingCategory(key: string): string {
  if (/compact|cache|memory|dream|claudeMd|plansDirectory/i.test(key)) return 'Context & memory'
  if (/model|effort|thinking|fastMode|advisor|ultracode|agent$/i.test(key)) return 'Models & reasoning'
  if (/permission|sandbox|managed|allow|deny|login|gateway|policy|crossSession|peerMachines|parentSettings/i.test(key)) return 'Permissions & security'
  if (/mcp|plugin|marketplace|skill|channel|hook|worktree|artifact|workflow/i.test(key)) return 'Tools & extensions'
  if (/env|helper|credential|auth|processWrapper|shell|remote|updates|version|cleanup|ssh/i.test(key)) return 'Environment & system'
  return 'Behaviour & display'
}
export const CONFIG_CATEGORIES = ['All settings', 'Context & memory', 'Models & reasoning', 'Permissions & security', 'Tools & extensions', 'Environment & system', 'Behaviour & display']
export function settingNotice(key: string): string | undefined {
  if (/^(theme|editorMode|keybindingFlavor|vimInsertModeRemaps|tui|defaultView|timeFormat|timeZone|viewMode|verbose|preferredNotifChannel|spinner|syntaxHighlighting|spellcheck|terminalTitle|autoScroll|wheelScroll|terminalProgress|showTurnDuration|showMessageTimestamps|voice)/.test(key)) return 'Claude Code terminal setting; this does not change ClaudeGUI’s appearance or controls.'
  if (key === 'idleCompaction') return 'In ClaudeGUI, explicitly choosing On enables app-owned idle scheduling of Claude Code’s native /compact command; the terminal-only timer is not used. Default: off unless enabled here or in an inherited scope. Claude chats require a warm one-hour cache and compact at about 54 minutes. GPT and other providers compact after 54 minutes without a finished turn or interaction in the chat, without requiring a Claude cache report; this may use uncached model tokens. Both require at least 200,000 context tokens by default. Busy chats, usage limits, request-setting changes and fast mode prevent an automatic request. Saving never starts a stopped chat.'
  if (key === 'fastMode') return 'Fast mode may use additional paid usage. Saving this setting does not send a prompt.'
  if (key === 'autoCompactWindow') return 'Claude Code accepts 100,000–1,000,000 tokens. This does not enlarge the model’s actual context window.'
  if (/^(env|processWrapper|apiKeyHelper|proxyAuthHelper|aws|gcp|defaultShell|forceLogin|autoUpdates|minimumVersion|required|fileCheckpointing)/.test(key)) return 'May require the chat process to start again. Saving never stops a running chat.'
  return undefined
}
export function isConfigObject(value: unknown): value is ConfigValues {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function configValueAt(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isConfigObject(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}
export function setConfigValue(values: ConfigValues, path: string[], value: unknown): ConfigValues {
  if (!path.length || path.some((key) => UNSAFE_KEYS.has(key))) throw new Error('Invalid setting path')
  const next = structuredClone(values)
  let target = next
  for (const key of path.slice(0, -1)) {
    if (!isConfigObject(target[key])) target[key] = {}
    target = target[key] as ConfigValues
  }
  const key = path.at(-1)!
  if (value === undefined) delete target[key]
  else target[key] = value
  // An empty parent is removed too, so resetting the final permission field really inherits it.
  for (let i = path.length - 1; i > 0; i--) {
    const parent = configValueAt(next, path.slice(0, i))
    if (!isConfigObject(parent) || Object.keys(parent).length) break
    const container = i === 1 ? next : configValueAt(next, path.slice(0, i - 1)) as ConfigValues
    delete container[path[i - 1]]
  }
  return next
}
export function sameConfig(a: unknown, b: unknown): boolean {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : isConfigObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

/** Secret placeholders travel to the window, never the credential values they stand for. */
export function redactConfig(values: ConfigValues): ConfigValues {
  const secretValue = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    if (/Bearer\s+|-----BEGIN .*PRIVATE KEY-----|(?:api[-_ ]?key|authorization)\s*[:=]/i.test(value)) return true
    try { const url = new URL(value); return Boolean(url.username || url.password) } catch { return false }
  }
  const visit = (value: unknown): unknown => {
    if (secretValue(value)) return REDACTED_CONFIG_VALUE
    if (Array.isArray(value)) return value.map(visit)
    if (!isConfigObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, !(key === IDLE_COMPACTION_MIN_TOKENS_ENV && typeof v === 'string' && /^\d+$/.test(v)) && PRIVATE_KEY.test(key) && v != null || secretValue(v) ? REDACTED_CONFIG_VALUE : visit(v)]))
  }
  return visit(values) as ConfigValues
}
export function restoreConfigSecrets(values: ConfigValues, original: ConfigValues): ConfigValues {
  const visit = (value: unknown, old: unknown, masked: unknown): unknown => {
    if (value === REDACTED_CONFIG_VALUE) {
      if (old === undefined || masked !== REDACTED_CONFIG_VALUE) throw new Error('A secret placeholder has no saved value at this position. Enter a new value or remove the setting.')
      return structuredClone(old)
    }
    if (Array.isArray(value)) return value.map((v, i) => visit(v, Array.isArray(old) ? old[i] : undefined, Array.isArray(masked) ? masked[i] : undefined))
    if (!isConfigObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, visit(v, isConfigObject(old) && Object.hasOwn(old, key) ? old[key] : undefined, isConfigObject(masked) && Object.hasOwn(masked, key) ? masked[key] : undefined)]))
  }
  return visit(values, original, redactConfig(original)) as ConfigValues
}

/** Validate structure from the installed SDK, without including setting values in an error. */
export function validateClaudeConfig(value: unknown, original: ConfigValues = {}, chat = false): string[] {
  if (!isConfigObject(value)) return ['Configuration must be a JSON object.']
  const errors: string[] = []
  const unsafe = (v: unknown, depth = 0): boolean => {
    if (depth > 40) return true
    if (Array.isArray(v)) return v.some((x) => unsafe(x, depth + 1))
    return isConfigObject(v) && Object.entries(v).some(([k, x]) => UNSAFE_KEYS.has(k) || unsafe(x, depth + 1))
  }
  if (unsafe(value)) return ['Configuration contains an unsafe property name or is nested too deeply.']
  function matches(v: unknown, s: SettingSchema): boolean {
    if (v === REDACTED_CONFIG_VALUE) return true // The main process restores and validates the saved value.
    if (s.anyOf) return s.anyOf.some((x) => matches(v, x))
    if ('const' in s) return v === s.const
    if (s.enum) return s.enum.includes(v)
    if (s.type === 'null') return v === null
    if (s.type === 'object') {
      if (!isConfigObject(v)) return false
      if (s.required?.some((k) => !Object.hasOwn(v, k))) return false
      return Object.entries(v).every(([k, x]) => s.properties?.[k] ? matches(x, s.properties[k]) : s.additionalProperties === false ? false : isConfigObject(s.additionalProperties) ? matches(x, s.additionalProperties as SettingSchema) : true)
    }
    if (s.type === 'array') return Array.isArray(v) && (s.minItems === undefined || v.length >= s.minItems) && (s.maxItems === undefined || v.length <= s.maxItems) && v.every((x, i) => matches(x, s.prefixItems?.[i] ?? s.items ?? {}))
    if (s.type === 'number') return typeof v === 'number' && Number.isFinite(v)
    return !s.type || typeof v === s.type
  }
  for (const [key, v] of Object.entries(value)) {
    if (sameConfig(v, original[key])) continue // Preserve future or legacy settings without rewriting them.
    if (!Object.hasOwn(SETTINGS, key)) errors.push(`${key}: not a setting supported by the installed Claude Code SDK.`)
    else if (!(chat && key === 'effortLevel' && v === 'max') && !matches(v, SETTINGS[key])) errors.push(`${key}: the value does not match the documented setting type. Check required fields and allowed choices.`)
    if (key === 'autoCompactWindow' && (typeof v !== 'number' || !Number.isInteger(v) || v < 100_000 || v > 1_000_000)) errors.push('autoCompactWindow: enter a whole number between 100,000 and 1,000,000 tokens.')
    if (key === 'env') {
      const minimum = configValueAt(v, [IDLE_COMPACTION_MIN_TOKENS_ENV])
      if (minimum !== undefined && !sameConfig(minimum, configValueAt(original, ['env', IDLE_COMPACTION_MIN_TOKENS_ENV])) && (typeof minimum !== 'string' || !/^\d+$/.test(minimum) || !Number.isSafeInteger(Number(minimum)) || Number(minimum) <= 0)) errors.push(`${IDLE_COMPACTION_MIN_TOKENS_ENV}: enter a positive whole number as an environment-variable string. Values below 100,000 are raised to 100,000.`)
    }
  }
  return errors
}

/** Existing toolbar selections are chat overrides too; show them in the same editor. */
export function sessionConfig(record: SessionRecord): ConfigValues {
  if (record.claudeSettings !== undefined) return structuredClone(record.claudeSettings)
  return {
    ...(record.model && { model: record.model }),
    permissions: { defaultMode: record.permissionMode },
    ...(record.effort && { effortLevel: record.effort }),
    fastMode: record.fastMode === true
  }
}
export function sessionRecordForWindow(record: SessionRecord): SessionRecord {
  return record.claudeSettings === undefined ? record : { ...record, claudeSettings: redactConfig(record.claudeSettings) }
}
export function startupResets(startup: ConfigValues, next: ConfigValues): string[] {
  const removes = (before: unknown, after: unknown): boolean => {
    if (after === undefined) return true
    if (isConfigObject(before) && isConfigObject(after)) return Object.keys(before).some((key) => removes(before[key], after[key]))
    if (Array.isArray(before) && Array.isArray(after)) return before.some((entry) => !after.some((item) => sameConfig(entry, item)))
    return false
  }
  return Object.keys(startup).filter((key) => removes(startup[key], next[key]))
}
export function configPatch(before: ConfigValues, after: ConfigValues): ConfigValues {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !sameConfig(before[k], after[k])).map((k) => [k, Object.hasOwn(after, k) ? after[k] : null]))
}
