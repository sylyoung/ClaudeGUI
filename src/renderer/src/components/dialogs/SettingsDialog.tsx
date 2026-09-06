import React, { useEffect, useRef, useState } from 'react'
import { Check as CheckIcon, ExternalLink } from 'lucide-react'
import type { AccentColor, AppSettings, Density, DoubleClickAction, EffortLevel, PermissionMode, ResumeOnLaunch, ThemeMode, ThinkingDisplay } from '@shared/types'
import { useStore } from '@/store'
import { Modal } from '../common/Modal'
import { ACCENTS, applyTheme, isDarkTheme } from '@/lib/theme'
import { UsageDetails } from '../status/UsageStatus'
import { UpdatesPanel } from './UpdatesPanel'
import { PermissionsPanel } from './PermissionsPanel'

type Tab = 'general' | 'appearance' | 'claude' | 'files' | 'git' | 'usage' | 'permissions' | 'advanced' | 'about'
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'claude', label: 'Claude' },
  { id: 'files', label: 'Files' },
  { id: 'git', label: 'Git' },
  { id: 'usage', label: 'Usage & status' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'about', label: 'About' }
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {children}
    </div>
  )
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}
function Check({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`check ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  )
}
function Num({ value, onChange, min, max, step, width = 110 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; width?: number }) {
  return <input className="input" type="number" style={{ width }} value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)!
  const appInfo = useStore((s) => s.appInfo)
  const theme = useStore((s) => s.theme)
  const setSettings = useStore((s) => s.setSettings)
  const toast = useStore((s) => s.toast)
  const requestedTab = useStore((s) => s.settingsTab)
  const [tab, setTab] = useState<Tab>(() => requestedTab || (localStorage.getItem('settingsTab') as Tab) || 'general')
  const [draft, setDraft] = useState<AppSettings>({ ...settings })
  const [envInfo, setEnvInfo] = useState<{ count: number; proxy: string[]; path: string } | null>(null)
  const saved = useRef(false)

  useEffect(() => localStorage.setItem('settingsTab', tab), [tab])
  useEffect(() => {
    if (requestedTab) setTab(requestedTab)
  }, [requestedTab])
  useEffect(() => {
    window.api.app.envInfo().then(setEnvInfo).catch(() => setEnvInfo(null))
  }, [])
  // Live preview of the appearance while editing; reverted on cancel.
  useEffect(() => {
    applyTheme({ ...draft, translucentSidebar: settings.translucentSidebar }, theme)
  }, [draft.theme, draft.accent, draft.fontSize, draft.uiFont, draft.codeFont, draft.codeFontSize, draft.density, draft.chatMaxWidth, theme]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      if (!saved.current) {
        const s = useStore.getState()
        if (s.settings) applyTheme(s.settings, s.theme)
      }
    },
    []
  )

  const upd = (patch: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...patch }))
  const save = async () => {
    saved.current = true
    await setSettings(draft)
    onClose()
  }
  const dark = isDarkTheme(draft.theme, theme.systemDark)
  const restart = draft.debugServer !== settings.debugServer || draft.debugPort !== settings.debugPort

  return (
    <Modal title="Settings" onClose={onClose} width={860}>
      <div className="settings">
        <div className="settings-nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {tab === 'general' && (
            <>
              <Section title="Sessions">
                <Field label="Default working directory for new sessions" hint="Pre-filled in the New Session dialog; leave empty to use the most recent folder.">
                  <div className="row">
                    <input className="input" value={draft.defaultCwd} onChange={(e) => upd({ defaultCwd: e.target.value })} placeholder="~/Workspace" spellCheck={false} />
                    <button className="btn" onClick={async () => { const d = await window.api.dialog.chooseDirectory(draft.defaultCwd || undefined); if (d) upd({ defaultCwd: d }) }}>Browse…</button>
                  </div>
                </Field>
                <Field label="Resume sessions on launch" hint="Start the Claude processes automatically when ClaudeGUI opens. Otherwise a session resumes with your first message. 'All' starts at most 12 recent sessions.">
                  <select className="select" value={draft.resumeOnLaunch} onChange={(e) => upd({ resumeOnLaunch: e.target.value as ResumeOnLaunch })}>
                    <option value="none">None (resume on first message)</option>
                    <option value="active">The last active session</option>
                    <option value="pinned">Pinned sessions</option>
                    <option value="all">All non-archived sessions</option>
                  </select>
                </Field>
                <Check label="Enter sends the message (Shift+Enter inserts a newline)" hint="Off: ⌘Enter sends." checked={draft.sendWithEnter} onChange={(v) => upd({ sendWithEnter: v })} />
                <Check label="Ask before quitting while sessions are running" checked={draft.confirmQuit} onChange={(v) => upd({ confirmQuit: v })} />
              </Section>
              <Section title="Notifications">
                <Check label="Show macOS notifications for sessions that are not in front" checked={draft.notifications} onChange={(v) => upd({ notifications: v })} />
                <div className="settings-sub">
                  <Check label="When a turn finishes" checked={draft.notifyOnTurnFinished} disabled={!draft.notifications} onChange={(v) => upd({ notifyOnTurnFinished: v })} />
                  <Check label="When a session needs permission or an answer" checked={draft.notifyOnPermission} disabled={!draft.notifications} onChange={(v) => upd({ notifyOnPermission: v })} />
                  <Check label="When a process exits with an error" checked={draft.notifyOnError} disabled={!draft.notifications} onChange={(v) => upd({ notifyOnError: v })} />
                  <Check label="Play the notification sound" checked={draft.notificationSound} disabled={!draft.notifications} onChange={(v) => upd({ notificationSound: v })} />
                </div>
                <Check label="Show the number of sessions needing attention on the Dock icon" checked={draft.dockBadge} onChange={(v) => upd({ dockBadge: v })} />
              </Section>
            </>
          )}

          {tab === 'appearance' && (
            <>
              <Section title="Theme">
                <div className="seg">
                  {(['system', 'light', 'dark'] as ThemeMode[]).map((t) => (
                    <button key={t} className={draft.theme === t ? 'active' : ''} onClick={() => upd({ theme: t })}>
                      {t === 'system' ? 'Match macOS' : t === 'light' ? 'Light' : 'Dark'}
                    </button>
                  ))}
                </div>
                <Field label="Accent colour" hint="'System' follows the accent colour chosen in macOS System Settings → Appearance.">
                  <div className="swatches">
                    <button className={`swatch ${draft.accent === 'system' ? 'active' : ''}`} style={{ background: theme.accent }} data-tip="System accent" onClick={() => upd({ accent: 'system' })}>
                      {draft.accent === 'system' && <CheckIcon size={12} />}
                    </button>
                    {(Object.keys(ACCENTS) as Exclude<AccentColor, 'system'>[]).map((k) => (
                      <button key={k} className={`swatch ${draft.accent === k ? 'active' : ''}`} style={{ background: dark ? ACCENTS[k].dark : ACCENTS[k].light }} data-tip={ACCENTS[k].label} onClick={() => upd({ accent: k })}>
                        {draft.accent === k && <CheckIcon size={12} />}
                      </button>
                    ))}
                    <span className="faint" style={{ alignSelf: 'center', fontSize: 12 }}>{draft.accent === 'system' ? 'System' : ACCENTS[draft.accent]?.label}</span>
                  </div>
                </Field>
                <Check label="Translucent sidebar (macOS vibrancy)" hint="Lets the desktop shimmer through the sidebar like Finder. Applied when you save." checked={draft.translucentSidebar} onChange={(v) => upd({ translucentSidebar: v })} />
              </Section>
              <Section title="Text">
                <div className="grid2">
                  <Field label="Interface font size (px)"><Num value={draft.fontSize} min={11} max={20} onChange={(v) => upd({ fontSize: v })} /></Field>
                  <Field label="Code font size (px)"><Num value={draft.codeFontSize} min={9} max={20} step={0.5} onChange={(v) => upd({ codeFontSize: v })} /></Field>
                  <Field label="Interface font family"><input className="input" value={draft.uiFont} onChange={(e) => upd({ uiFont: e.target.value })} placeholder="system default (SF Pro)" spellCheck={false} /></Field>
                  <Field label="Code font family"><input className="input" value={draft.codeFont} onChange={(e) => upd({ codeFont: e.target.value })} placeholder="SF Mono, Menlo, monospace" spellCheck={false} /></Field>
                  <Field label="Density">
                    <select className="select" value={draft.density} onChange={(e) => upd({ density: e.target.value as Density })}>
                      <option value="comfortable">Comfortable</option>
                      <option value="compact">Compact</option>
                    </select>
                  </Field>
                  <Field label="Chat column max width (px)"><Num value={draft.chatMaxWidth} min={600} max={2400} step={20} onChange={(v) => upd({ chatMaxWidth: v })} /></Field>
                </div>
              </Section>
              <Section title="Chat & sidebar">
                <Check label="Show timestamps on messages" checked={draft.showTimestamps} onChange={(v) => upd({ showTimestamps: v })} />
                <Field label="Thinking blocks">
                  <select className="select" value={draft.thinkingDisplay} onChange={(e) => upd({ thinkingDisplay: e.target.value as ThinkingDisplay })}>
                    <option value="collapsed">Collapsed (click to expand)</option>
                    <option value="expanded">Expanded</option>
                    <option value="hidden">Hidden</option>
                  </select>
                </Field>
                <Check label="Expand every tool call card by default" hint="Off: only edits, writes, subagents and questions start expanded." checked={draft.toolCardsExpanded} onChange={(v) => upd({ toolCardsExpanded: v })} />
                <Check label="Status board above the chat" hint="One chip per session with its colour-coded state and task counts. ⌘⇧S toggles it." checked={draft.showStatusBoard} onChange={(v) => upd({ showStatusBoard: v })} />
                <Check label="Hover explanations (tooltips)" hint="Explain buttons, indicators and options when the mouse rests on them." checked={draft.showTooltips} onChange={(v) => upd({ showTooltips: v })} />
                <Check label="Folder header rows inside groups" hint="Off (default): each row shows its folder name inline. On: sessions are additionally grouped under their project folder." checked={draft.groupSessionsByFolder} onChange={(v) => upd({ groupSessionsByFolder: v })} />
              </Section>
            </>
          )}

          {tab === 'claude' && (
            <>
              <Section title="Claude Code">
                <Field label={`Claude executable (empty = SDK-bundled binary, v${appInfo?.sdkVersion})`} hint="Settings, skills, hooks and MCP servers from ~/.claude are used either way. Applies to newly started processes.">
                  <input className="input" value={draft.claudeExecutable} onChange={(e) => upd({ claudeExecutable: e.target.value })} placeholder={appInfo?.claudeExecutable} spellCheck={false} />
                </Field>
                <div className="grid2">
                  <Field label="Default model for new sessions">
                    <input className="input" value={draft.defaultModel} onChange={(e) => upd({ defaultModel: e.target.value })} placeholder="(use settings.json model)" spellCheck={false} list="model-ids" />
                    <datalist id="model-ids">
                      {['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'].map((m) => <option key={m} value={m} />)}
                    </datalist>
                  </Field>
                  <Field label="Default permission mode">
                    <select className="select" value={draft.defaultPermissionMode} onChange={(e) => upd({ defaultPermissionMode: e.target.value as PermissionMode })}>
                      {['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label="Default effort">
                    <select className="select" value={draft.defaultEffort} onChange={(e) => upd({ defaultEffort: e.target.value as EffortLevel | '' })}>
                      {['', 'low', 'medium', 'high', 'xhigh', 'max'].map((m) => <option key={m} value={m}>{m || 'default'}</option>)}
                    </select>
                  </Field>
                  <Field label="Max turns per message (0 = unlimited)"><Num value={draft.maxTurns} min={0} onChange={(v) => upd({ maxTurns: v })} /></Field>
                  <Field label="Max thinking tokens (0 = model default)"><Num value={draft.maxThinkingTokens} min={0} step={1000} onChange={(v) => upd({ maxThinkingTokens: v })} /></Field>
                </div>
                <Check label="Let Claude Code name new sessions automatically" checked={draft.autoTitle} onChange={(v) => upd({ autoTitle: v })} />
              </Section>
              <Section title="Tools & settings sources">
                <div className="grid2">
                  <Field label="Always-allowed tools" hint="Comma or newline separated, e.g. Read, Grep, Bash(git *). These never prompt.">
                    <textarea className="input" rows={3} value={draft.allowedTools} onChange={(e) => upd({ allowedTools: e.target.value })} spellCheck={false} />
                  </Field>
                  <Field label="Disallowed tools" hint="Tools Claude may not use at all, e.g. WebSearch.">
                    <textarea className="input" rows={3} value={draft.disallowedTools} onChange={(e) => upd({ disallowedTools: e.target.value })} spellCheck={false} />
                  </Field>
                </div>
                <Check label="Load project settings (.claude/settings.json, CLAUDE.md in the project)" checked={draft.useProjectSettings} onChange={(v) => upd({ useProjectSettings: v })} />
                <Check label="Load local settings (.claude/settings.local.json)" checked={draft.useLocalSettings} onChange={(v) => upd({ useLocalSettings: v })} />
              </Section>
              <Section title="Environment">
                <Field label="Extra environment variables for Claude processes (one KEY=VALUE per line)" hint="Applied on top of the environment captured from your shell's `claude` command (proxies, API settings…).">
                  <textarea className="input" rows={3} value={draft.extraEnv} onChange={(e) => upd({ extraEnv: e.target.value })} placeholder={'HTTPS_PROXY=http://127.0.0.1:PORT\nANTHROPIC_MODEL=…'} spellCheck={false} />
                </Field>
                <div className="faint" style={{ fontSize: 11.5 }}>
                  Captured from your login shell via the `claude` wrapper: {envInfo ? `${envInfo.count} variables` : '…'}
                  {envInfo?.proxy.length ? ` · proxy: ${envInfo.proxy.join(', ')}` : envInfo ? ' · no proxy variables detected' : ''}{' '}
                  <button className="btn ghost sm" onClick={async () => { await window.api.app.reloadEnv(); setEnvInfo(await window.api.app.envInfo()); toast('Environment reloaded', 'success') }}>reload</button>
                </div>
              </Section>
            </>
          )}

          {tab === 'files' && (
            <>
              <Section title="Opening files">
                <Check label="Open non-text files (Word, PDF, spreadsheets…) with their default macOS app" hint="Text and images open in the built-in viewer; everything else goes to the app Finder would use." checked={draft.openBinaryWithSystemApp} onChange={(v) => upd({ openBinaryWithSystemApp: v })} />
                <Field label="Double-click on a file">
                  <select className="select" value={draft.doubleClickAction} onChange={(e) => upd({ doubleClickAction: e.target.value as DoubleClickAction })}>
                    <option value="system">Open with the default macOS app</option>
                    <option value="editor">Open in the editor below</option>
                    <option value="viewer">Open in the built-in viewer</option>
                  </select>
                </Field>
                <Field label="Editor command for 'open in editor' ({path} and {line} placeholders)" hint="Also used by ⌘-click / ⌥-click on files and links.">
                  <input className="input" value={draft.editorCommand} onChange={(e) => upd({ editorCommand: e.target.value })} placeholder="subl {path}:{line}" spellCheck={false} />
                </Field>
              </Section>
              <Section title="File tree">
                <Check label="Show hidden files (dotfiles)" checked={draft.showHiddenFiles} onChange={(v) => upd({ showHiddenFiles: v })} />
                <Check label="Show file sizes" checked={draft.showFileSizes} onChange={(v) => upd({ showFileSizes: v })} />
                <Check label="Reveal files right after Claude edits them" checked={draft.autoRevealEditedFiles} onChange={(v) => upd({ autoRevealEditedFiles: v })} />
                <Field label="Hide these names (comma separated; *.ext and prefix* patterns allowed)">
                  <input className="input" value={draft.excludePatterns} onChange={(e) => upd({ excludePatterns: e.target.value })} placeholder="node_modules, .git, *.pyc" spellCheck={false} />
                </Field>
                <Field label="Maximum text preview size (KB)"><Num value={draft.maxPreviewKB} min={64} max={50000} step={100} onChange={(v) => upd({ maxPreviewKB: v })} /></Field>
              </Section>
            </>
          )}

          {tab === 'git' && (
            <>
              <Section title="Git integration">
                <Check label="Enable the Git panel and status badges" checked={draft.gitEnabled} onChange={(v) => upd({ gitEnabled: v })} />
                <Check label="Show git status badges in the file tree (M, A, D, U…)" checked={draft.gitShowStatusInTree} disabled={!draft.gitEnabled} onChange={(v) => upd({ gitShowStatusInTree: v })} />
                <div className="grid2">
                  <Field label="Re-check status every (seconds, 0 = only on changes)"><Num value={draft.gitAutoRefreshSeconds} min={0} max={600} onChange={(v) => upd({ gitAutoRefreshSeconds: v })} /></Field>
                  <Field label="Fetch from the remote every (minutes, 0 = never)" hint="Keeps the ahead/behind counters current."><Num value={draft.gitAutoFetchMinutes} min={0} max={1440} onChange={(v) => upd({ gitAutoFetchMinutes: v })} /></Field>
                </div>
              </Section>
              <Section title="Commits">
                <Check label="⌘⏎ in the commit box commits and pushes" checked={draft.gitPushAfterCommit} onChange={(v) => upd({ gitPushAfterCommit: v })} />
                <Check label="Add a Signed-off-by trailer (git commit --signoff)" checked={draft.gitSignOff} onChange={(v) => upd({ gitSignOff: v })} />
                <Field label="Commit message template" hint="Pre-filled in the commit box.">
                  <textarea className="input" rows={2} value={draft.gitCommitTemplate} onChange={(e) => upd({ gitCommitTemplate: e.target.value })} spellCheck={false} />
                </Field>
              </Section>
            </>
          )}

          {tab === 'usage' && (
            <>
              <Section title="Plan usage limits (top-right corner)">
                <Check label="Show the session / weekly / per-model limits in the top-right corner" checked={draft.showUsageStatus} onChange={(v) => upd({ showUsageStatus: v })} />
                <div className="grid2">
                  <Field label="Check the limits every (minutes)" hint="They also refresh after every finished turn (at most every 20 s) and from every API response."><Num value={draft.usageRefreshMinutes} min={1} max={120} onChange={(v) => upd({ usageRefreshMinutes: v })} /></Field>
                  <Field label="Turn a limit amber from (%)"><Num value={draft.usageWarnPercent} min={10} max={99} onChange={(v) => upd({ usageWarnPercent: v })} /></Field>
                </div>
              </Section>
              <Section title="Session indicators">
                <Check label="Show the context-window percentage on each session in the sidebar" checked={draft.showContextInSidebar} onChange={(v) => upd({ showContextInSidebar: v })} />
                <Check label="Show background-task and subagent counts on each session in the sidebar" checked={draft.showTaskCountsInSidebar} onChange={(v) => upd({ showTaskCountsInSidebar: v })} />
              </Section>
              <Section title="Current limits">
                <div className="settings-embed">
                  <UsageDetails />
                </div>
              </Section>
            </>
          )}

          {tab === 'advanced' && (
            <>
              <Section title="Transcript">
                <Field label="Truncate tool results longer than (characters)" hint="Long outputs are cut in the middle to keep the chat responsive. Applies to newly received results."><Num value={draft.toolResultMaxChars} min={2000} max={2000000} step={10000} width={160} onChange={(v) => upd({ toolResultMaxChars: v })} /></Field>
              </Section>
              <Section title="Debugging">
                <Check label="Start the local debug HTTP server (127.0.0.1) used by scripts/devctl.sh" hint="Only for development; restart required." checked={draft.debugServer} onChange={(v) => upd({ debugServer: v })} />
                <Field label="Debug server port"><Num value={draft.debugPort} min={1024} max={65535} onChange={(v) => upd({ debugPort: v })} /></Field>
                {restart && <div className="pill amber">Restart ClaudeGUI to apply the debug server change.</div>}
              </Section>
              <Section title="Data">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => appInfo && window.api.shell.openPath(appInfo.userDataPath)}>Open app data folder</button>
                  <button className="btn sm" onClick={() => appInfo && window.api.shell.showInFolder(`${appInfo.homeDir}/Library/Logs/ClaudeGUI/claudegui.log`)}>Reveal log file</button>
                  <button className="btn sm" onClick={() => appInfo && window.api.shell.openPath(`${appInfo.homeDir}/.claude/projects`)}>Open Claude Code transcripts</button>
                </div>
                <div className="faint" style={{ fontSize: 11.5 }}>Settings and the session list live in {appInfo?.userDataPath}. Transcripts stay in ~/.claude/projects and are shared with the terminal CLI.</div>
              </Section>
            </>
          )}

          {tab === 'about' && (
            <Section title={`ClaudeGUI ${appInfo?.version ?? ''}`}>
              <div className="kv" style={{ fontSize: 12.5 }}>
                <span className="k">Claude Agent SDK</span><span className="v">{appInfo?.sdkVersion}</span>
                <span className="k">Claude executable</span><span className="v">{appInfo?.claudeExecutable || '(bundled)'}</span>
                <span className="k">Electron</span><span className="v">{appInfo?.electron}</span>
                <span className="k">Node</span><span className="v">{appInfo?.node}</span>
                <span className="k">App data</span><span className="v">{appInfo?.userDataPath}</span>
              </div>
              <div style={{ marginTop: 12 }}>
                <button className="btn sm" onClick={() => window.api.shell.openExternal('https://github.com/sylyoung/ClaudeGUI')}>
                  <ExternalLink size={12} /> github.com/sylyoung/ClaudeGUI
                </button>
              </div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 12 }}>
                A local desktop manager for many long-running Claude Code sessions. Every session is a real `claude` process driven through the official Claude Agent SDK.
              </div>
            </Section>
          )}
          {tab === 'permissions' && <PermissionsPanel />}
          {tab === 'about' && <UpdatesPanel draft={draft} upd={upd} />}
        </div>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  )
}
