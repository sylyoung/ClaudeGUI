import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  REDACTED_CONFIG_VALUE, SETTINGS, configPatch, redactConfig, restoreConfigSecrets,
  sessionConfig, sessionRecordForWindow, setConfigValue, startupResets, validateClaudeConfig, type ConfigValues
} from '../src/shared/claudeConfig'
import { ClaudeConfigService, configRevision, readConfigFile, writeConfigFile } from '../src/main/claudeConfig'
import { SessionRuntime, type RuntimeDeps } from '../src/host/sessions/SessionRuntime'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { SessionsStore } from '../src/main/store'
import type { SessionRecord } from '../src/shared/types'

const root = process.env.CONFIGURATION_TEST_ROOT!
assert.ok(root && path.basename(root).startsWith('configuration-tests-'), 'Run through the isolated test script')
function directory(name: string): string { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); return dir }
function record(cwd = directory('project')): SessionRecord {
  return { id: 'configuration-fixture', claudeSessionId: 'configuration-fixture', title: 'Configuration fixture', cwd, permissionMode: 'default', createdAt: 0, lastActiveAt: 0, source: 'gui' }
}
const revision = (values: unknown) => createHash('sha256').update(JSON.stringify(values)).digest('hex')

// Generate coverage from the installed declaration rather than maintaining a handpicked UI list.
test('catalogue includes every native setting and full nested permission controls', () => {
  const declaration = fs.readFileSync(path.join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'), 'utf8')
  const settings = declaration.slice(declaration.indexOf('export declare interface Settings {'))
  const declared = [...settings.slice(0, settings.indexOf('\n}')).matchAll(/^    ([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1])
  assert.deepEqual(Object.keys(SETTINGS).sort(), declared.sort())
  assert.ok(Object.keys(SETTINGS).length > 150)
  assert.equal(SETTINGS.autoCompactEnabled.type, 'boolean')
  assert.ok(SETTINGS.permissions.properties?.defaultMode)
  assert.ok(SETTINGS.hooks.additionalProperties)
})

test('validates types, nested required fields, choices and compaction bounds', () => {
  assert.deepEqual(validateClaudeConfig({ autoCompactEnabled: false, autoCompactWindow: 100000, env: { EXAMPLE: 'value' } }), [])
  assert.ok(validateClaudeConfig({ autoCompactEnabled: 'false' }).length)
  assert.ok(validateClaudeConfig({ autoCompactWindow: 99999 }).length)
  assert.ok(validateClaudeConfig({ autoCompactWindow: 1000001 }).length)
  assert.ok(validateClaudeConfig({ permissions: { defaultMode: 'not-a-mode' } }).length)
  assert.ok(validateClaudeConfig({ hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] } }).length)
  assert.deepEqual(validateClaudeConfig({ effortLevel: 'max' }, {}, true), [])
  assert.ok(validateClaudeConfig({ effortLevel: 'max' }).length)
  assert.ok(validateClaudeConfig(JSON.parse('{"__proto__": {"polluted": true}}')).length)
  assert.ok(validateClaudeConfig({ unknownSetting: true }).length)
  assert.deepEqual(validateClaudeConfig({ unknownSetting: true }, { unknownSetting: true }), [])
})

test('resetting one nested field preserves siblings and removes empty parents', () => {
  const next = setConfigValue({ permissions: { allow: ['Read'], defaultMode: 'plan' } }, ['permissions', 'defaultMode'], undefined)
  assert.deepEqual(next, { permissions: { allow: ['Read'] } })
  assert.deepEqual(setConfigValue(next, ['permissions', 'allow'], undefined), {})
  assert.deepEqual(configPatch({ env: { FIRST: 'one', SECOND: 'two' }, model: 'example' }, { env: { FIRST: 'one' } }), { env: { FIRST: 'one' }, model: null })
})

test('secrets are hidden and unchanged placeholders preserve original values', () => {
  const original = { env: { EXAMPLE_TOKEN: 'synthetic-private-value', EXAMPLE: 'one' }, pluginConfigs: { example: { secret: { value: 'synthetic-private-value' } } } }
  const masked = redactConfig(original)
  assert.equal((masked.env as ConfigValues).EXAMPLE_TOKEN, REDACTED_CONFIG_VALUE)
  assert.ok(!JSON.stringify(masked).includes('synthetic-private-value'))
  const edited = setConfigValue(masked, ['env', 'EXAMPLE'], 'two')
  assert.equal((restoreConfigSecrets(edited, original).env as ConfigValues).EXAMPLE_TOKEN, 'synthetic-private-value')
  assert.throws(() => restoreConfigSecrets({ env: { NEW_TOKEN: REDACTED_CONFIG_VALUE } }, {}))
})

test('atomic settings edits preserve unrelated values, mode and conflict protection', () => {
  const file = path.join(directory('file-edit'), 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ autoCompactEnabled: true, env: { EXAMPLE: 'one' }, legacyKey: { retained: true } }), { mode: 0o600 })
  const first = readConfigFile(file)
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-w', 'com.claudegui.configuration-test', 'fixture', file])
  writeConfigFile(file, { ...first.values, autoCompactEnabled: false }, first.revision)
  if (process.platform === 'darwin') assert.equal(execFileSync('/usr/bin/xattr', ['-p', 'com.claudegui.configuration-test', file], { encoding: 'utf8' }).trim(), 'fixture')
  assert.equal(readConfigFile(file).values.autoCompactEnabled, false)
  assert.deepEqual(readConfigFile(file).values.legacyKey, { retained: true })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.throws(() => writeConfigFile(file, {}, first.revision), /changed elsewhere/)
  const link = path.join(path.dirname(file), 'linked.json')
  fs.symlinkSync(file, link)
  assert.throws(() => readConfigFile(link), /link/)
  fs.writeFileSync(file, '{invalid')
  assert.throws(() => readConfigFile(file), /valid JSON/)
})

