import { useState } from 'react'
import {
  Copy, Check, Wrench, Hash, FileText, Search,
  ChevronDown, ChevronUp, Save, RotateCcw, History, X, Clock,
} from 'lucide-react'

function timeAgo(ts) {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}min atrás`
  const h = Math.floor(min / 60)
  return `${h}h ${min % 60}min atrás`
}

function PromptCard({ prompt, defaultOpen, onSave, getVersions, onRestore }) {
  const [open, setOpen] = useState(defaultOpen)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(prompt.body)
  const [copied, setCopied] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [saved, setSaved] = useState(false)

  const versions = getVersions(prompt.id)
  const isDirty = draft !== prompt.body

  const handleCopy = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(editing ? draft : prompt.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const handleEdit = (e) => {
    e.stopPropagation()
    setDraft(prompt.body)
    setEditing(true)
    if (!open) setOpen(true)
  }

  const handleSave = () => {
    onSave(prompt.id, draft)
    setEditing(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleCancel = () => {
    setDraft(prompt.body)
    setEditing(false)
  }

  const handleRestore = (body) => {
    onRestore(prompt.id, body)
    setDraft(body)
    setEditing(false)
    setShowVersions(false)
  }

  const displayBody = editing ? draft : prompt.body
  const lines = displayBody.split('\n').length
  const chars = displayBody.length

  return (
    <div className={`prompt-section ${open ? 'open' : ''}`}>
      <button className="prompt-section-header" onClick={() => setOpen(!open)}>
        <div className="prompt-section-left">
          <span className="prompt-section-name">{prompt.name}</span>
          <span className="viewer-badge">{prompt.type}</span>
          {prompt.originalBody !== prompt.body && (
            <span className="viewer-badge edited-badge">editado</span>
          )}
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
              <div className="prompt-toolbar-actions">
                {versions.length > 0 && (
                  <button
                    className={`tool-btn ${showVersions ? 'active' : ''}`}
                    onClick={() => setShowVersions(!showVersions)}
                    title="Versões anteriores (24h)"
                  >
                    <History size={14} />
                    <span>{versions.length}</span>
                  </button>
                )}
                {!editing ? (
                  <>
                    <button className="tool-btn" onClick={handleEdit} title="Editar">
                      <FileText size={14} />
                      Editar
                    </button>
                    <button className="copy-btn" onClick={handleCopy}>
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? 'Copiado!' : 'Copiar'}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="tool-btn cancel-btn" onClick={handleCancel}>
                      <X size={14} />
                      Cancelar
                    </button>
                    <button
                      className={`tool-btn save-btn ${isDirty ? 'ready' : ''}`}
                      onClick={handleSave}
                      disabled={!isDirty}
                    >
                      {saved ? <Check size={14} /> : <Save size={14} />}
                      {saved ? 'Salvo!' : 'Salvar'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {showVersions && (
              <div className="versions-panel">
                <div className="versions-header">
                  <Clock size={13} />
                  <span>Versões anteriores (últimas 24h)</span>
                </div>
                {versions.map((v, i) => (
                  <div key={i} className="version-item">
                    <span className="version-time">{timeAgo(v.ts)}</span>
                    <div className="version-actions">
                      <button
                        className="version-preview-btn"
                        onClick={() => {
                          setDraft(v.body)
                          setEditing(true)
                          setShowVersions(false)
                        }}
                      >
                        Visualizar
                      </button>
                      <button
                        className="version-restore-btn"
                        onClick={() => handleRestore(v.body)}
                      >
                        <RotateCcw size={12} />
                        Restaurar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {editing ? (
              <textarea
                className="prompt-edit-area"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
            ) : (
              <pre className="prompt-body">{prompt.body}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function PromptViewer({ prompts, onSave, getVersions, onRestore }) {
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
          <PromptCard
            key={p.id}
            prompt={p}
            defaultOpen={i === 0}
            onSave={onSave}
            getVersions={getVersions}
            onRestore={onRestore}
          />
        ))}
        {filtered.length === 0 && (
          <div className="empty-state">Nenhum prompt encontrado.</div>
        )}
      </div>
    </div>
  )
}
