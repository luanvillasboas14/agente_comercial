import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Search, Trash2, Clock, Bot, Database,
  ChevronRight, ChevronDown, AlertCircle,
  User, Cpu, Zap, Copy, RefreshCw,
  Check, ListChecks
} from 'lucide-react'
import { getAllExecutions, clearExecutions } from '../lib/executionStore'

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function truncate(text, max = 200) {
  if (!text) return '(vazio)'
  return text.length > max ? text.substring(0, max) + '…' : text
}

function FlowStep({ icon: Icon, iconKind, title, duration, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const hasContent = !!children
  return (
    <div className="flow-step">
      <div className={`flow-indicator ${iconKind || ''}`}>
        <Icon size={14} />
      </div>
      <div className="flow-card">
        <div className="flow-card-head" onClick={() => hasContent && setOpen(!open)}>
          <div className="flow-card-title">{title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {duration != null && (
              <span className="flow-card-duration">
                <Clock size={10} /> {formatDuration(duration)}
              </span>
            )}
            {hasContent && (open ? <ChevronDown size={14} style={{ color: 'var(--fg-3)' }} /> : <ChevronRight size={14} style={{ color: 'var(--fg-3)' }} />)}
          </div>
        </div>
        {open && hasContent && <div className="flow-card-body">{children}</div>}
      </div>
    </div>
  )
}

function ExecutionDetail({ execution, onCopy }) {
  const hasTools = execution.toolCalls?.length > 0
  return (
    <div className="exec-detail">
      <div className="exec-detail-header">
        <div className="exec-detail-id-row">
          <button className="exec-detail-id" onClick={() => { navigator.clipboard?.writeText(execution.id); onCopy() }}>
            {execution.id}
            <Copy size={13} />
          </button>
          <span className={`badge ${execution.error ? 'danger' : 'success'}`}>
            {execution.error ? 'Erro' : 'Sucesso'}
          </span>
        </div>
        <div className="exec-detail-meta">
          <span><Clock size={12} /> {formatTime(execution.timestamp)}</span>
          <span><Cpu size={12} /> {execution.model}</span>
          <span><Zap size={12} /> {formatDuration(execution.totalDurationMs)}</span>
        </div>
      </div>
      <div className="flow-track">
        <FlowStep icon={User} iconKind="" title="Mensagem do usuário" defaultOpen>
          <div className="flow-content-text">{execution.userMessage}</div>
        </FlowStep>
        <FlowStep icon={Bot} iconKind="info" title={`Orquestrador · ${execution.model}`}>
          <div className="flow-content-text">
            Rounds: {execution.steps?.filter(s => s.type === 'llm_call').length || 1}
            {hasTools && <><br />Tools: {execution.toolCalls.map(t => t.tool).join(', ')}</>}
          </div>
        </FlowStep>
        {execution.toolCalls?.map((tc, i) => (
          <FlowStep key={i} icon={Database} iconKind={tc.error ? 'error' : 'success'}
            title={tc.tool.replace('buscar_', 'Buscar ')} duration={tc.durationMs}>
            <div>
              <div className="flow-section">
                <div className="flow-label">Entrada</div>
                <pre className="flow-content-pre">{JSON.stringify(tc.args, null, 2)}</pre>
              </div>
              <div className="flow-section">
                <div className="flow-label">{tc.error ? 'Erro' : 'Resultado'}</div>
                <pre className="flow-content-pre" style={tc.error ? { color: 'var(--danger)' } : {}}>
                  {tc.error || truncate(tc.result, 1000)}
                </pre>
              </div>
            </div>
          </FlowStep>
        ))}
        {execution.response && (
          <FlowStep icon={Bot} iconKind="success" title="Resposta final" defaultOpen>
            <div className="flow-content-text">{execution.response}</div>
          </FlowStep>
        )}
        {execution.error && !execution.response && (
          <FlowStep icon={AlertCircle} iconKind="error" title="Erro" defaultOpen>
            <div className="flow-content-text" style={{ color: 'var(--danger)' }}>{execution.error}</div>
          </FlowStep>
        )}
      </div>
    </div>
  )
}

export default function ExecutionViewer() {
  const [searchId, setSearchId] = useState('')
  const [selected, setSelected] = useState(null)
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(true)
  const [copyToast, setCopyToast] = useState(false)

  const fetchExecutions = useCallback(async () => {
    setLoading(true)
    const data = await getAllExecutions()
    setExecutions(data)
    setLoading(false)
  }, [])

  useEffect(() => { fetchExecutions() }, [fetchExecutions])

  const handleClear = async () => {
    if (window.confirm('Limpar todas as execuções?')) {
      await clearExecutions()
      setExecutions([])
      setSelected(null)
    }
  }

  const showCopyToast = () => {
    setCopyToast(true)
    setTimeout(() => setCopyToast(false), 1500)
  }

  const filtered = useMemo(() => {
    if (!searchId.trim()) return executions
    const q = searchId.trim().toLowerCase()
    return executions.filter((e) =>
      e.id.toLowerCase().includes(q) ||
      e.userMessage.toLowerCase().includes(q)
    )
  }, [executions, searchId])

  const handleSelect = (exec) => {
    setSelected(exec.id === selected?.id ? null : exec)
  }

  const copyId = (id, evt) => {
    evt.stopPropagation()
    navigator.clipboard?.writeText(id)
    showCopyToast()
  }

  return (
    <div className="exec-viewer">
      {copyToast && <div className="toast"><Check size={14} className="toast-check" /> ID copiado</div>}

      <div className="pg-header">
        <div className="pg-title-group">
          <h1 className="page-title" style={{ fontSize: 18 }}>Execuções</h1>
          <span className="badge">{executions.length} registradas</span>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={fetchExecutions}>
            <RefreshCw size={14} /> <span>Atualizar</span>
          </button>
          <button className="btn btn-ghost btn-danger-ghost" onClick={handleClear}>
            <Trash2 size={14} /> <span>Limpar</span>
          </button>
        </div>
      </div>

      <div className="exec-layout">
        <div className="exec-list-panel">
          <div className="exec-list-head">
            <div className="search-wrap">
              <Search size={14} className="search-icon" />
              <input className="input" placeholder="Buscar por ID ou mensagem..."
                value={searchId} onChange={(e) => setSearchId(e.target.value)} />
            </div>
          </div>
          <div className="exec-list-items">
            {loading && <div className="empty"><div className="loader" style={{ margin: '0 auto' }} /></div>}
            {!loading && filtered.length === 0 && (
              <div className="empty">
                <ListChecks size={28} className="empty-icon" />
                <div className="empty-title">Nenhuma execução</div>
                <div>Use o Teste IA para gerar</div>
              </div>
            )}
            {!loading && filtered.map((exec) => (
              <div key={exec.id} className={`exec-item${selected?.id === exec.id ? ' selected' : ''}`}
                onClick={() => handleSelect(exec)}>
                <div className="exec-item-head">
                  <button className="exec-item-id" onClick={(e) => copyId(exec.id, e)}>
                    {exec.id}
                    <Copy size={10} />
                  </button>
                  <span className={`status-dot ${exec.error ? 'error' : 'success'}`} />
                </div>
                <div className="exec-item-msg">{truncate(exec.userMessage, 80)}</div>
                <div className="exec-item-footer tnum">
                  <span><Clock size={10} /> {formatTime(exec.timestamp)}</span>
                  <span><Zap size={10} /> {formatDuration(exec.totalDurationMs)}</span>
                  {exec.toolCalls?.length > 0 && (
                    <span><Database size={10} /> {exec.toolCalls.length} tool{exec.toolCalls.length > 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="exec-detail-panel">
          {selected ? (
            <ExecutionDetail execution={selected} onCopy={showCopyToast} />
          ) : (
            <div className="exec-detail-empty">
              <div>
                <div className="empty-icon"><ListChecks size={24} /></div>
                <div style={{ color: 'var(--fg-2)', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Selecione uma execução</div>
                <div style={{ fontSize: 12 }}>Ou busque pelo ID no Teste IA</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
