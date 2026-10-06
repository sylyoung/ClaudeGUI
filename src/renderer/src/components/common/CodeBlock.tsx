import React, { useMemo, useState } from 'react'
import { Check, Copy, WrapText } from 'lucide-react'
import { highlight } from '@/lib/highlight'

export function CodeBlock({ code, language, title }: { code: string; language?: string; title?: string }) {
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const html = useMemo(() => highlight(code.replace(/\n$/, ''), language), [code, language])
  const copy = async () => {
    await window.api.shell.copy(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className={`codeblock${wrap ? ' wrap' : ''}`}>
      <div className="cb-head">
        <span>{title ?? language ?? 'text'}</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <button className="copy-btn" onClick={() => setWrap((w) => !w)} data-tip="Toggle line wrap">
            <WrapText size={12} />
          </button>
          <button className="copy-btn" onClick={copy} data-tip="Copy">
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'copied' : 'copy'}
          </button>
        </span>
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}
