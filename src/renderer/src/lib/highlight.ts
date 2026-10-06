import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import sql from 'highlight.js/lib/languages/sql'
import ini from 'highlight.js/lib/languages/ini'
import latex from 'highlight.js/lib/languages/latex'
import r from 'highlight.js/lib/languages/r'
import matlab from 'highlight.js/lib/languages/matlab'
import ruby from 'highlight.js/lib/languages/ruby'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import plaintext from 'highlight.js/lib/languages/plaintext'
import php from 'highlight.js/lib/languages/php'
import perl from 'highlight.js/lib/languages/perl'
import csharp from 'highlight.js/lib/languages/csharp'

const langs: Record<string, unknown> = {
  typescript, javascript, python, bash, json, yaml, markdown, xml, css, scss, diff, go, rust, java, c, cpp, sql, ini, latex, r,
  matlab, ruby, swift, kotlin, lua, dockerfile, makefile, plaintext, php, perl, csharp
}
for (const [name, fn] of Object.entries(langs)) hljs.registerLanguage(name, fn as never)
hljs.registerAliases(['ts', 'tsx', 'mts', 'cts'], { languageName: 'typescript' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['sh', 'zsh', 'shell', 'console'], { languageName: 'bash' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['html', 'htm', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['tex'], { languageName: 'latex' })
hljs.registerAliases(['toml'], { languageName: 'ini' })
hljs.registerAliases(['text', 'txt', 'log'], { languageName: 'plaintext' })

const MAX_HIGHLIGHT = 200_000

export function highlight(code: string, language?: string): string {
  if (code.length > MAX_HIGHLIGHT) return escapeHtml(code)
  const lang = (language || '').toLowerCase()
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    if (!lang && code.length < 20_000) return hljs.highlightAuto(code, ['typescript', 'python', 'bash', 'json', 'markdown']).value
  } catch {
    /* fall through */
  }
  return escapeHtml(code)
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
