import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import './styles.css'
import 'highlight.js/styles/github-dark-dimmed.css'

if (import.meta.env.DEV) (window as unknown as { __store: unknown }).__store = useStore
const errs: string[] = []
;(window as unknown as { __errors: string[] }).__errors = errs
window.addEventListener('error', (e) => errs.push(`${e.message} @ ${e.filename}:${e.lineno}\n${e.error?.stack ?? ''}`))
window.addEventListener('unhandledrejection', (e) => errs.push(`unhandled: ${(e.reason as Error)?.stack ?? String(e.reason)}`))

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    errs.push(`boundary: ${error.stack}\n${info.componentStack}`)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#f85149', fontFamily: 'monospace', whiteSpace: 'pre-wrap', userSelect: 'text' }}>
          <h3>ClaudeGUI renderer crashed</h3>
          {String(this.state.error.stack)}
          <div style={{ marginTop: 12 }}>
            <button onClick={() => location.reload()} style={{ padding: '6px 12px' }}>Reload</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
