import { useState } from 'react'
import { Copy, Check, Wrench, Hash, FileText } from 'lucide-react'

export default function PromptViewer({ prompt }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const lines = prompt.body.split('\n').length
  const chars = prompt.body.length

  return (
    <div className="viewer">
      <div className="viewer-header">
        <div className="viewer-title-row">
          <h2 className="viewer-title">{prompt.name}</h2>
          <span className="viewer-badge">{prompt.type}</span>
        </div>

        <div className="viewer-meta">
          <span className="meta-item">
            <FileText size={13} />
            {lines} linhas
          </span>
          <span className="meta-item">
            <Hash size={13} />
            {chars.toLocaleString('pt-BR')} caracteres
          </span>
        </div>
      </div>

      {prompt.toolDesc && (
        <div className="tool-desc">
          <Wrench size={14} />
          <span>{prompt.toolDesc}</span>
        </div>
      )}

      <div className="prompt-card">
        <div className="prompt-toolbar">
          <span className="prompt-label">System Prompt</span>
          <button className="copy-btn" onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
        </div>
        <pre className="prompt-body">{prompt.body}</pre>
      </div>
    </div>
  )
}
