import './configuration.test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { IDLE_COMPACTION_MIN_TOKENS_ENV, SETTINGS, redactConfig, sessionConfig, validateClaudeConfig, type ConfigValues } from '../src/shared/claudeConfig'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { SessionRecord } from '../src/shared/types'
import { SessionsStore } from '../src/main/store'
import { HostClient } from '../src/main/hostClient'
import { SessionManager, type ManagerHost } from '../src/host/sessions/SessionManager'
import { ClaudeConfigService, configRevision } from '../src/main/claudeConfig'
import { SessionRuntime, type RuntimeDeps } from '../src/host/sessions/SessionRuntime'
import { IDLE_COMPACTION_AFTER_MS, IDLE_COMPACTION_POLL_MS, idleCompactionCache, idleCompactionMinimum, idleCompactionPlan, idleCompactionRequestSettingsChanged, idleCompactionRequestSettingsKey, type IdleCompactionContext } from '../src/host/sessions/idleCompaction'

const root = process.env.CONFIGURATION_TEST_ROOT!
assert.ok(root && path.basename(root).startsWith('configuration-tests-'), 'Run through the isolated test script')
const context: IdleCompactionContext = { busy: false, invalidated: false, fastMode: false, rateLimited: false, lastInteractionAt: 0, contextTokens: 250000 }
const report = (age: string, ttl = '1h') => `Prompt cache (main):   3 requests · no misses · warm (${ttl} TTL, last activity ${age} ago)`

function fixture() {
  const cwd = path.join(root, 'idle-compaction-project')
  fs.mkdirSync(cwd, { recursive: true })
  const record: SessionRecord = {
    id: randomUUID(), claudeSessionId: randomUUID(), title: 'Idle compaction fixture', cwd,
    permissionMode: 'default', createdAt: 1, lastActiveAt: 2, lastPromptAt: 2, source: 'gui',
    lastRecap: 'Fixture recap', lastRecapAt: 3,
    claudeSettings: { idleCompaction: true, fastMode: false }
  }
  let settings: ConfigValues = { idleCompaction: true, autoCompactEnabled: true, fastMode: false }
  let cacheText = report('54m 10s')
  const prompts: SDKUserMessage[] = []
  const controls: string[] = []
  const finished: { silent?: boolean }[] = []
  let starts = 0
  const deps: RuntimeDeps = {
    getEnv: async () => { starts++; throw new Error('No process start is allowed') },
    launchProvider: async () => { throw new Error('No provider launcher is allowed') }, fastModel: async () => undefined,
    getExecutable: () => undefined, getSettings: () => ({ ...DEFAULT_SETTINGS }), appVersion: '1.0.65',
    onRateLimit: () => {}, emit: () => {}, saveRecord: () => {}, onTurnFinished: (_rt, _preview, _error, silent) => { finished.push({ silent }) },
    onNeedsAttention: () => {}, onExit: () => {}, log: () => {}
  }
  const rt = new SessionRuntime(record, deps)
  const native = {
    getSettings: async () => { controls.push('get_settings'); return { effective: settings } },
    request: async (request: { subtype: string }) => { controls.push(request.subtype); return { response: { text: cacheText } } },
    applyFlagSettings: async (patch: ConfigValues) => {
      settings = { ...settings }
      for (const [key, value] of Object.entries(patch)) { if (value === null) delete settings[key]; else settings[key] = value }
    },
    setPermissionMode: async () => {}, setModel: async () => {},
    getContextUsage: async () => ({ totalTokens: rt.live.contextTokens ?? 0, maxTokens: 1000000, percentage: 25, categories: [] })
  }
  const internal = rt as unknown as {
    q: unknown; queue: unknown; historyLoaded: boolean; idleCompactionInvalidated: boolean; lastTurnEndedAt: number; lastAssistantText: string
    handle(msg: SDKMessage): void
  }
  internal.q = native
  internal.queue = { size: 0, push: (m: SDKUserMessage) => prompts.push(m), end: () => {} }
  internal.historyLoaded = true
  internal.idleCompactionInvalidated = false
  internal.lastTurnEndedAt = 4
  internal.lastAssistantText = 'Fixture reply'
  rt.live.status = 'idle'
  rt.live.processAlive = true
  rt.live.contextTokens = 250000
  rt.live.lastPreview = 'Fixture reply'
  rt.live.lastRecap = 'Fixture recap'
  rt.live.unread = 3
  rt.live.slashCommands = [{ name: 'compact', description: 'Compact conversation', argumentHint: '' }]
  const handle = (msg: unknown) => internal.handle(msg as SDKMessage)
  const result = (extra: Record<string, unknown> = {}) => ({
    type: 'result', subtype: 'success', uuid: randomUUID(), session_id: record.claudeSessionId, is_error: false,
    result: '', duration_ms: 1, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, ...extra
  })
  return { rt, record, native, internal, prompts, controls, finished, handle, result, starts: () => starts, setSettings: (s: ConfigValues) => { settings = s }, setCache: (text: string) => { cacheText = text } }
}

