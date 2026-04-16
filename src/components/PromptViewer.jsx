import { useState } from 'react'
import { Copy, Check, Wrench, Hash, FileText, Search, ChevronDown, ChevronUp } from 'lucide-react'

function PromptCard({ prompt, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(prompt.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const lines = prompt.body.split('\n').length
  const chars = prompt.body.length

  return (
    <div className={`prompt-section ${open ? 'open' : ''}`}>
      <button className="prompt-section-header" onClick={() => setOpen(!open)}>
        <div className="prompt-section-left">
          <span className="prompt-section-name">{prompt.name}</span>
          <span className="viewer-badge">{prompt.type}</span>
        </div>
        <div className="prompt-section-right">
          <span className="meta-item">
            <FileText size={12} />
            {lines}
          </span>
          <span className="meta-item">
            <Hash size={12} />
            {chars.toLocaleString('pt-BR')}
          </span>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {open && (
        <div className="prompt-section-body">
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
      )}
    </div>
  )
}

export default function PromptViewer({ prompts }) {
  const [filter, setFilter] = useState('')

  const q = filter.toLowerCase()
  const filtered = q
    ? prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.type.toLowerCase().includes(q) ||
          p.body.toLowerCase().includes(q)
      )
    : prompts

  return (
    <div className="viewer">
      <div className="viewer-page-header">
        <h2 className="viewer-title">Todos os Prompts</h2>
        <span className="section-count">{filtered.length}</span>
      </div>

      <div className="viewer-search">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          placeholder="Filtrar prompts..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="prompts-list">
        {filtered.map((p, i) => (
          <PromptCard key={p.id} prompt={p} defaultOpen={i === 0} />
        ))}
        {filtered.length === 0 && (
          <div className="empty-state">Nenhum prompt encontrado.</div>
        )}
      </div>
    </div>
  )
}
