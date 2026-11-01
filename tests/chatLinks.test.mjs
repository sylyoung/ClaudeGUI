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
const { linkTargetPath, splitLine } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

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
