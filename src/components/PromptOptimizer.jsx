import { useState, useEffect, useCallback } from 'react'
import {
  Wand2, RefreshCw, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle, Clock, Copy, Loader, History, FileText, RotateCcw,
  X, Zap, GitCompare,
} from 'lucide-react'
import {
  loadViolationsRanking,
  requestRuleAnalysis,
  loadProposals,
  acceptProposal,
  rejectProposal,
  reanalyzeProposal,
  loadPromptVersions,
  loadPromptVersionById,
  rollbackPromptVersion,
  syncPromptFromFallback,
} from '../lib/iaFeedbackStore'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const styles = {
    pendente: { bg: 'oklch(78% 0.14 75 / 0.15)', color: 'oklch(40% 0.14 75)', border: 'oklch(78% 0.14 75 / 0.35)' },
    aplicada: { bg: 'oklch(72% 0.14 155 / 0.15)', color: 'oklch(35% 0.14 155)', border: 'oklch(72% 0.14 155 / 0.35)' },
    rejeitada: { bg: 'oklch(40% 0.05 265 / 0.10)', color: 'oklch(55% 0.05 265)', border: 'oklch(55% 0.05 265 / 0.35)' },
  }
  const s = styles[status] || styles.pendente
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      textTransform: 'uppercase', letterSpacing: 0.04,
    }}>
      {status === 'pendente' && <Clock size={10} />}
      {status === 'aplicada' && <CheckCircle size={10} />}
      {status === 'rejeitada' && <X size={10} />}
      {status}
    </span>
  )
}

function SevBadge({ sev }) {
  const styles = {
    alta: { bg: 'oklch(68% 0.20 25 / 0.10)', color: 'oklch(40% 0.20 25)', border: 'oklch(68% 0.20 25 / 0.30)' },
    media: { bg: 'oklch(78% 0.14 75 / 0.10)', color: 'oklch(45% 0.14 75)', border: 'oklch(78% 0.14 75 / 0.30)' },
    baixa: { bg: 'oklch(72% 0.10 220 / 0.10)', color: 'oklch(40% 0.10 220)', border: 'oklch(72% 0.10 220 / 0.30)' },
  }
  const s = styles[sev] || styles.baixa
  return (
    <span style={{
      display: 'inline-block', padding: '1px 5px', borderRadius: 3,
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
    }}>
      {sev}
    </span>
  )
}

// ─── Modal conteúdo da versão ─────────────────────────────────────────────────

function VersionContentModal({ versionId, versao, onClose }) {
  const [text, setText] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPromptVersionById(versionId).then((v) => {
      setText(v?.agent_rules_text || '(vazio)')
      setLoading(false)
    }).catch((e) => {
      setText(`Erro: ${e.message}`)
      setLoading(false)
    })
  }, [versionId])

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 24,
    }}>
      <div style={{
        background: 'var(--bg-1)', border: '1px solid var(--line-1)', borderRadius: 14,
        width: '100%', maxWidth: 760, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--line-1)',
        }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--fg-1)' }}>
            Conteúdo da v{versao}
          </span>
          <button onClick={onClose} style={{
            background: 'none', border: '1px solid var(--line-1)', borderRadius: 6,
            padding: '3px 10px', fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer',
          }}>Fechar</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
          {loading
            ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
                <Loader size={14} className="spin" /> Carregando...
              </div>
            : <pre style={{
                margin: 0, fontFamily: 'monospace', fontSize: 11,
                color: 'var(--fg-2)', whiteSpace: 'pre-wrap', lineHeight: 1.6,
              }}>{text}</pre>
          }
        </div>
      </div>
    </div>
  )
}

// ─── Seção 3: Histórico de versões ───────────────────────────────────────────