test('shared scopes use native inheritance, require confirmation and reject stale revisions', async () => {
  const cwd = directory('scope-project')
  const rec = record(cwd)
  const host = { status: { version: '1.0.64' }, list: async () => ({ records: [rec], live: [] }), claudeConfig: async () => ({ saved: sessionConfig(rec) }), setClaudeConfig: async () => ({ pending: false }) }
  const service = new ClaudeConfigService(host, () => ({ ...DEFAULT_SETTINGS }))
  const view = await service.get(rec.id)
  assert.equal(view.layers.user.path, path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'))
  const request = { scope: 'project' as const, revision: view.layers.project.revision, values: { autoCompactEnabled: false } }
  await assert.rejects(service.save(rec.id, request), /Confirm/)
  const result = await service.save(rec.id, { ...request, confirmShared: true })
  assert.equal(result.view.layers.chat.inherited.autoCompactEnabled, false)
  await assert.rejects(service.save(rec.id, { ...request, confirmShared: true }), /changed elsewhere/)
  assert.equal(fs.existsSync(view.layers.user.path!), false)
  const old = new ClaudeConfigService({ ...host, status: { version: '1.0.63' } }, () => ({ ...DEFAULT_SETTINGS }))
  assert.equal((await old.get(rec.id)).layers.chat.writable, false)
})

test('a missing local-project file uses the owned canonical Git root', async () => {
  const cwd = directory('git-project')
  execFileSync('git', ['init', '--quiet'], { cwd })
  const rec = record(directory('git-project/nested'))
  const service = new ClaudeConfigService({ status: { version: '1.0.64' }, list: async () => ({ records: [rec], live: [] }), claudeConfig: async () => ({ saved: sessionConfig(rec) }), setClaudeConfig: async () => ({ pending: false }) }, () => ({ ...DEFAULT_SETTINGS }))
  assert.equal((await service.get(rec.id)).layers.local.path, path.join(cwd, '.claude', 'settings.local.json'))
})

function runtime(status: 'idle' | 'running' = 'idle') {
  const rec = record(directory('runtime-project'))
  const patches: ConfigValues[] = []
  const saved: SessionRecord[] = []
  let starts = 0
  const deps: RuntimeDeps = {
    getEnv: async () => { starts++; return {} }, launchProvider: async () => { throw new Error('No launcher allowed in this test') }, fastModel: async () => undefined,
    getExecutable: () => undefined, getSettings: () => ({ ...DEFAULT_SETTINGS }), appVersion: '1.0.64',
    onRateLimit: () => {}, emit: () => {}, saveRecord: (r) => saved.push(structuredClone(r)), onTurnFinished: () => {}, onNeedsAttention: () => {}, onExit: () => {}, log: () => {}
  }
  const rt = new SessionRuntime(rec, deps)
  rt.live.status = status
  const native = { applyFlagSettings: async (settings: ConfigValues) => { patches.push(structuredClone(settings)) }, setPermissionMode: async () => {}, getSettings: async () => ({ effective: { autoCompactEnabled: false } }) }
  ;(rt as unknown as { q: unknown }).q = native
  return { rt, native, patches, saved, starts: () => starts }
}

test('chat-only configuration persists and uses native flags without restarting', async () => {
  const { rt, patches, saved, starts } = runtime()
  const original = sessionConfig(rt.record)
  const values = { ...original, autoCompactEnabled: false, autoCompactWindow: 100000 }
  assert.equal((await rt.setClaudeConfig(values, revision(original))).pending, false)
  assert.equal(patches.length, 1)
  assert.equal(patches[0].autoCompactEnabled, false)
  assert.deepEqual(saved.at(-1)?.claudeSettings, values)
  assert.equal(starts(), 0)
  await assert.rejects(rt.setClaudeConfig({}, revision(original)), /changed elsewhere/)
  await rt.setEffort('low')
  assert.equal(rt.record.claudeSettings?.effortLevel, 'low')
})

test('stopped-chat settings update the toolbar state without starting a process', async () => {
  const { rt, starts } = runtime()
  ;(rt as unknown as { q: unknown }).q = null
  const before = sessionConfig(rt.record)
  await rt.setClaudeConfig({ ...before, model: 'example-model', permissions: { defaultMode: 'plan' }, effortLevel: 'low' }, revision(before))
  assert.equal(rt.live.model, 'example-model')
  assert.equal(rt.live.permissionMode, 'plan')
  assert.equal(rt.live.effort, 'low')
  assert.equal(starts(), 0)
})

test('working chats defer native changes until their turn ends', async () => {
  const { rt, patches } = runtime('running')
  const before = sessionConfig(rt.record)
  await rt.setClaudeConfig({ ...before, autoCompactEnabled: false }, revision(before))
  assert.equal(patches.length, 0)
  assert.equal(rt.live.configPending, true)
  rt.live.status = 'idle'
  await (rt as unknown as { applyPendingConfig(): Promise<void> }).applyPendingConfig()
  assert.equal(patches[0].autoCompactEnabled, false)
  assert.equal(rt.live.configPending, false)
})

test('chat overrides survive store reopening and are stored with private file permissions', () => {
  const folder = directory('persisted-records')
  const first = new SessionsStore(folder)
  const rec = record()
  rec.claudeSettings = { autoCompactEnabled: false, autoCompactWindow: 100000, env: { EXAMPLE_TOKEN: 'synthetic-private-value' } }
  first.upsertSession(rec); first.flush()
  const reopened = new SessionsStore(folder)
  assert.deepEqual(sessionConfig(reopened.getSession(rec.id)!), rec.claudeSettings)
  assert.equal(fs.statSync(path.join(folder, 'sessions.json')).mode & 0o777, 0o600)
})

test('resetting startup overrides is explicitly marked as requiring the next process start', async () => {
  assert.deepEqual(startupResets({ env: { FIRST: 'one', SECOND: 'two' } }, { env: { FIRST: 'one' } }), ['env'])
  const { rt } = runtime()
  rt.record.claudeSettings = { autoCompactEnabled: false }
  ;(rt as unknown as { startupConfig: ConfigValues }).startupConfig = { autoCompactEnabled: false }
  const result = await rt.setClaudeConfig({}, revision(sessionConfig(rt.record)))
  assert.deepEqual(result.restartRequired, ['autoCompactEnabled'])
  assert.deepEqual(rt.live.configRestartRequired, ['autoCompactEnabled'])
  assert.deepEqual(rt.record.claudeSettings, {})
})

test('records sent to the window never include saved secret values', () => {
  const rec = record()
  rec.claudeSettings = { env: { EXAMPLE_TOKEN: 'synthetic-private-value' } }
  assert.ok(!JSON.stringify(sessionRecordForWindow(rec)).includes('synthetic-private-value'))
  assert.equal((rec.claudeSettings.env as ConfigValues).EXAMPLE_TOKEN, 'synthetic-private-value')
})

test('missing-file revisions are bound to the original target path', () => {
  assert.notEqual(readConfigFile(path.join(root, 'missing-one.json')).revision, readConfigFile(path.join(root, 'missing-two.json')).revision)
})

test('a new prompt waits for an already-applying deferred configuration', async () => {
  const { rt, native } = runtime('running')
  const before = sessionConfig(rt.record)
  await rt.setClaudeConfig({ ...before, autoCompactEnabled: false }, revision(before))
  let finish: (() => void) | undefined
  native.applyFlagSettings = async () => new Promise<void>((resolve) => { finish = resolve })
  rt.live.status = 'idle'
  const applying = (rt as unknown as { applyPendingConfig(): Promise<void> }).applyPendingConfig()
  let ready = false
  const start = rt.ensureStarted().then(() => { ready = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(ready, false)
  finish!()
  await Promise.all([applying, start])
  assert.equal(ready, true)
})

test('native rejections do not disclose setting values or claim the configuration was saved', async () => {
  const { rt, native, saved } = runtime()
  native.applyFlagSettings = async () => { throw new Error('synthetic-private-value') }
  const before = sessionConfig(rt.record)
  await assert.rejects(rt.setClaudeConfig({ ...before, autoCompactEnabled: false }, revision(before)), (err: Error) => !err.message.includes('synthetic-private-value') && err.message.includes('did not accept'))
  assert.equal(saved.length, 0)
  assert.equal(rt.record.claudeSettings, undefined)
})

test('native CLI accepts compaction flags and top-level object replacement without inference', { timeout: 30000 }, async () => {
  const requests: string[] = []
  const server = http.createServer((req, res) => { requests.push(`${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`); res.writeHead(503); res.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  let end: (() => void) | undefined
  const prompt: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => { end = () => resolve({ done: true, value: undefined }) }) }) }
  let q: Query | undefined
  let consume: Promise<void> | undefined
  try {
    q = query({ prompt, options: {
      cwd: directory('native-cli'), settingSources: [], systemPrompt: 'Local configuration control test; no prompts are sent.',
      settings: { fastMode: false, autoCompactEnabled: false, autoCompactWindow: 100000 },
      env: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    } })
    consume = (async () => { try { for await (const _ of q!) { /* control traffic only */ } } catch { /* close ends the iterator */ } })()
    await q.initializationResult()
    const native = q as Query & { getSettings(): Promise<{ effective: ConfigValues }> }
    const startup = (await native.getSettings()).effective
    assert.equal(startup.autoCompactEnabled, false)
    assert.equal(startup.autoCompactWindow, 100000)
    await q.applyFlagSettings({ autoCompactEnabled: true, autoCompactWindow: 100000, env: { EXAMPLE_FIRST: 'one', EXAMPLE_SECOND: 'two' } })
    let effective = (await native.getSettings()).effective
    assert.equal(effective.autoCompactEnabled, true)
    assert.equal(effective.autoCompactWindow, 100000)
    await q.applyFlagSettings({ env: { EXAMPLE_FIRST: 'one' }, autoCompactEnabled: null })
    effective = (await native.getSettings()).effective
    assert.equal((effective.env as ConfigValues).EXAMPLE_SECOND, undefined)
    // A null dynamic override falls back to --settings at startup; it cannot erase that layer.
    assert.equal(effective.autoCompactEnabled, false)
    assert.deepEqual(requests.filter((r) => r !== 'HEAD /api/hello'), [], 'Only the CLI’s connectivity check may reach the local guard; no inference request is allowed')
  } finally {
    end?.(); q?.close(); await consume
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
