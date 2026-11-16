import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function moduleUrl(file, imports = {}) {
  let source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  for (const [name, url] of Object.entries(imports)) source = source.replaceAll(`'${name}'`, `'${url}'`)
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
}

const formatUrl = moduleUrl('../src/renderer/src/lib/format.ts')
const { modelLabel, sessionModelName } = await import(formatUrl)
const { providerModelOption, providerModelOptions, listedModels, encodeModelChoice, decodeModelChoice } = await import(moduleUrl('../src/renderer/src/lib/providers.ts', {
  './format': formatUrl,
  '@shared/fastMode': moduleUrl('../src/shared/fastMode.ts')
}))

const claudeModels = [
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-fable-5', 'Fable 5'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-6', 'Opus 4.6'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-haiku-4-5', 'Haiku 4.5']
]

test('Claude names keep the entire major and minor version', () => {
  for (const [id, name] of claudeModels) assert.equal(modelLabel(id), name, id)
})

test('a dated Claude ID keeps its model version, including the long-context marker', () => {
  for (const [id, name] of claudeModels) {
    assert.equal(modelLabel(`${id}-20260101`), name)
    assert.equal(modelLabel(`${id}-20260101[1m]`), `${name} (1M)`)
  }
})

test('an unfamiliar suffix is retained instead of being mistaken for a shorter Claude version', () => {
  assert.equal(modelLabel('claude-sonnet-5-5-preview'), 'Claude Sonnet-5-5 Preview')
})

test('other provider names and unresolved Claude aliases keep their existing spelling', () => {
  for (const [id, name] of [
    ['gpt-6.1-sol[1m]', 'GPT-6.1 Sol (1M)'],
    ['gpt-6-astra', 'GPT-6 Astra'],
    ['deepseek-flash', 'DeepSeek Flash'],
    ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
    ['kimi-k3', 'Kimi K3'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
    ['<synthetic>', 'Claude Code'],
    [undefined, 'default model']
  ]) assert.equal(modelLabel(id), name)
})

test('the sidebar name follows the reported concrete model without changing the chosen alias', () => {
  const record = { model: 'sonnet', lastModel: 'claude-sonnet-5' }
  assert.equal(sessionModelName(record, { model: 'claude-sonnet-5-5' }), 'Sonnet 5.5')
  assert.deepEqual(record, { model: 'sonnet', lastModel: 'claude-sonnet-5' })
})

const providers = [
  { id: 'codex', name: 'GPT', available: true, models: [
    { value: 'gpt-6.1-sol[1m]', label: 'GPT-6.1-Sol' },
    { value: 'gpt-6.1-sol-fast[1m]', label: 'GPT-6.1-Sol (fast)', fastOf: 'gpt-6.1-sol[1m]', description: 'Faster output' }
  ] },
  { id: 'deepseek', name: 'DeepSeek', available: true, models: [
    { value: 'deepseek-flash', label: 'deepseek-flash (launcher default)' }
  ] },
  { id: 'kimi', name: 'Kimi', available: true, models: [
    { value: 'kimi-k3', label: 'kimi-k3' }
  ] }
]

test('the new-session option and the chat option use the same name and exact model ID', () => {
  const expected = ['GPT-6.1 Sol (gpt-6.1-sol[1m])', 'DeepSeek Flash (deepseek-flash)', 'Kimi K3 (kimi-k3)']
  const original = structuredClone(providers)
  for (const [i, provider] of providers.entries()) {
    const model = listedModels(provider)[0]
    const option = providerModelOption(provider, model)
    assert.equal(option.label, expected[i])
    assert.deepEqual(providerModelOptions([provider]).find((o) => !o.heading), option)
    assert.deepEqual(decodeModelChoice(option.value), { provider: provider.id, model: model.value })
    assert.equal(option.value, encodeModelChoice(provider.id, model.value))
  }
  assert.deepEqual(providers, original)
})

test('shared options retain launcher notes, fast-mode information and availability', () => {
  assert.match(providerModelOption(providers[0], providers[0].models[0]).hint, /Has fast mode \(Faster output\)/)
  assert.match(providerModelOption(providers[1], providers[1].models[0]).hint, /launcher default/)
  assert.equal(providerModelOptions([providers[0]]).filter((o) => !o.heading).length, 1)
  const option = providerModelOption(providers[0], { value: 'gpt-6-astra[1m]', label: 'GPT-6-Astra', unavailable: 'Bridge update needed' })
  assert.equal(option.disabled, true)
  assert.equal(option.hint, 'Bridge update needed')
})
