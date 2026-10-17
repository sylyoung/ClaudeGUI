import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RefreshCw, Search, Settings, SlidersHorizontal } from 'lucide-react'
import {
  CONFIG_CATEGORIES, CONFIG_SCOPES, IDLE_COMPACTION_MIN_TOKENS_ENV, REDACTED_CONFIG_VALUE, SETTINGS, SETTINGS_SDK_VERSION,
  configValueAt, isConfigObject, sameConfig, setConfigValue, settingCategory, settingNotice, settingTitle, validateClaudeConfig,
  type ClaudeConfigView, type ConfigScope, type ConfigValues, type SettingSchema
} from '@shared/claudeConfig'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import './ChatSettingsDialog.css'

interface ControlProps {
  path: string[]
  schema: SettingSchema
  value: unknown
  inherited: unknown
  onChange: (path: string[], value: unknown) => void
  onInvalid: (key: string, error?: string) => void
  disabled: boolean
  depth?: number
}
const preview = (v: unknown): string => v === undefined ? 'Claude Code default' : typeof v === 'boolean' ? v ? 'On' : 'Off' : typeof v === 'object' ? JSON.stringify(v) : String(v)

function JsonSetting({ path, value, inherited, onChange, onInvalid, disabled }: ControlProps) {
  const serialized = value === undefined ? '' : JSON.stringify(value, null, 2)
  const [text, setText] = useState(serialized)
  const [error, setError] = useState('')
  const key = path.join('.')
  useEffect(() => { setText(serialized); setError(''); onInvalid(key) }, [serialized, key, onInvalid])
  return (
    <div className="config-json-field">
      <textarea className="input mono" aria-label={`${key} JSON`} rows={Math.min(10, Math.max(3, text.split('\n').length))} value={text} disabled={disabled} spellCheck={false}
        placeholder={inherited === undefined ? 'JSON value (empty = inherit)' : `Inherited: ${JSON.stringify(inherited, null, 2)}`}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          try {
            const parsed = next.trim() ? JSON.parse(next) : undefined
            setError(''); onInvalid(key); onChange(path, parsed)
          } catch {
            const message = `${key}: enter valid JSON, or clear the field to inherit.`
            setError(message); onInvalid(key, message)
          }
        }} />
      {error && <div className="config-error" role="alert">{error}</div>}
    </div>
  )
}

