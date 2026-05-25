import { useState, useEffect, useCallback, useRef } from 'react'
import {
  loadStatus,
  loadConvertidosRecentes,
  triggerBatchAnalysis,
  loadBatches,
  loadExamples,
  activateExample,
  rejectExample,
  archiveExample,
  triggerDetectorNow,
  loadDetectorStatus,
} from '../lib/iaLearningStore'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtShort(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function usePollingWhenVisible(callback, intervalMs = 60_000) {
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) cbRef.current()
    }, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
}

// ─── Badges ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    pendente: { bg: 'oklch(78% 0.14 75 / 0.15)', color: 'oklch(40% 0.14 75)', border: 'oklch(78% 0.14 75 / 0.35)' },
    processado: { bg: 'oklch(72% 0.14 155 / 0.15)', color: 'oklch(35% 0.14 155)', border: 'oklch(72% 0.14 155 / 0.35)' },
    ativo: { bg: 'oklch(72% 0.14 155 / 0.15)', color: 'oklch(35% 0.14 155)', border: 'oklch(72% 0.14 155 / 0.35)' },
    rejeitado: { bg: 'oklch(40% 0.05 265 / 0.10)', color: 'oklch(55% 0.05 265)', border: 'oklch(55% 0.05 265 / 0.35)' },
    arquivado: { bg: 'oklch(55% 0.04 260 / 0.10)', color: 'oklch(45% 0.04 260)', border: 'oklch(45% 0.04 260 / 0.35)' },
    running: { bg: 'oklch(78% 0.14 75 / 0.15)', color: 'oklch(40% 0.14 75)', border: 'oklch(78% 0.14 75 / 0.35)' },
    success: { bg: 'oklch(72% 0.14 155 / 0.15)', color: 'oklch(35% 0.14 155)', border: 'oklch(72% 0.14 155 / 0.35)' },
    failed: { bg: 'oklch(68% 0.20 25 / 0.15)', color: 'oklch(40% 0.20 25)', border: 'oklch(68% 0.20 25 / 0.35)' },
  }
  const s = map[status] || map.pendente
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 20,
      fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
    }}>
      {status}
    </span>
  )
}

function CategoriaBadge({ cat }) {
  const colors = {
    abertura: '#3b82f6', preco: '#f59e0b', objecao: '#ef4444',
    curso_especifico: '#8b5cf6', fechamento: '#10b981', outro: '#6b7280',
  }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
      background: `${colors[cat] || colors.outro}22`,
      color: colors[cat] || colors.outro,
      border: `1px solid ${colors[cat] || colors.outro}44`,
    }}>
      {cat}
    </span>
  )
}

// ─── Modal de diálogo ─────────────────────────────────────────────────────────

function DialogModal({ example, onClose }) {
  if (!example) return null
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-1)', borderRadius: 14, padding: 24, maxWidth: 560,
          width: '90vw', maxHeight: '80vh', overflow: 'auto',
          border: '1px solid var(--line-1)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <CategoriaBadge cat={example.categoria} />
            {' '}
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginLeft: 6 }}>
              {example.contexto_resumido || 'Diálogo'}
            </span>
          </div>
          <button className="btn btn-sm" onClick={onClose} style={{ padding: '4px 10px' }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(Array.isArray(example.dialogo) ? example.dialogo : []).map((msg, i) => (
            <div
              key={i}
              style={{
                padding: '8px 12px', borderRadius: 8,
                background: msg.remetente === 'lead' ? 'var(--bg-2)' : 'oklch(72% 0.14 155 / 0.10)',
                border: `1px solid ${msg.remetente === 'lead' ? 'var(--line-1)' : 'oklch(72% 0.14 155 / 0.30)'}`,
                maxWidth: '85%', alignSelf: msg.remetente === 'lead' ? 'flex-start' : 'flex-end',
              }}
            >
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 3 }}>
                {msg.remetente === 'lead' ? 'Lead' : 'Consultor'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {msg.texto}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--fg-3)' }}>
          Qualidade: {example.qualidade_score}/5 · Consultor: {example.consultor_nome || '-'} · Lead: {example.fonte_lead_id || '-'}
        </div>
      </div>
    </div>
  )
}

// ─── Sub-tab Conversões ───────────────────────────────────────────────────────

