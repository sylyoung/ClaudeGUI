import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.createSourceFile('index.ts', fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'createWindow')
assert.ok(declaration, 'Test the production window factory without starting accounts or session hosts')
const factory = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function windowFixture(platform) {
  const windows = []
  class BrowserWindow {
    constructor(options) {
      this.options = options
      this.events = new Map()
      this.calls = []
      if (platform === 'darwin') this.setAutoHideCursor = (value) => this.calls.push(['autoHideCursor', value])
      this.webContents = { setWindowOpenHandler() {}, on() {} }
      windows.push(this)
    }
    on(event, listener) { this.events.set(event, listener) }
    show() { this.calls.push(['show']) }
    maximize() {}
    loadFile() { this.calls.push(['loadFile']) }
    loadURL() { this.calls.push(['loadURL']) }
  }
  const context = vm.createContext({
    BrowserWindow, process: { platform, env: {} }, path, __dirname: '/fixture/main', mainWindow: null,
    store: { get: () => ({}) }, app: { getPath: () => '/fixture/userdata' }, host: { connected: false },
    windowBackground: () => '#ffffff', loadWindowState: () => undefined, trackWindowState() {}, shell: {}
  })
  vm.runInContext(factory, context)
  return { windows, create: () => vm.runInContext('createWindow()', context) }
}

test('macOS disables native pointer auto-hiding before loading or showing the window', () => {
  const win = windowFixture('darwin').create()
  assert.equal(win.options.show, false)
  assert.deepEqual(win.calls, [['autoHideCursor', false], ['loadFile']])
  win.events.get('ready-to-show')()
  assert.deepEqual(win.calls.at(-1), ['show'])
})

for (const platform of ['linux', 'win32']) {
  test(`${platform} does not call the macOS-only cursor API`, () => {
    const win = windowFixture(platform).create()
    assert.deepEqual(win.calls, [['loadFile']])
  })
}

test('every replacement macOS window receives the pointer policy', () => {
  const fixture = windowFixture('darwin')
  fixture.create().events.get('closed')()
  fixture.create()
  assert.equal(fixture.windows.length, 2)
  for (const win of fixture.windows) assert.deepEqual(win.calls[0], ['autoHideCursor', false])
})
