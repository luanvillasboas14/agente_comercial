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
  loadAnalyzerStatus,
  loadAprendizadoProposals,
  applyProposal,
  rejectProposal,
  loadProposalsDiagnostic,
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

// ─── Sub-tab Propostas de regras ──────────────────────────────────────────────

function ProposalCard({ proposal, onApply, onReject, busy }) {
  const [expanded, setExpanded] = useState(false)
  const isAdicao = !proposal.trecho_antes || proposal.trecho_antes.trim() === ''

  return (
    <div className="card" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>{proposal.regra_alvo}</span>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              padding: '2px 7px', borderRadius: 4,
              background: isAdicao ? 'oklch(72% 0.14 155 / 0.15)' : 'oklch(78% 0.14 75 / 0.15)',
              color: isAdicao ? 'oklch(35% 0.14 155)' : 'oklch(40% 0.14 75)',
            }}>
              {isAdicao ? 'adição' : 'ajuste'}
            </span>
            {proposal.origem === 'aprendizado_positivo' ? (
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                padding: '2px 7px', borderRadius: 4,
                background: '#8b5cf622', color: '#8b5cf6',
              }}>
                aprendizado
              </span>
            ) : (
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                padding: '2px 7px', borderRadius: 4,
                background: 'oklch(68% 0.20 25 / 0.15)', color: 'oklch(40% 0.20 25)',
              }}>
                feedback
              </span>
            )}
            {proposal.support_count != null && (
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>· apoio: {proposal.support_count} conversas</span>
            )}
            {proposal.total_violacoes > 0 && (
              <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>· {proposal.total_violacoes} violações</span>
            )}
            {proposal.obsoleta && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'oklch(40% 0.20 25)', padding: '2px 7px', borderRadius: 4, background: 'oklch(68% 0.20 25 / 0.15)' }}>
                OBSOLETA
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>{proposal.justificativa}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={() => setExpanded((v) => !v)} style={{ fontSize: 11 }}>
            {expanded ? 'Ocultar' : 'Ver diff'}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onApply(proposal.id)}
            disabled={busy || proposal.obsoleta}
            style={{ fontSize: 11 }}
            title={proposal.obsoleta ? 'Proposta desatualizada — rejeite e refaça análise' : 'Aplica como nova versão do prompt'}
          >
            Aplicar
          </button>
          <button className="btn btn-sm" onClick={() => onReject(proposal.id)} disabled={busy} style={{ fontSize: 11 }}>
            Rejeitar
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          {!isAdicao && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', marginBottom: 4 }}>TRECHO ANTES</div>
              <pre style={{
                padding: 10, borderRadius: 6, background: 'oklch(68% 0.20 25 / 0.08)',
                border: '1px solid oklch(68% 0.20 25 / 0.25)', color: 'var(--fg-1)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 12,
              }}>{proposal.trecho_antes}</pre>
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', marginBottom: 4 }}>
              {isAdicao ? 'NOVO TEXTO A ADICIONAR' : 'TRECHO DEPOIS'}
            </div>
            <pre style={{
              padding: 10, borderRadius: 6, background: 'oklch(72% 0.14 155 / 0.08)',
              border: '1px solid oklch(72% 0.14 155 / 0.25)', color: 'var(--fg-1)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 12,
            }}>{proposal.trecho_depois}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

function TabPropostas({ proposals, loading, onApply, onReject, onRefresh, busyId }) {
  const [diag, setDiag] = useState(null)
  const [diagLoading, setDiagLoading] = useState(false)

  async function runDiag() {
    setDiagLoading(true)
    try { setDiag(await loadProposalsDiagnostic()) } catch (e) { setDiag({ error: e.message }) }
    setDiagLoading(false)
  }

  if (loading) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>Carregando propostas...</div>
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>
          {proposals.length} proposta(s) pendente(s) ·{' '}
          <span style={{ color: '#8b5cf6' }}>{proposals.filter((p) => p.origem === 'aprendizado_positivo').length} do aprendizado</span>
          {' · '}
          <span style={{ color: 'oklch(40% 0.20 25)' }}>{proposals.filter((p) => p.origem !== 'aprendizado_positivo').length} do feedback</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={runDiag} style={{ fontSize: 12 }} disabled={diagLoading}>
            {diagLoading ? 'Diagnosticando...' : 'Diagnóstico'}
          </button>
          <button className="btn btn-sm" onClick={onRefresh} style={{ fontSize: 12 }}>Atualizar</button>
        </div>
      </div>

      {diag && (
        <div className="card" style={{ padding: 12, marginBottom: 14, fontSize: 12, fontFamily: 'ui-monospace,monospace' }}>
          {diag.error ? (
            <div style={{ color: 'oklch(40% 0.20 25)' }}>Erro: {diag.error}</div>
          ) : (
            <>
              <div><b>Total no banco (últimas 100):</b> {diag.total}</div>
              <div><b>Por status:</b> {JSON.stringify(diag.porStatus)}</div>
              <div><b>Por origem:</b> {JSON.stringify(diag.porOrigem)}</div>
              <div><b>Última criada:</b> {diag.ultimaCriada || '-'}</div>
              <div><b>Última de aprendizado:</b> {diag.ultimaAprendizado || '-'}</div>
              {diag.amostra?.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <b>Amostra (3 mais recentes):</b>
                  <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                    {diag.amostra.map((p) => (
                      <li key={p.id}>[{p.status}] {p.origem || 'sem origem'} — {p.regra_alvo} ({p.created_at?.slice(0, 16)})</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {proposals.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
          Nenhuma proposta pendente. Rode "Analisar batch agora" na aba "Conversões pendentes" para gerar propostas a partir das conversas convertidas, ou aguarde o Otimizador de Prompt gerar propostas a partir das violações detectadas.
        </div>
      ) : (
        proposals.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            onApply={onApply}
            onReject={onReject}
            busy={busyId === p.id}
          />
        ))
      )}
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
  const [proposals, setProposals] = useState([])
  const [busyProposalId, setBusyProposalId] = useState(null)

  const [loadingStatus, setLoadingStatus] = useState(true)
  const [loadingRecentes, setLoadingRecentes] = useState(true)
  const [loadingBatches, setLoadingBatches] = useState(true)
  const [loadingExamples, setLoadingExamples] = useState(true)
  const [loadingProposals, setLoadingProposals] = useState(true)

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

  const fetchProposals = useCallback(async () => {
    setLoadingProposals(true)
    try { setProposals(await loadAprendizadoProposals()) } catch (_) {}
    setLoadingProposals(false)
  }, [])

  useEffect(() => {
    fetchStatus()
    fetchRecentes()
    fetchBatches()
    fetchProposals()
  }, [fetchStatus, fetchRecentes, fetchBatches, fetchProposals])

  useEffect(() => { fetchExamples() }, [fetchExamples])

  usePollingWhenVisible(() => {
    fetchStatus()
    if (subTab === 'conversoes') fetchRecentes()
    if (subTab === 'batches') fetchBatches()
    if (subTab === 'exemplos') fetchExamples()
    if (subTab === 'propostas') fetchProposals()
  }, 60_000)

  async function handleApplyProposal(id) {
    setError(null)
    setSuccessMsg(null)
    setBusyProposalId(id)
    try {
      const result = await applyProposal(id)
      setSuccessMsg(`✓ Proposta aplicada — nova versão do prompt: v${result?.new_version?.versao ?? '?'}`)
      fetchProposals()
    } catch (e) {
      setError(`Falha ao aplicar: ${e.message}`)
    }
    setBusyProposalId(null)
  }

  async function handleRejectProposal(id) {
    setError(null)
    setSuccessMsg(null)
    setBusyProposalId(id)
    try {
      await rejectProposal(id)
      setSuccessMsg('Proposta rejeitada.')
      fetchProposals()
    } catch (e) {
      setError(`Falha ao rejeitar: ${e.message}`)
    }
    setBusyProposalId(null)
  }

  async function handleAnalyze() {
    setError(null)
    setSuccessMsg(null)
    setAnalyzing(true)
    try {
      await triggerBatchAnalysis()
      setSuccessMsg('Análise iniciada. Acompanhando progresso...')
      pollAnalyzerUntilDone()
    } catch (e) {
      setError(e.message)
      setAnalyzing(false)
    }
  }

  async function pollAnalyzerUntilDone() {
    const triggerTs = Date.now()
    await new Promise((r) => setTimeout(r, 1500))
    const pollInterval = 4000
    const maxWaitMs = 20 * 60 * 1000
    const startedAt = Date.now()

    while (Date.now() - startedAt < maxWaitMs) {
      let st
      try {
        st = await loadAnalyzerStatus()
      } catch {
        await new Promise((r) => setTimeout(r, pollInterval))
        continue
      }

      if (st.running) {
        const elapsedSec = st.startedAt
          ? Math.round((Date.now() - new Date(st.startedAt).getTime()) / 1000)
          : 0
        setSuccessMsg(`Analisando batch no o3-mini... ${elapsedSec}s (pode levar alguns minutos)`)
      } else if (st.lastResult && new Date(st.lastResult.finishedAt).getTime() >= triggerTs) {
        const r = st.lastResult
        const dur = Math.round((r.durationMs || 0) / 1000)
        if (r.ok) {
          setSuccessMsg(
            `✓ Análise concluída em ${dur}s · Regras: ${r.regrasGeradas ?? 0} · Exemplos: ${r.exemplosGerados ?? 0} (de ${r.totalLeads ?? '?'} conversas)`,
          )
          fetchStatus()
          fetchRecentes()
          fetchBatches()
        } else {
          const detail = r.reason
            ? `${r.reason}${r.pendentes != null ? ` (pendentes ${r.pendentes}/${r.min})` : ''}`
            : (r.error || 'erro desconhecido')
          setError(`Análise falhou: ${detail} (após ${dur}s)`)
        }
        setAnalyzing(false)
        return
      }
      await new Promise((r) => setTimeout(r, pollInterval))
    }
    setError('Timeout: análise excedeu 20min sem retornar status.')
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
    { id: 'propostas', label: `Propostas de regras${proposals.length > 0 ? ` (${proposals.length})` : ''}` },
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
      {subTab === 'propostas' && (
        <TabPropostas
          proposals={proposals}
          loading={loadingProposals}
          onApply={handleApplyProposal}
          onReject={handleRejectProposal}
          onRefresh={fetchProposals}
          busyId={busyProposalId}
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