function VersionHistory({ onVersionActivated }) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [rollingBack, setRollingBack] = useState(null)
  const [viewingVersion, setViewingVersion] = useState(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    loadPromptVersions().then((vs) => {
      setVersions(Array.isArray(vs) ? vs : [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  async function handleRollback(v) {
    if (!confirm(`Reverter para v${v.versao}?\n\nIsso criará uma nova versão com o conteúdo da v${v.versao} e a ativará em produção.`)) return
    setRollingBack(v.id)
    try {
      await rollbackPromptVersion(v.id)
      load()
      onVersionActivated?.()
    } catch (e) {
      alert(`Erro no rollback: ${e.message}`)
    } finally {
      setRollingBack(null)
    }
  }

  return (
    <div style={{ marginTop: 20 }}>
      <button
        onClick={() => setOpen((p) => !p)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 500,
          background: 'var(--bg-2)', border: '1px solid var(--line-1)',
          color: 'var(--fg-2)', cursor: 'pointer', width: '100%',
        }}
      >
        <History size={14} />
        Histórico de versões
        {open ? <ChevronDown size={13} style={{ marginLeft: 'auto' }} /> : <ChevronRight size={13} style={{ marginLeft: 'auto' }} />}
      </button>

      {open && (
        <div style={{ marginTop: 8, border: '1px solid var(--line-1)', borderRadius: 10, overflow: 'hidden' }}>
          {loading
            ? <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)', fontSize: 12 }}>
                <Loader size={13} className="spin" /> Carregando...
              </div>
            : versions.length === 0
              ? <div style={{ padding: 16, color: 'var(--fg-3)', fontSize: 12 }}>Nenhuma versão registrada.</div>
              : versions.map((v, i) => (
                  <div key={v.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    padding: '10px 14px', fontSize: 12,
                    background: v.ativa ? 'oklch(72% 0.14 155 / 0.06)' : 'var(--bg-1)',
                    borderTop: i > 0 ? '1px solid var(--line-1)' : 'none',
                  }}>
                    <span style={{ fontWeight: 700, color: v.ativa ? 'oklch(35% 0.14 155)' : 'var(--fg-1)', minWidth: 36 }}>
                      v{v.versao}
                    </span>
                    {v.ativa && (
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                        background: 'oklch(72% 0.14 155 / 0.18)', color: 'oklch(35% 0.14 155)',
                        border: '1px solid oklch(72% 0.14 155 / 0.35)',
                      }}>ATIVA</span>
                    )}
                    <span style={{ color: 'var(--fg-3)' }}>{fmt(v.activated_at || v.created_at)}</span>
                    {v.diff_resumo && (
                      <span style={{ color: 'var(--fg-2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        · {v.diff_resumo}
                      </span>
                    )}
                    <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{v.created_by}</span>
                    <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
                      <button
                        onClick={() => setViewingVersion(v)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '3px 8px', borderRadius: 6, fontSize: 11,
                          background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                          color: 'var(--fg-2)', cursor: 'pointer',
                        }}
                      >
                        <FileText size={10} /> Ver conteúdo
                      </button>
                      {!v.ativa && (
                        <button
                          onClick={() => handleRollback(v)}
                          disabled={rollingBack === v.id}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 8px', borderRadius: 6, fontSize: 11,
                            background: 'oklch(68% 0.20 25 / 0.10)', border: '1px solid oklch(68% 0.20 25 / 0.30)',
                            color: 'oklch(40% 0.20 25)', cursor: rollingBack === v.id ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {rollingBack === v.id ? <Loader size={10} className="spin" /> : <RotateCcw size={10} />}
                          Ativar esta versão
                        </button>
                      )}
                    </div>
                  </div>
                ))
          }
        </div>
      )}

      {viewingVersion && (
        <VersionContentModal
          versionId={viewingVersion.id}
          versao={viewingVersion.versao}
          onClose={() => setViewingVersion(null)}
        />
      )}
    </div>
  )
}

// ─── Card de proposta ─────────────────────────────────────────────────────────