test('idle compaction is a native boolean with explicit GUI scheduling and a nonsecret threshold', () => {
  assert.equal(SETTINGS.idleCompaction.type, 'boolean')
  assert.deepEqual(validateClaudeConfig({ idleCompaction: true, env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000' } }), [])
  assert.ok(validateClaudeConfig({ idleCompaction: 'true' }).length)
  for (const value of ['0', '-1', '1.5', 'invalid']) assert.ok(validateClaudeConfig({ env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: value } }).length)
  const masked = redactConfig({ env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000', EXAMPLE_TOKEN: 'synthetic-private-value' } })
  assert.equal((masked.env as ConfigValues)[IDLE_COMPACTION_MIN_TOKENS_ENV], '150000')
  assert.ok(!JSON.stringify(masked).includes('synthetic-private-value'))
  assert.ok(!JSON.stringify(redactConfig({ env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: 'synthetic-private-value' } })).includes('synthetic-private-value'))
  const legacy = { env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: 'invalid', EXAMPLE: 'first' } }
  assert.deepEqual(validateClaudeConfig({ env: { ...legacy.env, EXAMPLE: 'second' } }, legacy), [])
})

test('cache eligibility comes from the native warm one-hour report, not the configured TTL', () => {
  const now = 10_000_000
  assert.deepEqual(idleCompactionCache(report('10m 2s'), now), { activityAt: now - 602000 - 1000, expiresAt: now - 602000 - 1000 + 3600000 })
  assert.ok(idleCompactionCache(report('0s'), now))
  for (const text of ['', report('1s', '5m'), report('1s').replace('warm', 'cold'), report('60m 0s'), report('unknown'), 'Prompt cache (main): no prompt caching reported by the API']) assert.equal(idleCompactionCache(text, now), null)
})

test('idle compaction is opt-in and respects native compaction disable settings', () => {
  const now = 10_000_000
  const cache = { activityAt: now - IDLE_COMPACTION_AFTER_MS, expiresAt: now + 360000 }
  for (const settings of [{}, { idleCompaction: false }]) assert.equal(idleCompactionPlan(settings, {}, cache, context, now).status, 'off')
  assert.equal(idleCompactionPlan({ idleCompaction: true, autoCompactEnabled: false }, {}, cache, context, now).status, 'waiting')
  for (const key of ['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT']) {
    assert.equal(idleCompactionPlan({ idleCompaction: true }, { [key]: '1' }, cache, context, now).status, 'waiting')
    assert.equal(idleCompactionPlan({ idleCompaction: true, env: { [key]: 'true' } }, {}, cache, context, now).status, 'waiting')
    assert.equal(idleCompactionPlan({ idleCompaction: true, env: { [key]: '0' } }, { [key]: '1' }, cache, context, now).status, 'waiting')
  }
})

test('idle minimum defaults to 200000 and follows the native 100000-token floor', () => {
  assert.equal(idleCompactionMinimum({}, {}), 200000)
  assert.equal(idleCompactionMinimum({}, { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000' }), 150000)
  assert.equal(idleCompactionMinimum({ env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '50000' } }, {}), 100000)
  assert.equal(idleCompactionMinimum({ env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '250000' } }, { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000' }), 250000)
  assert.equal(idleCompactionMinimum({}, { [IDLE_COMPACTION_MIN_TOKENS_ENV]: 'not-a-number' }), 200000)
})

test('idle scheduling uses the 54-minute cache window and refuses late wakeups', () => {
  const now = 10_000_000
  const settings = { idleCompaction: true }
  const cache = { activityAt: now - IDLE_COMPACTION_AFTER_MS + 10000, expiresAt: now + 370000 }
  assert.equal(idleCompactionPlan(settings, {}, cache, context, now).status, 'scheduled')
  assert.equal(idleCompactionPlan(settings, {}, cache, context, now).nextAt, now + 10000)
  assert.equal(idleCompactionPlan(settings, {}, cache, context, now + 10000).status, 'ready')
  assert.equal(idleCompactionPlan(settings, {}, cache, context, now + 70001).status, 'skipped')
  assert.equal(idleCompactionPlan(settings, {}, cache, context, cache.expiresAt).status, 'waiting')
  assert.equal(idleCompactionPlan(settings, {}, null, context, now).status, 'waiting')
})

test('busy chats, recent presence, invalidated requests, fast mode and limits do not compact', () => {
  const now = 10_000_000
  const cache = { activityAt: now - IDLE_COMPACTION_AFTER_MS, expiresAt: now + 360000 }
  for (const patch of [{ busy: true }, { invalidated: true }, { fastMode: true }, { rateLimited: true }, { lastInteractionAt: now - 1000 }, { contextTokens: 199999 }]) {
    assert.equal(idleCompactionPlan({ idleCompaction: true }, {}, cache, { ...context, ...patch }, now).status, 'waiting')
  }
})

test('idle-only edits preserve a cache while request-setting changes invalidate it', () => {
  assert.equal(idleCompactionRequestSettingsChanged({}, { idleCompaction: true }), false)
  assert.equal(idleCompactionRequestSettingsChanged({ env: { EXAMPLE: 'value' } }, { idleCompaction: true, env: { EXAMPLE: 'value', [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000' } }), false)
  assert.equal(idleCompactionRequestSettingsChanged({}, { env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000' } }), false)
  assert.equal(idleCompactionRequestSettingsChanged({ model: 'fixture-first' }, { model: 'fixture-second' }), true)
  assert.equal(idleCompactionRequestSettingsChanged({ env: { EXAMPLE: 'first' } }, { env: { EXAMPLE: 'second' } }), true)
})

test('request digests ignore only idle controls and object ordering, not model or environment changes', () => {
  const first = { model: 'fixture-model', env: { EXAMPLE: 'first' } }
  const reordered = { env: { EXAMPLE: 'first', [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000' }, idleCompaction: true, model: 'fixture-model' }
  assert.equal(idleCompactionRequestSettingsKey(first), idleCompactionRequestSettingsKey(reordered))
  assert.notEqual(idleCompactionRequestSettingsKey(first), idleCompactionRequestSettingsKey({ ...first, model: 'fixture-other' }))
  assert.notEqual(idleCompactionRequestSettingsKey(first), idleCompactionRequestSettingsKey({ ...first, env: { EXAMPLE: 'second' } }))
})

test('a shared request-setting change invalidates an otherwise warm idle cache', async () => {
  const f = fixture()
  f.setCache(report('1s'))
  await f.rt.checkIdleCompaction()
  assert.equal(f.rt.live.idleCompaction?.status, 'scheduled')
  f.setSettings({ idleCompaction: true, autoCompactEnabled: true, fastMode: false, model: 'fixture-other' })
  f.setCache(report('54m 10s'))
  await f.rt.checkIdleCompaction()
  assert.equal(f.prompts.length, 0)
  assert.equal(f.rt.live.idleCompaction?.status, 'waiting')
  assert.ok(f.rt.live.idleCompaction?.reason.includes('settings changed'))
})

test('an eligible idle chat queues only the native compact command without restarting or marking it read', async () => {
  const f = fixture()
  await f.rt.checkIdleCompaction()
  assert.deepEqual(f.controls, ['get_settings', 'get_session_cost'])
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0].message.content, '/compact')
  assert.equal(f.prompts[0].isSynthetic, true)
  assert.equal(f.rt.live.idleCompaction?.status, 'compacting')
  assert.equal(f.rt.live.unread, 3)
  assert.equal(f.record.lastPromptAt, 2)
  assert.equal(f.rt.live.lastPreview, 'Fixture reply')
  assert.equal(f.starts(), 0)
  assert.equal(f.internal.q, f.native)
  await f.rt.checkIdleCompaction()
  assert.equal(f.prompts.length, 1)
})

test('automatic compact completion preserves recap, last-prompt order and unread state', async () => {
  const f = fixture()
  await f.rt.checkIdleCompaction()
  const id = f.prompts[0].uuid
  f.handle({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), session_id: f.record.claudeSessionId, compact_metadata: { trigger: 'manual', pre_tokens: 250000 } })
  f.handle(f.result({ user_message_uuids: [id] }))
  assert.equal(f.rt.live.idleCompaction?.status, 'completed')
  assert.equal(f.rt.live.unread, 3)
  assert.equal(f.record.lastPromptAt, 2)
  assert.equal(f.record.lastActiveAt, 2)
  assert.equal(f.rt.live.lastPreview, 'Fixture reply')
  assert.equal(f.rt.live.lastRecap, 'Fixture recap')
  assert.equal(f.record.lastRecap, 'Fixture recap')
  assert.equal(f.rt.lastTurnEnd, 4)
  assert.equal(f.finished.at(-1)?.silent, true)
  assert.ok(f.rt.transcript.messages.some((m) => m.kind === 'system' && m.text.includes('Compacted while idle')))
  await f.rt.checkIdleCompaction()
  assert.equal(f.prompts.length, 1)
})

test('an automatic compact result does not replace the preview of a follow-up waiting behind it', async () => {
  const f = fixture()
  await f.rt.checkIdleCompaction()
  const id = f.prompts[0].uuid
  await f.rt.send('Fixture follow-up')
  f.handle({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), session_id: f.record.claudeSessionId, compact_metadata: { trigger: 'manual', pre_tokens: 250000 } })
  f.handle(f.result({ user_message_uuids: [id] }))
  assert.equal(f.rt.live.lastPreview, 'Fixture follow-up')
  assert.notEqual(f.record.lastPromptAt, 2)
  assert.equal(f.finished.at(-1)?.silent, true)
})

test('a real answer folded into the compact turn is not hidden as housekeeping', async () => {
  const f = fixture()
  await f.rt.checkIdleCompaction()
  const compactId = f.prompts[0].uuid
  const promptId = await f.rt.send('Fixture follow-up')
  f.handle({ type: 'assistant', parent_tool_use_id: null, uuid: randomUUID(), message: { id: 'fixture-answer', model: 'fixture-model', content: [{ type: 'text', text: 'Fixture answer' }], usage: { input_tokens: 100, output_tokens: 20 } }, user_message_uuids: [promptId] })
  f.handle(f.result({ user_message_uuids: [compactId, promptId], result: 'Fixture answer' }))
  assert.equal(f.rt.live.lastPreview, 'Fixture answer')
  assert.equal(f.finished.at(-1)?.silent, false)
})

test('an incoming prompt during the native cache check prevents automatic queueing', async () => {
  const f = fixture()
  let release: (() => void) | undefined
  f.native.request = async () => new Promise((resolve) => { release = () => resolve({ response: { text: report('54m 10s') } }) })
  const checking = f.rt.checkIdleCompaction()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(release)
  await f.rt.send('Fixture follow-up')
  release!()
  await checking
  assert.deepEqual(f.prompts.map((m) => m.message.content), ['Fixture follow-up'])
})

test('trusted user activity or process replacement invalidates an in-flight native settings read', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => f.rt.noteUserActivity(), (f: ReturnType<typeof fixture>) => { f.internal.q = null }]) {
    const f = fixture()
    let release: (() => void) | undefined
    f.native.getSettings = async () => new Promise((resolve) => { release = () => resolve({ effective: { idleCompaction: true } }) })
    const checking = f.rt.checkIdleCompaction()
    change(f)
    release!()
    await checking
    assert.equal(f.prompts.length, 0)
  }
})

test('disabling idle compaction during a pending native check cannot start compaction', async () => {
  const f = fixture()
  let release: (() => void) | undefined
  f.native.request = async () => new Promise((resolve) => { release = () => resolve({ response: { text: report('54m 10s') } }) })
  const checking = f.rt.checkIdleCompaction()
  await new Promise((resolve) => setImmediate(resolve))
  const before = sessionConfig(f.record)
  await f.rt.setClaudeConfig({ ...before, idleCompaction: false }, configRevision(before))
  release!()
  await checking
  assert.equal(f.prompts.length, 0)
})

test('busy runtime states, native warnings and fast models never enqueue automatic compaction', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => { f.rt.live.status = 'running' },
    (f) => { f.rt.live.queuedCount = 1 },
    (f) => { f.rt.live.pendingPermissions = [{} as never] },
    (f) => { f.rt.live.backgroundTasks = [{ taskId: 'fixture-task', taskType: 'shell', description: 'Fixture task', status: 'running' }] },
    (f) => { f.rt.live.activeTools = [{} as never] },
    (f) => { f.rt.live.runningShellIds = ['fixture-shell'] },
    (f) => { f.rt.live.rateLimit = { status: 'allowed_warning' } },
    (f) => { f.record.fastMode = true },
    (f) => { f.rt.live.contextTokens = 150000 },
    (f) => { f.internal.idleCompactionInvalidated = true }
  ]
  for (const change of changes) {
    const f = fixture()
    change(f)
    await f.rt.checkIdleCompaction()
    assert.equal(f.prompts.length, 0)
  }
})

test('a busy chat clears a previously scheduled eligibility time without reading native controls', async () => {
  const f = fixture()
  f.rt.live.idleCompaction = { status: 'scheduled', reason: 'Fixture schedule', nextAt: 1000000 }
  f.rt.live.status = 'running'
  await f.rt.checkIdleCompaction()
  assert.equal(f.rt.live.idleCompaction?.status, 'waiting')
  assert.equal(f.rt.live.idleCompaction?.nextAt, undefined)
  assert.equal(f.controls.length, 0)
  assert.equal(f.prompts.length, 0)
})

test('cold, five-minute and unrecognized native cache reports fail closed', async () => {
  for (const text of [report('1s', '5m'), 'Prompt cache (main): cold', 'Unrecognized report']) {
    const f = fixture()
    f.setCache(text)
    await f.rt.checkIdleCompaction()
    assert.equal(f.prompts.length, 0)
    assert.equal(f.rt.live.idleCompaction?.status, 'waiting')
  }
  const f = fixture()
  f.native.request = async () => { throw new Error('synthetic-private-value') }
  await f.rt.checkIdleCompaction()
  assert.equal(f.prompts.length, 0)
  assert.equal(f.rt.live.idleCompaction?.status, 'unsupported')
  assert.ok(!JSON.stringify(f.rt.live).includes('synthetic-private-value'))
})

test('a failed compact is not retried on the same cache window', async () => {
  const f = fixture()
  await f.rt.checkIdleCompaction()
  f.handle(f.result({ is_error: true, subtype: 'error_during_execution', user_message_uuids: [f.prompts[0].uuid] }))
  assert.equal(f.rt.live.idleCompaction?.status, 'failed')
  await f.rt.checkIdleCompaction()
  assert.equal(f.prompts.length, 1)
  assert.equal(f.finished.at(-1)?.silent, true)
})

test('idle configuration supports inheritance and refuses unsupported old hosts before saving', async () => {
  const f = fixture()
  const host = { status: { version: '1.0.65' }, list: async () => ({ records: [f.record], live: [f.rt.live] }), claudeConfig: async () => ({ saved: sessionConfig(f.record) }), setClaudeConfig: async () => ({ pending: false }) }
  const service = new ClaudeConfigService(host, () => ({ ...DEFAULT_SETTINGS }))
  const before = await service.get(f.record.id)
  assert.equal(before.idleCompactionSupported, true)
  const saved = await service.save(f.record.id, { scope: 'project', values: { idleCompaction: true, env: { [IDLE_COMPACTION_MIN_TOKENS_ENV]: '150000' } }, revision: before.layers.project.revision, confirmShared: true })
  assert.equal(saved.view.layers.chat.inherited.idleCompaction, true)
  assert.equal((saved.view.layers.chat.inherited.env as ConfigValues)[IDLE_COMPACTION_MIN_TOKENS_ENV], '150000')
  const old = new ClaudeConfigService({ ...host, status: { version: '1.0.64' } }, () => ({ ...DEFAULT_SETTINGS }))
  const view = await old.get(f.record.id)
  assert.equal(view.idleCompactionSupported, false)
  await assert.rejects(old.save(f.record.id, { scope: 'chat', revision: view.layers.chat.revision, values: { ...view.layers.chat.values, idleCompaction: false } }), /session host 1\.0\.65/)
  assert.equal(f.record.claudeSettings?.idleCompaction, true)
})

test('presence does not connect to a host and never calls unsupported host versions', async () => {
  const client = new HostClient({ userDataPath: root, logFile: path.join(root, 'unused-host.log'), hostScript: '', appVersion: '1.0.65', getSettings: () => ({ ...DEFAULT_SETTINGS }), getExecutable: () => undefined, isFocused: () => true, log: () => {} })
  const calls: string[] = []
  const internal = client as unknown as { sock: unknown; call(method: string): Promise<void> }
  internal.call = async (method) => { calls.push(method) }
  client.status.version = '1.0.65'
  await client.noteUserActivity('fixture')
  assert.deepEqual(calls, [])
  internal.sock = { destroyed: false }
  for (const version of ['1.0.64', 'unknown', undefined]) {
    client.status.version = version
    await client.noteUserActivity('fixture')
    assert.deepEqual(calls, [])
  }
  client.status.version = '1.0.65'
  await client.noteUserActivity('fixture')
  assert.deepEqual(calls, ['noteUserActivity'])
  internal.sock = null
})

test('the session manager polls idle eligibility and clears its timer when stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const store = new SessionsStore(path.join(root, 'idle-manager-store'))
  const f = fixture()
  store.upsertSession(f.record)
  const host: ManagerHost = {
    getEnv: async () => { throw new Error('No start allowed') }, launchProvider: async () => { throw new Error('No launcher allowed') },
    fastModel: async () => undefined, getExecutable: () => undefined, getSettings: () => ({ ...DEFAULT_SETTINGS }), appVersion: '1.0.65',
    broadcast: () => {}, notify: () => {}, isWindowFocused: () => false, updateBadge: () => {}, onRateLimit: () => {}, onTurnFinished: () => {}, log: () => {}
  }
  const manager = new SessionManager(store, host)
  let checks = 0
  manager.get(f.record.id).checkIdleCompaction = async () => { checks++ }
  try {
    t.mock.timers.tick(IDLE_COMPACTION_POLL_MS)
    assert.equal(checks, 1)
    await manager.stopAll()
    t.mock.timers.tick(IDLE_COMPACTION_POLL_MS)
    assert.equal(checks, 1)
  } finally { await manager.stopAll(); store.flush(); t.mock.timers.reset() }
})

test('native idle flag, cache control and synthetic compact command work without inference', { timeout: 30000 }, async (t) => {
  const requests: string[] = []
  const server = http.createServer((req, res) => { requests.push(`${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`); res.writeHead(503); res.end() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const items: SDKUserMessage[] = []
  let waiter: ((value: IteratorResult<SDKUserMessage>) => void) | undefined
  const prompt: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => items.length ? Promise.resolve({ value: items.shift()!, done: false }) : new Promise((resolve) => { waiter = resolve }) }) }
  const messages: SDKMessage[] = []
  let q: Query | undefined
  let consume: Promise<void> | undefined
  let done: (() => void) | undefined
  t.signal.addEventListener('abort', () => done?.(), { once: true })
  try {
    fs.mkdirSync(path.join(root, 'idle-native-cli'), { recursive: true })
    q = query({ prompt, options: {
      cwd: path.join(root, 'idle-native-cli'), settingSources: [], persistSession: false,
      settings: { fastMode: false, idleCompaction: true },
      env: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    } })
    const result = new Promise<void>((resolve) => { done = resolve })
    consume = (async () => { try { for await (const m of q!) { messages.push(m); if (m.type === 'result') done?.() } } catch { /* owned query closing */ } })()
    const init = await q.initializationResult()
    assert.ok(init.commands.some((c) => c.name === 'compact'))
    const native = q as Query & { getSettings(): Promise<{ effective: ConfigValues }>; request(request: { subtype: string }): Promise<{ response?: { text?: string } }> }
    assert.equal((await native.getSettings()).effective.idleCompaction, true)
    const cache = await native.request({ subtype: 'get_session_cost' })
    assert.equal(typeof cache.response?.text, 'string')
    assert.equal(idleCompactionCache(cache.response!.text!, Date.now()), null)
    await q.applyFlagSettings({ idleCompaction: false, fastMode: false })
    assert.equal((await native.getSettings()).effective.idleCompaction, false)
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: '/compact' }, isSynthetic: true, parent_tool_use_id: null, uuid: randomUUID() as never }
    if (waiter) { const deliver = waiter; waiter = undefined; deliver({ value: message, done: false }) } else items.push(message)
    await result
    assert.ok(messages.some((m) => m.type === 'result'))
    assert.deepEqual(requests.filter((r) => r !== 'HEAD /api/hello'), [], 'No inference request may reach even the local guard')
  } finally {
    waiter?.({ done: true, value: undefined as never }); q?.close(); await consume
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('native compaction produces a boundary against a local protocol fixture, without provider inference', { timeout: 30000 }, async (t) => {
  let apiCalls = 0
  const unexpected: string[] = []
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'HEAD' && route === '/api/hello') { res.writeHead(200); res.end(); return }
    if (req.method !== 'POST' || route !== '/v1/messages') { unexpected.push(`${req.method} ${route}`); res.writeHead(503); res.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    apiCalls++
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } }
    const text = 'Fixture response. The fixture task is complete; no files or external services were used.'
    const message = { id: `msg_fixture_${apiCalls}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } })
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
    event('message_stop', { type: 'message_stop' })
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const cwd = path.join(root, 'idle-protocol-fixture')
  fs.mkdirSync(cwd, { recursive: true })
  let waiter: ((value: IteratorResult<SDKUserMessage>) => void) | undefined
  const items: SDKUserMessage[] = []
  const prompt: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => items.length ? Promise.resolve({ value: items.shift()!, done: false }) : new Promise((resolve) => { waiter = resolve }) }) }
  let finished: (() => void) | undefined
  const messages: SDKMessage[] = []
  let q: Query | undefined
  let consume: Promise<void> | undefined
  t.signal.addEventListener('abort', () => finished?.(), { once: true })
  try {
    q = query({ prompt, options: {
      cwd, title: 'Compaction protocol fixture', settingSources: [], persistSession: false, maxTurns: 1,
      settings: { fastMode: false, autoCompactEnabled: false, autoMemoryEnabled: false, promptSuggestionEnabled: false, promptCacheTtl: '1h' },
      env: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    } })
    consume = (async () => { try { for await (const message of q!) { messages.push(message); if (message.type === 'result') finished?.() } } catch { /* owned query closing */ } })()
    await q.initializationResult()
    const send = async (text: string, synthetic = false) => {
      const result = new Promise<void>((resolve) => { finished = resolve })
      const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, isSynthetic: synthetic, parent_tool_use_id: null, uuid: randomUUID() as never }
      if (waiter) { const deliver = waiter; waiter = undefined; deliver({ value: message, done: false }) } else items.push(message)
      await result
      if (t.signal.aborted) throw new Error('Local protocol fixture timed out')
    }
    const native = q as Query & { getSettings(): Promise<{ effective: ConfigValues }>; request(request: { subtype: string }): Promise<{ response?: { text?: string } }> }
    assert.notEqual((await native.getSettings()).effective.idleCompaction, true, 'The native effective report must not silently enable GUI scheduling by default')
    for (const text of ['Fixture first turn', 'Fixture second turn', 'Fixture third turn']) await send(text)
    const cache = await native.request({ subtype: 'get_session_cost' })
    assert.ok(idleCompactionCache(cache.response?.text ?? '', Date.now()), 'The fixture must establish a native warm one-hour cache report')
    await send('/compact', true)
    assert.ok(messages.some((m) => m.type === 'system' && m.subtype === 'compact_boundary'))
    assert.ok(apiCalls >= 4, 'Native compaction must call only the local fixture after the three fixture turns')
    assert.deepEqual(unexpected, [])
  } finally {
    waiter?.({ done: true, value: undefined as never }); q?.close(); await consume
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
