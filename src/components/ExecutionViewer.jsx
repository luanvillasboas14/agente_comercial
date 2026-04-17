import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Search, Trash2, Clock, MessageSquare, Bot, Database,
  ChevronRight, ChevronDown, AlertCircle, CheckCircle2,
  XCircle, ArrowRight, User, Cpu, Zap, Copy, RefreshCw
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

function CopyToast({ visible }) {
  if (!visible) return null
  return <div className="copy-toast">Copiado!</div>
}

function FlowNode({ icon: Icon, label, status, duration, isLast, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const hasContent = !!children

  const statusColors = {
    success: { bg: 'rgba(16, 185, 129, 0.08)', border: '#10b981', icon: '#34d399' },
    error: { bg: 'rgba(239, 68, 68, 0.08)', border: '#ef4444', icon: '#f87171' },
    info: { bg: 'rgba(59, 130, 246, 0.08)', border: '#3b82f6', icon: '#60a5fa' },
    neutral: { bg: 'rgba(136, 146, 168, 0.08)', border: '#505a72', icon: '#8892a8' },
  }
  const colors = statusColors[status] || statusColors.neutral

  return (
    <div className="flow-node-wrapper">
      <div className="flow-node" style={{ borderColor: colors.border, backgroundColor: colors.bg }}
        onClick={() => hasContent && setOpen(!open)}>
        <div className="flow-node-header">
          <div className="flow-node-icon" style={{ color: colors.icon }}>
            <Icon size={18} />
          </div>
          <div className="flow-node-info">
            <span className="flow-node-label">{label}</span>
            {duration != null && (
              <span className="flow-node-duration"><Clock size={11} /> {formatDuration(duration)}</span>
            )}
          </div>
          <div className="flow-node-status">
            {status === 'success' && <CheckCircle2 size={16} color={colors.icon} />}
            {status === 'error' && <XCircle size={16} color={colors.icon} />}
            {hasContent && (open ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
          </div>
        </div>
      </div>
      {open && children && <div className="flow-node-body">{children}</div>}
      {!isLast && (
        <div className="flow-connector">
          <div className="flow-connector-line" />
          <ArrowRight size={12} className="flow-connector-arrow" />
        </div>
      )}
    </div>
  )
}

function ExecutionDetail({ execution, onCopy }) {
  const hasTools = execution.toolCalls?.length > 0

  const copyDetailId = () => {
    navigator.clipboard?.writeText(execution.id)
    onCopy()
  }

  return (
    <div className="exec-detail">
      <div className="exec-detail-header">
        <div className="exec-detail-id-row">
          <button className="exec-detail-id" onClick={copyDetailId} title="Clique para copiar ID">
            {execution.id}
            <Copy size={14} />
          </button>
          <span className={`exec-detail-badge ${execution.error ? 'error' : 'success'}`}>
            {execution.error ? 'Erro' : 'Sucesso'}
          </span>
        </div>
        <div className="exec-detail-meta">
          <span><Clock size={13} /> {formatTime(execution.timestamp)}</span>
          <span><Cpu size={13} /> {execution.model}</span>
          <span><Zap size={13} /> {formatDuration(execution.totalDurationMs)}</span>
        </div>
      </div>

      <div className="exec-flow">
        <FlowNode icon={User} label="Mensagem do Usuário" status="neutral" defaultOpen={true}
          isLast={!hasTools && !execution.response && !execution.error}>
          <div className="flow-content-text">{execution.userMessage}</div>
        </FlowNode>

        <FlowNode icon={Bot} label="Orquestrador (LLM)" status="info" defaultOpen={false}
          isLast={!hasTools && !execution.response && !execution.error}>
          <div className="flow-content-text">
            <strong>Modelo:</strong> {execution.model}<br />
            <strong>Rounds:</strong> {execution.steps?.filter((s) => s.type === 'llm_call').length || 1}<br />
            {hasTools && (
              <><strong>Tools chamadas:</strong> {execution.toolCalls.map((t) => t.tool).join(', ')}</>
            )}
          </div>
        </FlowNode>

        {execution.toolCalls?.map((tc, i) => (
          <FlowNode key={i} icon={Database}
            label={tc.tool.replace('buscar_', 'Buscar ').replace('_', ' ')}
            status={tc.error ? 'error' : 'success'} duration={tc.durationMs} defaultOpen={false}
            isLast={i === execution.toolCalls.length - 1 && !execution.response && !execution.error}>
            <div className="flow-content-detail">
              <div className="flow-content-section">
                <span className="flow-content-label">Entrada (args)</span>
                <pre className="flow-content-pre">{JSON.stringify(tc.args, null, 2)}</pre>
              </div>
              <div className="flow-content-section">
                <span className="flow-content-label">{tc.error ? 'Erro' : 'Resultado da busca'}</span>
                <pre className="flow-content-pre flow-content-result">
                  {tc.error || truncate(tc.result, 1000)}
                </pre>
              </div>
            </div>
          </FlowNode>
        ))}

        {execution.response && (
          <FlowNode icon={Bot} label="Resposta Final" status="success" defaultOpen={true} isLast={true}>
            <div className="flow-content-text">{execution.response}</div>
          </FlowNode>
        )}

        {execution.error && !execution.response && (
          <FlowNode icon={AlertCircle} label="Erro" status="error" defaultOpen={true} isLast={true}>
            <div className="flow-content-text flow-error-text">{execution.error}</div>
          </FlowNode>
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
      <CopyToast visible={copyToast} />

      <div className="exec-viewer-header">
        <h2 className="viewer-title">Execuções</h2>
        <div className="exec-viewer-actions">
          <button className="pg-action-btn" onClick={fetchExecutions} title="Atualizar">
            <RefreshCw size={16} />
          </button>
          <button className="pg-action-btn" onClick={handleClear} title="Limpar tudo">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="exec-search">
        <Search size={16} className="exec-search-icon" />
        <input type="text" placeholder="Buscar por ID ou mensagem..." value={searchId}
          onChange={(e) => setSearchId(e.target.value)} className="exec-search-input" />
      </div>

      <div className="exec-layout">
        <div className="exec-list">
          {loading && (
            <div className="exec-empty">
              <div className="loader-sm" />
              <p>Carregando execuções...</p>
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="exec-empty">
              <MessageSquare size={32} strokeWidth={1.2} />
              <p>{executions.length === 0 ? 'Nenhuma execução registrada ainda.' : 'Nenhum resultado para a busca.'}</p>
              <span>Use o Teste IA para gerar execuções</span>
            </div>
          )}
          {!loading && filtered.map((exec) => (
            <div key={exec.id}
              className={`exec-item ${selected?.id === exec.id ? 'selected' : ''}`}
              onClick={() => handleSelect(exec)}>
              <div className="exec-item-top">
                <button className="exec-item-id" onClick={(e) => copyId(exec.id, e)} title="Clique para copiar ID">
                  {exec.id}
                  <Copy size={10} className="exec-item-id-copy" />
                </button>
                <span className={`exec-item-status ${exec.error ? 'error' : 'success'}`}>
                  {exec.error ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
                </span>
              </div>
              <div className="exec-item-msg">{truncate(exec.userMessage, 80)}</div>
              <div className="exec-item-meta">
                <span><Clock size={11} /> {formatTime(exec.timestamp)}</span>
                <span><Zap size={11} /> {formatDuration(exec.totalDurationMs)}</span>
                {exec.toolCalls?.length > 0 && (
                  <span><Database size={11} /> {exec.toolCalls.length} tool{exec.toolCalls.length > 1 ? 's' : ''}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="exec-detail-panel">
          {selected ? (
            <ExecutionDetail execution={selected} onCopy={showCopyToast} />
          ) : (
            <div className="exec-detail-empty">
              <Bot size={40} strokeWidth={1.2} />
              <p>Selecione uma execução para ver os detalhes</p>
              <span>Ou busque pelo ID de uma execução do Teste IA</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