function SettingControl(props: ControlProps) {
  const { path, schema, value, inherited, onChange, disabled, depth = 0 } = props
  const id = `config-${path.join('.')}`
  const inheritedLabel = `Inherit — ${path[0] === 'idleCompaction' && inherited === undefined ? 'Off in ClaudeGUI' : preview(inherited)}`
  if (schema.type === 'boolean') return (
    <select className="select" id={id} aria-label={path.join('.')} disabled={disabled} value={value === undefined ? 'inherit' : value ? 'on' : 'off'} onChange={(e) => onChange(path, e.target.value === 'inherit' ? undefined : e.target.value === 'on')}>
      <option value="inherit">{inheritedLabel}</option><option value="on">On</option><option value="off">Off</option>
    </select>
  )
  const choices = schema.enum ?? ('const' in schema ? [schema.const] : undefined)
  if (choices) return (
    <select className="select" id={id} aria-label={path.join('.')} disabled={disabled} value={value === undefined ? '' : JSON.stringify(value)} onChange={(e) => onChange(path, e.target.value ? JSON.parse(e.target.value) : undefined)}>
      <option value="">{inheritedLabel}</option>
      {choices.map((v) => <option key={JSON.stringify(v)} value={JSON.stringify(v)}>{String(v)}</option>)}
    </select>
  )
  if (schema.type === 'string' || schema.type === 'number') return (
    <input className="input" id={id} aria-label={path.join('.')} disabled={disabled}
      type={schema.type === 'number' || path.at(-1) === IDLE_COMPACTION_MIN_TOKENS_ENV ? 'number' : value === REDACTED_CONFIG_VALUE || /token|secret|password|api.?key/i.test(path.at(-1)!) ? 'password' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''} spellCheck={false} autoComplete="off"
      min={path[0] === 'autoCompactWindow' ? 100000 : undefined} max={path[0] === 'autoCompactWindow' ? 1000000 : undefined} step={schema.type === 'number' ? 'any' : undefined}
      placeholder={inheritedLabel} onChange={(e) => onChange(path, schema.type === 'number' ? e.target.value === '' ? undefined : Number(e.target.value) : e.target.value)} />
  )
  if (schema.type === 'object' && schema.properties && Object.keys(schema.properties).length && depth < 3) return (
    <details className="config-object">
      <summary data-tip="Edit individual fields, or use JSON to include complex and additional fields">Fields and JSON <span className="faint">{value === undefined ? 'inherited' : `${isConfigObject(value) ? Object.keys(value).length : 0} set here`}</span></summary>
      <div className="config-nested">
        {Object.entries(schema.properties).map(([key, child]) => {
          const childPath = [...path, key]
          return <div className="config-child" key={key}>
            <label htmlFor={`config-${childPath.join('.')}`} data-tip={child.description}>{settingTitle(key)} <code>{key}</code></label>
            <div className="config-child-input">
              <SettingControl {...props} path={childPath} schema={child} value={configValueAt(value, [key])} inherited={configValueAt(inherited, [key])} depth={depth + 1} />
              <button className="btn ghost sm" disabled={disabled || configValueAt(value, [key]) === undefined} data-tip="Remove this field from this scope and inherit its value" onClick={() => onChange(childPath, undefined)}>Reset</button>
            </div>
          </div>
        })}
        <label className="faint">Complete object (JSON, including additional fields)</label>
        <JsonSetting {...props} />
      </div>
    </details>
  )
  return <JsonSetting {...props} />
}

type LeaveAction = ConfigScope | 'close' | 'reload' | 'app'
const PRIORITY = ['idleCompaction', 'autoCompactEnabled', 'autoCompactWindow', 'precomputeCompactionEnabled', 'model', 'effortLevel', 'permissions', 'env']

