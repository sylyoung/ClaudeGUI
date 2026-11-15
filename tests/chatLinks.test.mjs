import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// The production helpers, compiled on the fly so the test reads the same source the app ships.
const source = fs.readFileSync(new URL('../src/renderer/src/lib/paths.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { isProbablyPath, linkTargetPath, splitLine } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const fsSource = fs.readFileSync(new URL('../src/main/fsService.ts', import.meta.url), 'utf8')
const fsCompiled = ts.transpileModule(fsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { locatePath } = await import(`data:text/javascript;base64,${Buffer.from(fsCompiled).toString('base64')}`)

/** The address react-markdown hands to the chat's link and picture components for one reply. */
function addressOf(markdown) {
  let seen
  const capture = (key) => (props) => {
    seen = props[key]
    return null
  }
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm],
      urlTransform: (url) => defaultUrlTransform(url),
      components: { a: capture('href'), img: capture('src') },
      children: markdown
    })
  )
  return seen
}

const written = [
  ['[大纲](中文目录/测试文件.md)', '中文目录/测试文件.md'],
  ['[文档](/tmp/中文目录/说明文档.md:12)', '/tmp/中文目录/说明文档.md:12'],
  ['[笔记](<中文目录/会议 记录.md>)', '中文目录/会议 记录.md'],
  ['![示意图](图片/示意图.png)', '图片/示意图.png'],
  ['[報告](資料/レポート.pdf)', '資料/レポート.pdf'],
  ['[report](notes/100%.md)', 'notes/100%.md'],
  ['[plain](docs/readme.md)', 'docs/readme.md']
]

test('the Markdown renderer percent-encodes the address of a link to a CJK-named file', () => {
  assert.equal(addressOf('[大纲](中文目录/测试文件.md)'), '%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/%E6%B5%8B%E8%AF%95%E6%96%87%E4%BB%B6.md')
  assert.equal(addressOf('[笔记](<中文目录/会议 记录.md>)'), '%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/%E4%BC%9A%E8%AE%AE%20%E8%AE%B0%E5%BD%95.md')
})

test('a link or picture address is read back to the path that was written', () => {
  for (const [markdown, path] of written) assert.equal(linkTargetPath(addressOf(markdown)), path, markdown)
})

test('a line number written after the path survives the reading', () => {
  assert.deepEqual(splitLine(linkTargetPath(addressOf('[文档](/tmp/中文目录/说明文档.md:12)'))), { path: '/tmp/中文目录/说明文档.md', line: 12, column: undefined })
})

test('an address that is not valid percent-encoding is kept as written', () => {
  for (const address of ['%E4%B8', 'notes/50%off.md', 'a%zz.md', '']) assert.equal(linkTargetPath(address), address)
})

test('the read-back path names the file on disk, and the encoded address does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-links-'))
  try {
    fs.mkdirSync(path.join(root, '中文目录'))
    fs.writeFileSync(path.join(root, '中文目录', '会议 记录.md'), '# 记录\n')
    const address = addressOf('[笔记](<中文目录/会议 记录.md>)')
    assert.equal(fs.existsSync(path.resolve(root, address)), false)
    assert.equal(fs.existsSync(path.resolve(root, linkTargetPath(address))), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a path written from a folder above the chat\'s folder opens the file there', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-links-'))
  try {
    const home = path.join(outer, 'home')
    const cwd = path.join(home, 'Workspace', '申请', '项目甲')
    const cv = path.join(home, 'Workspace', '申请', '项目乙', '提交文件', '简历.pdf')
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(path.dirname(cv), { recursive: true })
    fs.writeFileSync(cv, '')
    // from 申请, from the folder above it, the folder alone, and glued to a Chinese sentence
    assert.equal(locatePath('项目乙/提交文件/简历.pdf', cwd, home), cv)
    assert.equal(locatePath('申请/项目乙/提交文件/简历.pdf', cwd, home), cv)
    assert.equal(locatePath('申请/项目乙/提交文件/', cwd, home), path.dirname(cv))
    assert.equal(locatePath('打开申请/项目乙/提交文件/简历.pdf', cwd, home), cv)
    // a file of that name in the chat's own folder comes first
    fs.mkdirSync(path.join(cwd, '项目乙', '提交文件'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '项目乙', '提交文件', '简历.pdf'), '')
    assert.equal(locatePath('项目乙/提交文件/简历.pdf', cwd, home), path.join(cwd, '项目乙', '提交文件', '简历.pdf'))
    // nothing above the home folder is searched, and a path found nowhere is reported as written
    fs.mkdirSync(path.join(outer, 'outside'))
    fs.writeFileSync(path.join(outer, 'outside', 'notes.md'), '')
    assert.equal(locatePath('outside/notes.md', cwd, home), path.join(cwd, 'outside', 'notes.md'))
    assert.equal(locatePath('申请/项目乙/缺少.pdf', cwd, home), path.join(cwd, '申请', '项目乙', '缺少.pdf'))
  } finally {
    fs.rmSync(outer, { recursive: true, force: true })
  }
})

test('a folder written with its closing slash is taken for a path', () => {
  for (const t of ['申请/项目乙/提交文件/', 'docs/notes/']) assert.equal(isProbablyPath(t), true, t)
  for (const t of ['notes/', '/']) assert.equal(isProbablyPath(t), false, t)
})