function ProposalCard({ proposal, onAccepted, onRejected }) {
  const [accepting, setAccepting] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [showReanalyzeBox, setShowReanalyzeBox] = useState(false)
  const [instrucaoExtra, setInstrucaoExtra] = useState('')
  const [exemploOpen, setExemploOpen] = useState(false)
  const [error, setError] = useState(null)

  const exemplos = Array.isArray(proposal.exemplos_violacoes) ? proposal.exemplos_violacoes : []

  async function handleAccept() {
    setError(null)
    setAccepting(true)
    try {
      const result = await acceptProposal(proposal.id)
      onAccepted?.(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setAccepting(false)
    }
  }

  async function handleReject() {
    setError(null)
    setRejecting(true)
    try {
      await rejectProposal(proposal.id)
      onRejected?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setRejecting(false)
    }
  }

  async function handleReanalyze() {
    if (!instrucaoExtra.trim()) {
      setError('Escreva uma instrução explicando o que estava errado na proposta atual.')
      return
    }
    setError(null)
    setReanalyzing(true)
    try {
      await reanalyzeProposal(proposal.id, instrucaoExtra.trim())
      onRejected?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setReanalyzing(false)
    }
  }

  return (
    <div style={{
      borderRadius: 12, border: `1px solid ${proposal.status === 'pendente' ? 'var(--accent-line)' : 'var(--line-1)'}`,
      background: 'var(--bg-2)', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px', borderBottom: '1px solid var(--line-1)',
      }}>
        <Wand2 size={14} style={{ color: 'var(--accent-fg)', flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--fg-1)' }}>
          Proposta para {proposal.regra_alvo}
        </span>
        <StatusBadge status={proposal.status} />
        <span style={{ fontSize: 11, color: 'var(--fg-3)', marginLeft: 'auto' }}>{fmt(proposal.created_at)}</span>
        <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>· {proposal.modelo_analisador}</span>
        <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>· {proposal.total_violacoes} violações</span>
      </div>

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Diff */}
        {proposal.tipo_mudanca !== 'nenhuma' ? (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 6 }}>
              Mudança — {proposal.tipo_mudanca}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'oklch(40% 0.20 25)', marginBottom: 4, textTransform: 'uppercase' }}>
                  Antes
                </div>
                <pre style={{
                  margin: 0, padding: '10px 12px', borderRadius: 8,
                  background: 'oklch(68% 0.20 25 / 0.08)', border: '1px solid oklch(68% 0.20 25 / 0.25)',
                  fontFamily: 'monospace', fontSize: 11, color: 'var(--fg-1)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
                  maxHeight: 220, overflowY: 'auto',
                }}>
                  {proposal.trecho_antes || '(vazio)'}
                </pre>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'oklch(35% 0.14 155)', marginBottom: 4, textTransform: 'uppercase' }}>
                  Depois
                </div>
                <pre style={{
                  margin: 0, padding: '10px 12px', borderRadius: 8,
                  background: 'oklch(72% 0.14 155 / 0.08)', border: '1px solid oklch(72% 0.14 155 / 0.25)',
                  fontFamily: 'monospace', fontSize: 11, color: 'var(--fg-1)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
                  maxHeight: 220, overflowY: 'auto',
                }}>
                  {proposal.trecho_depois || '(remoção sem substituição)'}
                </pre>
              </div>
            </div>
          </div>
        ) : (
          <div style={{
            padding: '10px 12px', borderRadius: 8, fontSize: 12, color: 'var(--fg-2)',
            background: 'var(--bg-1)', border: '1px solid var(--line-1)',
          }}>
            <span style={{ fontWeight: 600, color: 'var(--fg-3)' }}>Tipo: nenhuma mudança proposta. </span>
            {proposal.justificativa}
          </div>
        )}

        {/* Justificativa */}
        {proposal.tipo_mudanca !== 'nenhuma' && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 4 }}>
              Justificativa
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              {proposal.justificativa}
            </div>
          </div>
        )}

        {/* Conflitos */}
        {proposal.conflitos_potenciais && (
          <div style={{
            display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 8,
            background: 'oklch(78% 0.14 75 / 0.10)', border: '1px solid oklch(78% 0.14 75 / 0.30)',
          }}>
            <AlertTriangle size={14} style={{ color: 'oklch(40% 0.14 75)', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12, color: 'oklch(35% 0.14 75)', lineHeight: 1.5 }}>
              <strong>Conflito potencial:</strong> {proposal.conflitos_potenciais}
            </div>
          </div>
        )}

        {/* Exemplos collapsible */}
        {exemplos.length > 0 && (
          <div>
            <button
              onClick={() => setExemploOpen((p) => !p)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, background: 'none',
                border: 'none', padding: 0, cursor: 'pointer', fontSize: 11,
                fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase',
              }}
            >
              {exemploOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {exemplos.length} exemplos de violações
            </button>
            {exemploOpen && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {exemplos.map((ex, i) => (
                  <div key={i} style={{
                    padding: '8px 10px', borderRadius: 7,
                    background: 'var(--bg-1)', border: '1px solid var(--line-1)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <SevBadge sev={ex.severidade} />
                      {ex.execution_id && (
                        <span style={{
                          fontFamily: 'monospace', fontSize: 10, color: 'var(--fg-3)',
                          padding: '1px 5px', background: 'var(--bg-2)', borderRadius: 3,
                        }}>
                          {ex.execution_id}
                        </span>
                      )}
                      {ex.execution_id && (
                        <button
                          onClick={() => navigator.clipboard?.writeText(ex.execution_id)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 2, display: 'flex' }}
                          title="Copiar ID"
                        >
                          <Copy size={10} />
                        </button>
                      )}
                    </div>
                    {ex.citacao && (
                      <div style={{
                        fontSize: 11, color: 'var(--fg-3)', fontStyle: 'italic',
                        padding: '4px 8px', background: 'var(--bg-2)', borderRadius: 4,
                        borderLeft: '2px solid var(--line-2)', marginBottom: 4,
                      }}>
                        "{ex.citacao}"
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--fg-2)' }}>{ex.descricao}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Status info */}
        {proposal.status === 'aplicada' && (
          <div style={{ fontSize: 12, color: 'oklch(35% 0.14 155)', fontWeight: 500 }}>
            <CheckCircle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Aplicada em {fmt(proposal.applied_at)}
            {proposal.resultado_versao_id && ' · nova versão criada'}
          </div>
        )}
        {proposal.status === 'rejeitada' && (
          <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            Rejeitada em {fmt(proposal.rejected_at)}
          </div>
        )}

        {/* Erro inline */}
        {error && (
          <div style={{
            padding: '8px 12px', borderRadius: 7, fontSize: 12,
            background: 'oklch(68% 0.20 25 / 0.10)', border: '1px solid oklch(68% 0.20 25 / 0.30)',
            color: 'oklch(40% 0.20 25)',
          }}>
            {error}
          </div>
        )}

        {/* Ações */}
        {proposal.status === 'pendente' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={handleAccept}
                disabled={accepting || rejecting || reanalyzing}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: accepting ? 'var(--bg-2)' : 'oklch(72% 0.14 155 / 0.18)',
                  border: '1px solid oklch(72% 0.14 155 / 0.40)',
                  color: 'oklch(35% 0.14 155)',
                  cursor: accepting || rejecting || reanalyzing ? 'not-allowed' : 'pointer',
                }}
              >
                {accepting ? <Loader size={12} className="spin" /> : <CheckCircle size={12} />}
                Aceitar e aplicar
              </button>
              <button
                onClick={handleReject}
                disabled={accepting || rejecting || reanalyzing}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                  background: 'var(--bg-1)', border: '1px solid var(--line-1)',
                  color: 'var(--fg-3)',
                  cursor: accepting || rejecting || reanalyzing ? 'not-allowed' : 'pointer',
                }}
              >
                {rejecting ? <Loader size={12} className="spin" /> : <X size={12} />}
                Rejeitar
              </button>
              <button
                onClick={() => setShowReanalyzeBox((p) => !p)}
                disabled={accepting || rejecting || reanalyzing}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                  background: 'oklch(78% 0.14 75 / 0.12)', border: '1px solid oklch(78% 0.14 75 / 0.35)',
                  color: 'oklch(40% 0.14 75)',
                  cursor: accepting || rejecting || reanalyzing ? 'not-allowed' : 'pointer',
                }}
              >
                <Wand2 size={12} />
                {showReanalyzeBox ? 'Cancelar reanálise' : 'Rejeitar e reanalisar com dica'}
              </button>
            </div>
            {showReanalyzeBox && (
              <div style={{
                padding: 10, borderRadius: 8,
                background: 'oklch(78% 0.14 75 / 0.06)', border: '1px solid oklch(78% 0.14 75 / 0.25)',
                display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  Explique o que estava errado na proposta atual. Ex.: "O problema é do subitem 13c (a IA ofereceu grade sem ter), não do 13d." O analisador vai usar essa dica + a conversa completa pra refazer a proposta.
                </div>
                <textarea
                  value={instrucaoExtra}
                  onChange={(e) => setInstrucaoExtra(e.target.value)}
                  placeholder="Sua dica..."
                  rows={3}
                  style={{
                    width: '100%', padding: 8, borderRadius: 6,
                    background: 'var(--bg-1)', border: '1px solid var(--line-1)',
                    color: 'var(--fg-1)', fontSize: 12, fontFamily: 'inherit', resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
                <button
                  onClick={handleReanalyze}
                  disabled={reanalyzing || !instrucaoExtra.trim()}
                  style={{
                    alignSelf: 'flex-start',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                    background: 'oklch(78% 0.14 75 / 0.20)', border: '1px solid oklch(78% 0.14 75 / 0.45)',
                    color: 'oklch(35% 0.14 75)',
                    cursor: reanalyzing || !instrucaoExtra.trim() ? 'not-allowed' : 'pointer',
                    opacity: reanalyzing ? 0.6 : 1,
                  }}
                >
                  {reanalyzing ? <Loader size={11} className="spin" /> : <Wand2 size={11} />}
                  {reanalyzing ? 'Reanalisando...' : 'Gerar nova proposta'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Seção 1: Ranking de violações ───────────────────────────────────────────

function ViolationsRanking({ onAnalyzeComplete }) {
  const [ranking, setRanking] = useState(null)
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(null)
  const [expandedRegra, setExpandedRegra] = useState(null)
  const [error, setError] = useState(null)
  const [analyzeError, setAnalyzeError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await loadViolationsRanking()
      setRanking(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleAnalyze(regra) {
    setAnalyzeError(null)
    setAnalyzing(regra)
    try {
      await requestRuleAnalysis(regra)
      onAnalyzeComplete?.()
    } catch (e) {
      setAnalyzeError(`Erro ao analisar ${regra}: ${e.message}`)
    } finally {
      setAnalyzing(null)
    }
  }

  return (
    <div style={{
      padding: '16px 18px', borderRadius: 12,
      background: 'var(--bg-2)', border: '1px solid var(--line-1)', marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-1)' }}>
          Ranking de violações na janela atual
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', borderRadius: 8, fontSize: 11,
            background: 'var(--bg-1)', border: '1px solid var(--line-1)',
            color: 'var(--fg-2)', cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          <RefreshCw size={11} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          Atualizar ranking
        </button>
      </div>

      {ranking && (
        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 12 }}>
          Janela: {fmt(ranking.janela_de)} → {fmt(ranking.janela_ate)} · {ranking.total_avaliacoes} avaliações · v{ranking.versao_ativa?.versao}
        </div>
      )}

      {error && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, fontSize: 12,
          background: 'oklch(68% 0.20 25 / 0.08)', border: '1px solid oklch(68% 0.20 25 / 0.25)',
          color: 'oklch(40% 0.20 25)', marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {analyzeError && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, fontSize: 12,
          background: 'oklch(68% 0.20 25 / 0.08)', border: '1px solid oklch(68% 0.20 25 / 0.25)',
          color: 'oklch(40% 0.20 25)', marginBottom: 12,
        }}>
          {analyzeError}
        </div>
      )}

      {loading && !ranking && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)', fontSize: 12 }}>
          <Loader size={13} className="spin" /> Carregando...
        </div>
      )}

      {ranking && ranking.ranking.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--fg-3)', padding: '12px 0' }}>
          Nenhuma violação encontrada na janela atual.
        </div>
      )}

      {ranking && ranking.ranking.length > 0 && (
        <div style={{ border: '1px solid var(--line-1)', borderRadius: 10, overflow: 'hidden' }}>
          {/* Header da tabela */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 80px 160px auto',
            padding: '8px 14px', background: 'var(--bg-1)',
            borderBottom: '1px solid var(--line-1)',
            fontSize: 10, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0.04,
          }}>
            <span>Regra</span>
            <span>Violações</span>
            <span>Alta / Média / Baixa</span>
            <span>Ações</span>
          </div>

          {ranking.ranking.map((item, i) => (
            <div key={item.regra} style={{ borderTop: i > 0 ? '1px solid var(--line-1)' : 'none' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 80px 160px auto',
                alignItems: 'center', padding: '10px 14px',
                background: expandedRegra === item.regra ? 'oklch(60% 0.10 265 / 0.05)' : 'transparent',
              }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>{item.regra}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
                  {item.count}
                </span>
                <span style={{ fontSize: 12, color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: 'oklch(40% 0.20 25)', fontWeight: 600 }}>{item.severidades.alta}</span>
                  {' / '}
                  <span style={{ color: 'oklch(45% 0.14 75)', fontWeight: 600 }}>{item.severidades.media}</span>
                  {' / '}
                  <span style={{ color: 'oklch(40% 0.10 220)' }}>{item.severidades.baixa}</span>
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => setExpandedRegra(expandedRegra === item.regra ? null : item.regra)}
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11,
                      background: 'var(--bg-1)', border: '1px solid var(--line-1)',
                      color: 'var(--fg-2)', cursor: 'pointer',
                    }}
                  >
                    {expandedRegra === item.regra ? 'Ocultar' : 'Ver exemplos'}
                  </button>
                  <button
                    onClick={() => handleAnalyze(item.regra)}
                    disabled={analyzing === item.regra}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                      background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
                      color: 'var(--accent-fg)', cursor: analyzing === item.regra ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {analyzing === item.regra ? <Loader size={10} className="spin" /> : <Zap size={10} />}
                    {analyzing === item.regra ? 'Analisando...' : 'Analisar'}
                  </button>
                </div>
              </div>

              {expandedRegra === item.regra && item.exemplos.length > 0 && (
                <div style={{ padding: '10px 14px', background: 'var(--bg-1)', borderTop: '1px solid var(--line-1)' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 8 }}>
                    Exemplos
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {item.exemplos.map((ex, ei) => (
                      <div key={ei} style={{
                        padding: '8px 10px', borderRadius: 7,
                        background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <SevBadge sev={ex.severidade} />
                          {ex.execution_id && (
                            <>
                              <span style={{
                                fontFamily: 'monospace', fontSize: 10, color: 'var(--fg-3)',
                                padding: '1px 5px', background: 'var(--bg-1)', borderRadius: 3,
                              }}>
                                {ex.execution_id}
                              </span>
                              <button
                                onClick={() => navigator.clipboard?.writeText(ex.execution_id)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 2, display: 'flex' }}
                                title="Copiar ID"
                              >
                                <Copy size={10} />
                              </button>
                            </>
                          )}
                          <span style={{ fontSize: 10, color: 'var(--fg-3)', marginLeft: 'auto' }}>{fmt(ex.created_at)}</span>
                        </div>
                        {ex.citacao && (
                          <div style={{
                            fontSize: 11, color: 'var(--fg-3)', fontStyle: 'italic',
                            padding: '4px 8px', background: 'var(--bg-2)', borderRadius: 4,
                            borderLeft: '2px solid var(--line-2)', marginBottom: 4,
                          }}>
                            "{ex.citacao}"
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--fg-2)' }}>{ex.descricao}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Seção 2: Propostas ───────────────────────────────────────────────────────

function ProposalsSection({ refreshKey }) {
  const [proposals, setProposals] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('pendente')
  const [error, setError] = useState(null)

  const load = useCallback((status) => {
    setLoading(true)
    setError(null)
    loadProposals(status || undefined).then((rows) => {
      setProposals(Array.isArray(rows) ? rows : [])
      setLoading(false)
    }).catch((e) => {
      setError(e.message)
      setLoading(false)
    })
  }, [])

  useEffect(() => { load(filterStatus) }, [filterStatus, refreshKey, load])

  function handleStatusChange(s) {
    setFilterStatus(s)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-1)' }}>Propostas</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['pendente', 'aplicada', 'rejeitada', ''].map((s) => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              style={{
                padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 500,
                background: filterStatus === s ? 'var(--accent-soft)' : 'var(--bg-2)',
                border: filterStatus === s ? '1px solid var(--accent-line)' : '1px solid var(--line-1)',
                color: filterStatus === s ? 'var(--accent-fg)' : 'var(--fg-3)',
                cursor: 'pointer',
              }}
            >
              {s === '' ? 'Todas' : s}
            </button>
          ))}
          <button
            onClick={() => load(filterStatus)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 8, fontSize: 11,
              background: 'var(--bg-2)', border: '1px solid var(--line-1)',
              color: 'var(--fg-2)', cursor: 'pointer',
            }}
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, fontSize: 12, marginBottom: 12,
          background: 'oklch(68% 0.20 25 / 0.08)', border: '1px solid oklch(68% 0.20 25 / 0.25)',
          color: 'oklch(40% 0.20 25)',
        }}>
          {error}
        </div>
      )}

      {loading
        ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)', fontSize: 12, padding: '16px 0' }}>
            <Loader size={13} className="spin" /> Carregando propostas...
          </div>
        : proposals.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--fg-3)', padding: '16px 0' }}>
              Nenhuma proposta {filterStatus ? `com status "${filterStatus}"` : ''}.
            </div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {proposals.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  onAccepted={() => load(filterStatus)}
                  onRejected={() => load(filterStatus)}
                />
              ))}
            </div>
          )
      }
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PromptOptimizer() {
  const [activeVersionInfo, setActiveVersionInfo] = useState(null)
  const [loadingVersion, setLoadingVersion] = useState(true)
  const [proposalRefreshKey, setProposalRefreshKey] = useState(0)
  const [syncing, setSyncing] = useState(false)

  const loadVersion = useCallback(() => {
    setLoadingVersion(true)
    loadPromptVersions().then((vs) => {
      const active = Array.isArray(vs) ? vs.find((v) => v.ativa) : null
      setActiveVersionInfo(active || null)
      setLoadingVersion(false)
    }).catch(() => setLoadingVersion(false))
  }, [])

  useEffect(() => { loadVersion() }, [loadVersion])

  function handleAnalyzeComplete() {
    setProposalRefreshKey((k) => k + 1)
  }

  async function handleSyncFromFallback() {
    if (!confirm('Criar nova versão ativa a partir do FALLBACK_AGENT_RULES_TEXT do código? Use isso quando o texto hardcoded foi atualizado e você quer aplicar em produção.')) return
    setSyncing(true)
    try {
      const result = await syncPromptFromFallback()
      loadVersion()
      alert(`Versão v${result.new_version?.versao} criada e ativada.`)
    } catch (err) {
      alert(err.message)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div>
      {/* Header — versão ativa */}
      <div style={{
        padding: '14px 18px', borderRadius: 12, marginBottom: 20,
        background: 'oklch(72% 0.14 155 / 0.07)', border: '1px solid oklch(72% 0.14 155 / 0.25)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'oklch(35% 0.14 155)', textTransform: 'uppercase', marginBottom: 4 }}>
            Versão ativa do prompt
          </div>
          {loadingVersion
            ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg-3)', fontSize: 12 }}>
                <Loader size={12} className="spin" /> Carregando...
              </div>
            : activeVersionInfo
              ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
                    v{activeVersionInfo.versao}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                    ativada em {fmt(activeVersionInfo.activated_at || activeVersionInfo.created_at)}
                  </span>
                  {activeVersionInfo.diff_resumo && (
                    <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>· {activeVersionInfo.diff_resumo}</span>
                  )}
                </div>
              )
              : <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Nenhuma versão ativa. Execute o seed no Supabase.</span>
          }
        </div>
        <button
          onClick={handleSyncFromFallback}
          disabled={syncing}
          title="Criar nova versão ativa a partir do fallback hardcoded no código"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', borderRadius: 8, border: '1px solid oklch(72% 0.14 155 / 0.35)',
            background: 'oklch(72% 0.14 155 / 0.10)', color: 'oklch(35% 0.14 155)',
            fontSize: 12, fontWeight: 500, cursor: syncing ? 'default' : 'pointer',
            opacity: syncing ? 0.6 : 1, whiteSpace: 'nowrap',
          }}
        >
          {syncing ? <Loader size={13} className="spin" /> : <GitCompare size={13} />}
          Sincronizar do código
        </button>
      </div>

      {/* Seção 1: Ranking */}
      <ViolationsRanking onAnalyzeComplete={handleAnalyzeComplete} />

      {/* Seção 2: Propostas */}
      <ProposalsSection refreshKey={proposalRefreshKey} />

      {/* Seção 3: Histórico de versões */}
      <VersionHistory onVersionActivated={loadVersion} />
    </div>
  )
}