export function ChatSettingsDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const title = useStore((s) => s.records[sessionId]?.title ?? 'Chat')
  const initialSearch = useStore((s) => s.configSearch ?? '')
  const configError = useStore((s) => s.live[sessionId]?.configError)
  const configPending = useStore((s) => s.live[sessionId]?.configPending)
  const idleCompaction = useStore((s) => s.live[sessionId]?.idleCompaction)
  const openSettings = useStore((s) => s.openSettings)
  const [view, setView] = useState<ClaudeConfigView | null>(null)
  const [scope, setScope] = useState<ConfigScope>('chat')
  const [draft, setDraft] = useState<ConfigValues>({})
  const [search, setSearch] = useState(initialSearch)
  const [category, setCategory] = useState('All settings')
  const [onlySet, setOnlySet] = useState(false)
  const [tab, setTab] = useState<'controls' | 'json' | 'effective'>('controls')
  const [raw, setRaw] = useState('{}')
  const [invalid, setInvalid] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirmShared, setConfirmShared] = useState(false)
  const [leave, setLeave] = useState<LeaveAction | null>(null)
  const layer = view?.layers[scope]
  const baseline = layer?.values ?? {}
  const dirty = !sameConfig(draft, baseline) || Object.keys(invalid).length > 0
  const errors = useMemo(() => [...Object.values(invalid), ...validateClaudeConfig(draft, baseline, scope === 'chat')], [draft, baseline, invalid, scope])
  const changed = Object.keys({ ...baseline, ...draft }).filter((key) => !sameConfig(baseline[key], draft[key])).length
  const blocked = loading || busy || !layer?.writable

  const onInvalid = useCallback((key: string, value?: string) => setInvalid((current) => {
    if (current[key] === value) return current
    const next = { ...current }
    if (value) next[key] = value
    else delete next[key]
    return next
  }), [])
  const update = useCallback((path: string[], value: unknown) => {
    setDraft((current) => setConfigValue(current, path, value))
    setMessage(''); setError(''); setConfirmShared(false)
  }, [])
  const install = (next: ClaudeConfigView, selected: ConfigScope) => {
    setView(next); setDraft(structuredClone(next.layers[selected].values))
    setRaw(JSON.stringify(next.layers[selected].values, null, 2)); setInvalid({}); setConfirmShared(false)
  }
  const load = async () => {
    setLoading(true); setError('')
    try { install(await window.api.config.get(sessionId), scope) } catch (err) { setError((err as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let cancelled = false
    window.api.config.get(sessionId).then((next) => { if (!cancelled) install(next, 'chat') }).catch((err) => { if (!cancelled) setError((err as Error).message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId])

  const perform = (action: LeaveAction) => {
    setLeave(null)
    if (action === 'close') onClose()
    else if (action === 'app') openSettings('claude')
    else if (action === 'reload') void load()
    else if (view) {
      setScope(action); install(view, action); setError(''); setMessage('')
    }
  }
  const request = (action: LeaveAction) => {
    if (busy || loading) return
    if (dirty) setLeave(action)
    else perform(action)
  }
  const save = async () => {
    if (!layer || errors.length || blocked) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await window.api.config.save(sessionId, { scope, values: draft, revision: layer.revision, confirmShared })
      install(result.view, scope); setMessage(result.message)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  const entries = useMemo(() => {
    const query = search.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return Object.entries(SETTINGS).filter(([key, schema]) =>
      (category === 'All settings' || settingCategory(key) === category) && (!onlySet || Object.hasOwn(draft, key)) &&
      query.every((word) => `${key} ${settingTitle(key)} ${schema.description ?? ''} ${settingCategory(key)}`.toLowerCase().includes(word))
    ).sort(([a], [b]) => (PRIORITY.includes(a) ? PRIORITY.indexOf(a) : 100) - (PRIORITY.includes(b) ? PRIORITY.indexOf(b) : 100) || a.localeCompare(b))
  }, [search, category, onlySet, draft])
  const unknown = Object.keys(draft).filter((k) => !Object.hasOwn(SETTINGS, k))

  return (
    <Modal title="Chat settings" width={1040} tall onClose={() => request('close')}>
      <div className="config-editor">
        <div className="config-heading"><SlidersHorizontal size={16} /><b className="ellipsis">{title}</b><span className="spacer" />
          <button className="btn sm" onClick={() => request('app')} data-tip="Open ClaudeGUI’s own preferences: appearance, defaults, providers and other app settings"><Settings size={13} /> App settings</button>
          <button className="btn sm" onClick={() => request('reload')} disabled={busy || loading} data-tip="Read settings again; ask before discarding unsaved edits"><RefreshCw size={13} /> Reload</button>
        </div>
        <div className="config-scope-row">
          <label htmlFor="config-scope">Save changes to</label>
          <select id="config-scope" className="select" aria-label="Configuration scope" value={scope} disabled={busy || loading} onChange={(e) => request(e.target.value as ConfigScope)}>
            {CONFIG_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <span className="faint">{Object.keys(SETTINGS).length} supported settings · SDK {SETTINGS_SDK_VERSION}</span>
        </div>
        <div className="config-scope-info">
          <div>{CONFIG_SCOPES.find((s) => s.value === scope)!.hint}</div>
          {layer?.path && <code className="config-file">{layer.path}</code>}
          <div className="faint">Reset removes a setting from this scope; startup overrides may require the chat’s next process start to fully inherit. Administrator policy takes precedence. Secret values are hidden here but remain in local JSON; prefer credential helpers backed by Keychain.</div>
        </div>
        {layer?.warning && <div className="config-warning" role="status"><AlertTriangle size={15} /><span>{layer.warning}</span></div>}
        {configError && <div className="config-error" role="alert">{configError}</div>}
        <div className="config-search-row">
          <Search size={14} />
          <input className="input" aria-label="Search configuration" placeholder="Search every setting and its description…" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check"><input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />Set here only</label>
          <span className="seg">
            <button className={tab === 'controls' ? 'active' : ''} onClick={() => setTab('controls')}>Controls</button>
            <button className={tab === 'json' ? 'active' : ''} onClick={() => { if (!invalid.$json) setRaw(JSON.stringify(draft, null, 2)); setTab('json') }}>JSON</button>
            <button className={tab === 'effective' ? 'active' : ''} onClick={() => setTab('effective')}>Inherited & live</button>
          </span>
        </div>
        <div className="config-content">
          <nav className="settings-nav" aria-label="Setting categories">
            {CONFIG_CATEGORIES.map((c) => <button key={c} className={category === c ? 'active' : ''} onClick={() => { setCategory(c); setTab('controls') }}>{c}</button>)}
          </nav>
          <div className="config-fields" key={`${scope}-${tab}`}>
            {loading && !view ? <div className="faint">Reading configuration…</div> : tab === 'json' ? <>
              <div className="faint">Complete settings for this scope, not the merged configuration. Omit a key to inherit it. Secret placeholders preserve existing values.</div>
              <textarea className="input mono config-full-json" aria-label="Complete configuration JSON" disabled={blocked} spellCheck={false} value={raw} onChange={(e) => {
                setRaw(e.target.value); setMessage(''); setConfirmShared(false)
                try {
                  const value = JSON.parse(e.target.value)
                  if (!isConfigObject(value)) throw new Error()
                  setDraft(value); onInvalid('$json')
                } catch { onInvalid('$json', 'Complete configuration: enter a valid JSON object.') }
              }} />
            </> : tab === 'effective' ? <>
              <h3>Inherited settings</h3><div className="faint">Resolved by Claude Code from the enabled settings files and administrator policy, before this scope’s overrides. Defaults not explicitly stored may be absent.</div>
              <pre className="config-readonly">{JSON.stringify(layer?.inherited ?? {}, null, 2)}</pre>
              <h3>Running Claude Code settings</h3><div className="faint">{view?.live ? 'Reported by this chat’s running process. Secrets are hidden. Some startup-only settings can be saved without changing the running process.' : 'No live settings report is available. Opening this dialog never starts a process or sends a prompt.'}</div>
              {view?.live && <pre className="config-readonly">{JSON.stringify(view.live, null, 2)}</pre>}
            </> : <>
              <div className="config-results faint">{entries.length} settings{search && ` matching “${search}”`}</div>
              {entries.map(([key, declared]) => {
                const schema = key === 'effortLevel' && scope === 'chat' ? { ...declared, enum: [...(declared.enum ?? []), 'max'] } : declared
                const value = draft[key], inherited = layer?.inherited[key]
                const notice = settingNotice(key)
                const idleUnavailable = key === 'idleCompaction' && view?.idleCompactionSupported !== true
                const fieldBlocked = blocked || (scope === 'chat' && idleUnavailable)
                return <section className="config-setting" data-config-key={key} key={key}>
                  <div className="config-setting-head"><label htmlFor={`config-${key}`}>{settingTitle(key)}</label><span className="spacer" />
                    <span className="faint">{Object.hasOwn(draft, key) ? 'Set here' : 'Inherited'}</span>
                    <button className="btn ghost sm config-reset" disabled={fieldBlocked || !Object.hasOwn(draft, key)} data-tip="Remove this setting from this scope and inherit its value" onClick={() => update([key], undefined)}>Reset</button>
                  </div>
                  <code className="config-key">{key}</code>
                  {declared.description && <details className="config-description"><summary>{key === 'idleCompaction' ? 'Native SDK description (terminal behavior)' : declared.description.length > 180 ? declared.description.slice(0, 177) + '…' : declared.description}</summary><p>{declared.description}</p></details>}
                  {notice && <div className="config-setting-notice">{notice}</div>}
                  {view?.managedKeys.includes(key) && <div className="config-setting-notice">Administrator policy also sets this key and may override or restrict this value.</div>}
                  {idleUnavailable && <div className="config-setting-notice" role="status">Idle compaction needs session host 1.0.65 or later. An app update preserves the existing host. Finish running work before fully quitting and reopening; no chat is restarted by this dialog.</div>}
                  <SettingControl path={[key]} schema={schema} value={value} inherited={inherited} onChange={update} onInvalid={onInvalid} disabled={fieldBlocked} />
                  {key === 'idleCompaction' && <>
                    <div className="config-child">
                      <label htmlFor={`config-env.${IDLE_COMPACTION_MIN_TOKENS_ENV}`} data-tip="Minimum context size for idle compaction, stored as a native environment setting in this scope. Default 200,000; values below 100,000 are raised to 100,000.">Minimum context tokens for idle compaction</label>
                      <div className="config-child-input">
                        <SettingControl path={['env', IDLE_COMPACTION_MIN_TOKENS_ENV]} schema={{ type: 'string' }} value={configValueAt(draft, ['env', IDLE_COMPACTION_MIN_TOKENS_ENV])} inherited={configValueAt(layer?.inherited, ['env', IDLE_COMPACTION_MIN_TOKENS_ENV]) ?? '200000'} onChange={update} onInvalid={onInvalid} disabled={fieldBlocked} />
                        <button className="btn ghost sm" disabled={fieldBlocked || configValueAt(draft, ['env', IDLE_COMPACTION_MIN_TOKENS_ENV]) === undefined} onClick={() => update(['env', IDLE_COMPACTION_MIN_TOKENS_ENV], undefined)} data-tip="Remove this scope’s idle-compaction threshold and inherit it">Reset</button>
                      </div>
                      <div className="faint">Default: 200,000 tokens. Claude Code raises lower values to 100,000. Environment and request-setting changes may need a new response before their cache can be used.</div>
                    </div>
                    {!idleUnavailable && <div className="config-setting-notice config-idle-status" role="status">{idleCompaction?.reason ?? 'Eligibility is checked while this chat’s process is idle. No process is started by this dialog.'}{idleCompaction?.nextAt && ` Next eligible check: ${new Date(idleCompaction.nextAt).toLocaleTimeString()}.`}</div>}
                  </>}
                </section>
              })}
              {!entries.length && <div className="faint">No matching settings. Clear the search or choose another category.</div>}
              {unknown.length > 0 && <div className="config-warning">{unknown.length} existing settings are not declared by this SDK. They are preserved; inspect or remove them in JSON.</div>}
            </>}
          </div>
        </div>
        <div className="config-footer">
          {leave ? <div className="config-leave" role="alert"><b>Discard unsaved changes?</b><span className="spacer" /><button className="btn" onClick={() => setLeave(null)}>Keep editing</button><button className="btn danger" onClick={() => perform(leave)}>Discard changes</button></div> : <>
            <div className="config-status" aria-live="polite">
              {error ? <span className="config-error">{error}</span> : errors.length ? <span className="config-error">{errors.slice(0, 3).join('\n')}</span> : message || (configPending ? 'Saved settings are waiting for the current turn to finish.' : dirty ? `${changed} setting${changed === 1 ? '' : 's'} changed — not saved` : 'Changes are saved only when you click Save. No prompt is sent and no process is restarted.')}
            </div>
            {scope !== 'chat' && <label className="check config-confirm"><input type="checkbox" checked={confirmShared} disabled={blocked} onChange={(e) => setConfirmShared(e.target.checked)} />I understand these changes affect other chats{scope === 'project' ? ' and this file may be shared. Do not store secrets here.' : '.'}</label>}
            <div className="actions"><button className="btn" onClick={() => request('close')} disabled={busy || loading}>Close</button><button className="btn primary" disabled={blocked || !dirty || errors.length > 0 || (scope !== 'chat' && !confirmShared)} onClick={() => void save()}>{busy ? 'Saving…' : scope === 'chat' ? 'Save for this chat' : `Save ${CONFIG_SCOPES.find((s) => s.value === scope)!.label.toLowerCase()} settings`}</button></div>
          </>}
        </div>
      </div>
    </Modal>
  )
}
