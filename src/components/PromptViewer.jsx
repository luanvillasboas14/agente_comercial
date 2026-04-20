import { useState } from 'react'
import {
  Copy, Check, Wrench, Hash, FileText, Search,
  ChevronRight, Save, RotateCcw, History, X, Clock, Eye, Edit
} from 'lucide-react'

function timeAgo(ts) {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}min atrás`
  const h = Math.floor(min / 60)
  return `${h}h ${min % 60}min atrás`
}

function PromptRow({ prompt, defaultOpen, onSave, getVersions, onRestore }) {
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

  const handleCancel = () => { setDraft(prompt.body); setEditing(false) }

  const handleRestore = (body) => {
    onRestore(prompt.id, body)
    setDraft(body)
    setEditing(false)
    setShowVersions(false)
  }

  const displayBody = editing ? draft : prompt.body
  const lines = displayBody.split('\n').length
  const chars = displayBody.length

  function highlightCode(text) {
    return text.split('\n').map((line, i) => {
      if (/^#{1,3}\s/.test(line)) return <div key={i}><span className="token-header">{line}</span></div>
      if (/^\s*-\s/.test(line)) {
        const match = line.match(/^(\s*-\s)(.*)$/) || ['', '- ', line]
        return <div key={i}><span className="token-comment">{match[1]}</span><span>{match[2]}</span></div>
      }
      return <div key={i}>{line || '\u00A0'}</div>
    })
  }

  return (
    <div className={`prompt-row${open ? ' open' : ''}`}>
      <button className="prompt-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="prompt-caret" />
        <div className="prompt-meta-block">
          <span className="prompt-name">{prompt.name}</span>
          <span className="prompt-type-badge">{prompt.type}</span>
          {prompt.originalBody !== prompt.body && (
            <span className="badge success">
              <span className="dot" style={{ width: 5, height: 5 }} />
              editado
            </span>
          )}
        </div>
        <div className="prompt-meta-right">
          <span className="meta-stat"><FileText size={11} /> {lines}</span>
          <span className="meta-stat"><Hash size={11} /> {chars.toLocaleString('pt-BR')}</span>
        </div>
      </button>

      {open && (
        <div className="prompt-body-inner">
          {prompt.toolDesc && (
            <div className="tool-desc-box">
              <Wrench size={13} />
              <span>{prompt.toolDesc}</span>
            </div>
          )}
          <div className="editor-card">
            <div className="editor-toolbar">
              <div className="editor-toolbar-left">
                <div className="editor-dots"><span /><span /><span /></div>
                <span>system prompt</span>
              </div>
              <div className="editor-toolbar-right">
                {versions.length > 0 && (
                  <button className={`icon-btn${showVersions ? ' active' : ''}`} onClick={() => setShowVersions(!showVersions)}>
                    <History size={13} /> <span>{versions.length}</span>
                  </button>
                )}
                {!editing ? (
                  <>
                    <button className="icon-btn" onClick={handleEdit}><Edit size={13} /> <span>Editar</span></button>
                    <button className="icon-btn" onClick={handleCopy}>
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                      <span>{copied ? 'Copiado' : 'Copiar'}</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button className="icon-btn danger" onClick={handleCancel}><X size={13} /> <span>Cancelar</span></button>
                    <button className={`icon-btn success`} onClick={handleSave} disabled={!isDirty}>
                      {saved ? <Check size={13} /> : <Save size={13} />}
                      <span>{saved ? 'Salvo!' : 'Salvar'}</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {showVersions && (
              <div className="versions-panel">
                <div className="versions-head">
                  <Clock size={11} /> Versões das últimas 24h
                </div>
                {versions.map((v, i) => (
                  <div key={i} className="version-item">
                    <span className="version-time"><Clock size={12} /> {timeAgo(v.ts)}</span>
                    <div className="version-actions">
                      <button className="icon-btn" onClick={() => { setDraft(v.body); setEditing(true); setShowVersions(false) }}>
                        <Eye size={12} /> Visualizar
                      </button>
                      <button className="icon-btn" onClick={() => handleRestore(v.body)}>
                        <RotateCcw size={12} /> Restaurar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {editing ? (
              <textarea className="edit-area" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
            ) : (
              <div className="code-block">
                <div className="code-gutter">
                  {prompt.body.split('\n').map((_, i) => <div key={i}>{i + 1}</div>)}
                </div>
                <div className="code-content">{highlightCode(prompt.body)}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function PromptViewer({ prompts, onSave, getVersions, onRestore }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const filtered = prompts.filter(p => {
    if (filter === 'edited' && p.originalBody === p.body) return false
    if (filter === 'agent' && p.type !== 'agent' && !p.type.includes('agent')) return false
    if (filter === 'tool' && p.type === 'agent') return false
    if (query) {
      const q = query.toLowerCase()
      if (!p.name.toLowerCase().includes(q) && !p.body.toLowerCase().includes(q)) return false
    }
    return true
  })

  const chips = [
    { id: 'all', label: 'Todos', count: prompts.length },
    { id: 'edited', label: 'Editados', count: prompts.filter(p => p.originalBody !== p.body).length },
  ]

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            <span>Biblioteca</span><span className="sep">/</span><span>Prompts</span>
          </div>
          <h1 className="page-title">Todos os prompts</h1>
          <div className="page-subtitle">{prompts.length} prompts ativos · versionamento local de 24h</div>
        </div>
      </div>
      <div className="page">
        <div className="prompts-toolbar">
          <div className="search-wrap">
            <Search size={14} className="search-icon" />
            <input className="input" placeholder="Buscar em nomes e conteúdo..." value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="filter-chips">
            {chips.map(c => (
              <button key={c.id} className={`chip${filter === c.id ? ' active' : ''}`} onClick={() => setFilter(c.id)}>
                {c.label}
                <span className="chip-count tnum">{c.count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="prompts-grid">
          {filtered.length === 0 ? (
            <div className="empty">
              <FileText size={32} className="empty-icon" />
              <div className="empty-title">Nenhum prompt encontrado</div>
              <div>Ajuste os filtros ou a busca.</div>
            </div>
          ) : (
            filtered.map((p, i) => (
              <PromptRow key={p.id} prompt={p} defaultOpen={i === 0} onSave={onSave} getVersions={getVersions} onRestore={onRestore} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