function TabConversoes({ status, recentes, onAnalyze, onDetectNow, loading, analyzing, detecting }) {
  const min = status?.min_batch_size || 50
  const count = status?.pendentes_count || 0
  const canAnalyze = status?.can_analyze || false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Card principal */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: canAnalyze ? 'oklch(35% 0.14 155)' : 'var(--fg-1)' }}>
              {count}
            </div>
            <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>
              conversões aguardando · mínimo {min}
            </div>
            {!canAnalyze && (
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>
                Faltam {Math.max(0, min - count)} para atingir o mínimo
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={onDetectNow}
              disabled={detecting}
              style={{ fontSize: 12 }}
            >
              {detecting ? 'Detectando...' : 'Detectar agora'}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={onAnalyze}
              disabled={!canAnalyze || analyzing}
              style={{ fontSize: 12 }}
            >
              {analyzing ? 'Analisando...' : 'Analisar batch agora'}
            </button>
          </div>
        </div>
      </div>

      {/* Tabela últimas detecções */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-1)', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>
          Últimas detecções
        </div>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Carregando...</div>
        ) : recentes.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Nenhuma detecção ainda</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-1)' }}>
                  {['Lead ID', 'Consultor', 'Detectado em', 'Msgs', 'Fonte', 'Status'].map((h) => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentes.map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: 'var(--fg-1)' }}>{r.lead_id}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-2)' }}>{r.consultor_nome || '-'}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>{fmtShort(r.detected_at)}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-2)' }}>{r.total_mensagens}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-3)', fontSize: 11 }}>{r.fonte_conversa || '-'}</td>
                    <td style={{ padding: '8px 12px' }}>
                      {r.capture_error
                        ? <span style={{ fontSize: 11, color: 'oklch(40% 0.20 25)' }} title={r.capture_error}>erro captura</span>
                        : <StatusBadge status={r.processed_at ? 'processado' : 'pendente'} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sub-tab Batches ──────────────────────────────────────────────────────────

function TabBatches({ batches, loading }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-1)', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>
        Histórico de batches
      </div>
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Carregando...</div>
      ) : batches.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Nenhum batch rodado ainda</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line-1)' }}>
                {['ID', 'Trigger', 'Status', 'Leads', 'Prop. geradas', 'Ex. gerados', 'Iniciado', 'Finalizado'].map((h) => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, color: 'var(--fg-3)' }}>{b.id.slice(0, 8)}…</td>
                  <td style={{ padding: '8px 12px', color: 'var(--fg-2)' }}>{b.trigger}</td>
                  <td style={{ padding: '8px 12px' }}><StatusBadge status={b.status} /></td>
                  <td style={{ padding: '8px 12px', color: 'var(--fg-2)' }}>{b.total_leads}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--fg-2)' }}>
                    {b.total_propostas_geradas} <span style={{ color: 'var(--fg-3)' }}>/ {(b.total_propostas_geradas || 0) + (b.total_propostas_descartadas || 0)} total</span>
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--fg-2)' }}>
                    {b.total_exemplos_gerados} <span style={{ color: 'var(--fg-3)' }}>/ {(b.total_exemplos_gerados || 0) + (b.total_exemplos_descartados || 0)} total</span>
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>{fmt(b.created_at)}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>{b.finished_at ? fmt(b.finished_at) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Sub-tab Exemplos ─────────────────────────────────────────────────────────

function TabExemplos({ examples, loading, filterStatus, onFilterChange, onAction }) {
  const [selectedExample, setSelectedExample] = useState(null)
  const [actionLoading, setActionLoading] = useState({})

  async function handleAction(id, action) {
    setActionLoading((prev) => ({ ...prev, [id]: action }))
    try {
      await onAction(id, action)
    } finally {
      setActionLoading((prev) => ({ ...prev, [id]: null }))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {selectedExample && (
        <DialogModal example={selectedExample} onClose={() => setSelectedExample(null)} />
      )}

      {/* Filtro de status */}
      <div style={{ display: 'flex', gap: 6 }}>
        {['ativo', 'pendente', 'rejeitado', 'arquivado'].map((s) => (
          <button
            key={s}
            className={`btn btn-sm${filterStatus === s ? ' btn-primary' : ''}`}
            style={{ fontSize: 11, padding: '4px 10px', textTransform: 'uppercase' }}
            onClick={() => onFilterChange(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Carregando...</div>
        ) : examples.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
            Nenhum exemplo com status "{filterStatus}"
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-1)' }}>
                  {['Categoria', 'Contexto', 'Qualidade', 'Consultor', 'Criado', 'Ações'].map((h) => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {examples.map((ex) => (
                  <tr key={ex.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                    <td style={{ padding: '8px 12px' }}><CategoriaBadge cat={ex.categoria} /></td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-2)', maxWidth: 240 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                        {ex.contexto_resumido || '-'}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-1)', fontWeight: 600 }}>
                      {'★'.repeat(ex.qualidade_score || 0)}<span style={{ color: 'var(--fg-3)' }}>{'☆'.repeat(5 - (ex.qualidade_score || 0))}</span>
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-2)' }}>{ex.consultor_nome || '-'}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>{fmtShort(ex.created_at)}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 10, padding: '3px 8px' }}
                          onClick={() => setSelectedExample(ex)}
                        >
                          Ver
                        </button>
                        {filterStatus === 'pendente' && (
                          <>
                            <button
                              className="btn btn-sm"
                              style={{ fontSize: 10, padding: '3px 8px', background: 'oklch(72% 0.14 155 / 0.15)', color: 'oklch(35% 0.14 155)' }}
                              disabled={!!actionLoading[ex.id]}
                              onClick={() => handleAction(ex.id, 'activate')}
                            >
                              {actionLoading[ex.id] === 'activate' ? '...' : 'Ativar'}
                            </button>
                            <button
                              className="btn btn-sm"
                              style={{ fontSize: 10, padding: '3px 8px' }}
                              disabled={!!actionLoading[ex.id]}
                              onClick={() => handleAction(ex.id, 'reject')}
                            >
                              {actionLoading[ex.id] === 'reject' ? '...' : 'Rejeitar'}
                            </button>
                          </>
                        )}
                        {filterStatus === 'ativo' && (
                          <button
                            className="btn btn-sm"
                            style={{ fontSize: 10, padding: '3px 8px' }}
                            disabled={!!actionLoading[ex.id]}
                            onClick={() => handleAction(ex.id, 'archive')}
                          >
                            {actionLoading[ex.id] === 'archive' ? '...' : 'Arquivar'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function AprendizadoIA() {
  const [subTab, setSubTab] = useState('conversoes')
  const [status, setStatus] = useState(null)
  const [recentes, setRecentes] = useState([])
  const [batches, setBatches] = useState([])
  const [examples, setExamples] = useState([])
  const [filterStatus, setFilterStatus] = useState('ativo')

  const [loadingStatus, setLoadingStatus] = useState(true)
  const [loadingRecentes, setLoadingRecentes] = useState(true)
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [loadingExamples, setLoadingExamples] = useState(true)

  const [analyzing, setAnalyzing] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true)
    try { setStatus(await loadStatus()) } catch (_) {}
    setLoadingStatus(false)
  }, [])

  const fetchRecentes = useCallback(async () => {
    setLoadingRecentes(true)
    try { setRecentes(await loadConvertidosRecentes(50)) } catch (_) {}
    setLoadingRecentes(false)
  }, [])

  const fetchBatches = useCallback(async () => {
    setLoadingBatches(true)
    try { setBatches(await import('../lib/iaLearningStore').then((m) => m.loadBatches(20))) } catch (_) {}
    setLoadingBatches(false)
  }, [])

  const fetchExamples = useCallback(async () => {
    setLoadingExamples(true)
    try { setExamples(await loadExamples(filterStatus)) } catch (_) {}
    setLoadingExamples(false)
  }, [filterStatus])

  useEffect(() => {
    fetchStatus()
    fetchRecentes()
    fetchBatches()
  }, [fetchStatus, fetchRecentes, fetchBatches])

  useEffect(() => { fetchExamples() }, [fetchExamples])

  usePollingWhenVisible(() => {
    fetchStatus()
    if (subTab === 'conversoes') fetchRecentes()
    if (subTab === 'batches') fetchBatches()
    if (subTab === 'exemplos') fetchExamples()
  }, 60_000)

  async function handleAnalyze() {
    setError(null)
    setSuccessMsg(null)
    setAnalyzing(true)
    try {
      const result = await triggerBatchAnalysis()
      if (result.ok) {
        setSuccessMsg(`Análise concluída! Regras geradas: ${result.regrasGeradas} · Exemplos gerados: ${result.exemplosGerados}`)
        fetchStatus()
        fetchRecentes()
        fetchBatches()
      } else {
        setError(`Análise não iniciou: ${result.reason}${result.pendentes != null ? ` (pendentes: ${result.pendentes}/${result.min})` : ''}`)
      }
    } catch (e) {
      setError(e.message)
    }
    setAnalyzing(false)
  }

  async function handleDetectNow() {
    setError(null)
    setSuccessMsg(null)
    setDetecting(true)
    try {
      await triggerDetectorNow()
      setSuccessMsg('Detector iniciado. Acompanhando progresso...')
      pollDetectorUntilDone()
    } catch (e) {
      setError(e.message)
      setDetecting(false)
    }
  }

  // Poll do status do detector enquanto estiver rodando.
  // Para quando: running=false e lastResult.finishedAt > momento do disparo.
  async function pollDetectorUntilDone() {
    const triggerTs = Date.now()
    const startPollDelay = 1500
    const pollInterval = 3000
    const maxWaitMs = 30 * 60 * 1000 // 30 min
    const startedAt = Date.now()
    await new Promise((r) => setTimeout(r, startPollDelay))

    while (Date.now() - startedAt < maxWaitMs) {
      let st
      try {
        st = await loadDetectorStatus()
      } catch {
        await new Promise((r) => setTimeout(r, pollInterval))
        continue
      }

      if (st.running) {
        const elapsedSec = st.startedAt
          ? Math.round((Date.now() - new Date(st.startedAt).getTime()) / 1000)
          : 0
        const p = st.progress
        if (p && p.total != null) {
          const pct = p.total > 0 ? Math.round((p.processados / p.total) * 100) : 0
          setSuccessMsg(
            `Processando ${p.processados}/${p.total} (${pct}%) · ${p.novos} novos · ${p.skipJaDetectado} já detectados · ${p.errosCaptura} erros · ${elapsedSec}s`,
          )
        } else {
          setSuccessMsg(`Detector iniciando... (${elapsedSec}s — buscando eventos de aceite)`)
        }
        fetchStatus()
        fetchRecentes()
      } else if (st.lastResult && new Date(st.lastResult.finishedAt).getTime() >= triggerTs) {
        const r = st.lastResult
        const dur = Math.round((r.durationMs || 0) / 1000)
        if (r.ok) {
          setSuccessMsg(
            `✓ Detecção concluída em ${dur}s · ${r.novos} novos · ${r.skipJaDetectado} já detectados · ${r.errosCaptura} erros de captura (${r.totalEventos} eventos avaliados)`,
          )
        } else {
          setError(`Detecção falhou: ${r.error || 'erro desconhecido'} (após ${dur}s)`)
        }
        fetchStatus()
        fetchRecentes()
        setDetecting(false)
        return
      }
      await new Promise((r) => setTimeout(r, pollInterval))
    }
    setError('Timeout: detector excedeu 30min sem retornar status finalizado.')
    setDetecting(false)
  }

  async function handleExampleAction(id, action) {
    const { activateExample: activate, rejectExample: reject, archiveExample: archive } = await import('../lib/iaLearningStore')
    const fn = action === 'activate' ? activate : action === 'reject' ? reject : archive
    await fn(id)
    fetchExamples()
    if (action === 'activate') fetchStatus()
  }

  const SUB_TABS = [
    { id: 'conversoes', label: 'Conversões pendentes' },
    { id: 'batches', label: 'Histórico de batches' },
    { id: 'exemplos', label: 'Exemplos ativos' },
  ]

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>Aprendizado IA</h1>
        <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
          Captura conversas de leads convertidos e extrai regras e exemplos para melhorar a IA
        </p>
      </div>

      {/* Mensagens de feedback */}
      {error && (
        <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: 'oklch(68% 0.20 25 / 0.10)', border: '1px solid oklch(68% 0.20 25 / 0.30)', color: 'oklch(40% 0.20 25)', fontSize: 13 }}>
          {error}
        </div>
      )}
      {successMsg && (
        <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: 'oklch(72% 0.14 155 / 0.10)', border: '1px solid oklch(72% 0.14 155 / 0.30)', color: 'oklch(35% 0.14 155)', fontSize: 13 }}>
          {successMsg}
        </div>
      )}

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--line-1)', marginBottom: 20 }}>
        {SUB_TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setSubTab(id)}
            style={{
              padding: '10px 18px', fontSize: 13, fontWeight: subTab === id ? 600 : 400,
              color: subTab === id ? 'var(--fg-1)' : 'var(--fg-3)',
              background: 'none', border: 'none', borderBottom: subTab === id ? '2px solid var(--accent-fg)' : '2px solid transparent',
              cursor: 'pointer', marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Conteúdo */}
      {subTab === 'conversoes' && (
        <TabConversoes
          status={status}
          recentes={recentes}
          onAnalyze={handleAnalyze}
          onDetectNow={handleDetectNow}
          loading={loadingRecentes}
          analyzing={analyzing}
          detecting={detecting}
        />
      )}
      {subTab === 'batches' && (
        <TabBatches batches={batches} loading={loadingBatches} />
      )}
      {subTab === 'exemplos' && (
        <TabExemplos
          examples={examples}
          loading={loadingExamples}
          filterStatus={filterStatus}
          onFilterChange={(s) => setFilterStatus(s)}
          onAction={handleExampleAction}
        />
      )}
    </div>
  )
}
