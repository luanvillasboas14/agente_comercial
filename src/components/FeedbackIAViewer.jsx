import { useState, useEffect, useCallback } from 'react'
import {
  ShieldCheck, RefreshCw, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle, Clock, MessageSquare,
  Bot, ListChecks, Search, Loader,
} from 'lucide-react'
import {
  loadAvaliacoes,
  loadAvaliacao,
  loadPendentes,
  loadRuns,
  loadStatus,
} from '../lib/iaFeedbackStore'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatDuration(ms) {
  if (!ms) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function VeredictoBadge({ veredito }) {
  const styles = {
    aprovado: { background: 'oklch(72% 0.14 155 / 0.15)', color: 'oklch(40% 0.14 155)', border: 'oklch(72% 0.14 155 / 0.35)' },
    parcial: { background: 'oklch(78% 0.14 75 / 0.15)', color: 'oklch(45% 0.14 75)', border: 'oklch(78% 0.14 75 / 0.35)' },
    reprovado: { background: 'oklch(68% 0.20 25 / 0.15)', color: 'oklch(40% 0.20 25)', border: 'oklch(68% 0.20 25 / 0.35)' },
  }
  const s = styles[veredito] || { background: 'var(--bg-2)', color: 'var(--fg-3)', border: 'var(--line-1)' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: s.background, color: s.color, border: `1px solid ${s.border}`,
      textTransform: 'uppercase', letterSpacing: 0.04,
    }}>
      {veredito === 'aprovado' && <CheckCircle size={10} />}
      {veredito === 'parcial' && <AlertTriangle size={10} />}
      {veredito === 'reprovado' && <AlertTriangle size={10} />}
      {veredito || '-'}
    </span>
  )
}

function SeveridadeBadge({ severidade }) {
  const styles = {
    alta: { background: 'oklch(68% 0.20 25 / 0.12)', color: 'oklch(40% 0.20 25)', border: 'oklch(68% 0.20 25 / 0.30)' },
    media: { background: 'oklch(78% 0.14 75 / 0.12)', color: 'oklch(45% 0.14 75)', border: 'oklch(78% 0.14 75 / 0.30)' },
    baixa: { background: 'oklch(72% 0.10 220 / 0.12)', color: 'oklch(40% 0.10 220)', border: 'oklch(72% 0.10 220 / 0.30)' },
  }
  const s = styles[severidade] || styles.baixa
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 4,
      fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
      background: s.background, color: s.color, border: `1px solid ${s.border}`,
    }}>
      {severidade}
    </span>
  )
}

function KPICard({ icon: Icon, label, value, hint, tone }) {
  const tones = {
    success: { color: 'var(--success)', border: 'oklch(72% 0.14 155 / 0.25)', bg: 'var(--success-soft)' },
    warning: { color: 'var(--warn)', border: 'oklch(78% 0.14 75 / 0.25)', bg: 'var(--warn-soft)' },
    danger: { color: 'var(--danger)', border: 'oklch(68% 0.20 25 / 0.25)', bg: 'var(--danger-soft)' },
    info: { color: 'var(--accent-fg)', border: 'var(--accent-line)', bg: 'var(--accent-soft)' },
    muted: { color: 'var(--fg-3)', border: 'var(--line-1)', bg: 'var(--bg-2)' },
  }
  const s = tones[tone] || tones.muted
  return (
    <div style={{
      flex: 1, minWidth: 160, padding: '10px 14px', borderRadius: 10,
      background: s.bg, border: `1px solid ${s.border}`,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
        background: 'var(--bg-2)', color: s.color, border: `1px solid ${s.border}`, flexShrink: 0,
      }}>
        <Icon size={16} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fg-3)', letterSpacing: 0.04, textTransform: 'uppercase' }}>{label}</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-1)', marginTop: 2, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{value}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>{hint}</div>}
      </div>
    </div>
  )
}

function AvaliacaoDetail({ id, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadAvaliacao(id).then((d) => {
      setData(d)
      setLoading(false)
    })
  }, [id])

  if (loading) {
    return (
      <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
        <Loader size={14} className="spin" /> Carregando...
      </div>
    )
  }

  if (!data) {
    return <div style={{ padding: 24, color: 'var(--fg-3)' }}>Não encontrado.</div>
  }

  const violacoes = Array.isArray(data.violacoes) ? data.violacoes : []
  const pontosPositivos = Array.isArray(data.pontos_positivos) ? data.pontos_positivos : []
  const mensagens = Array.isArray(data.conversa_completa) ? data.conversa_completa : []

  return (
    <div style={{ padding: '16px 20px' }}>
      {/* Cabeçalho */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VeredictoBadge veredito={data.veredito} />
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--fg-1)' }}>
            {data.nota_geral != null ? `${Number(data.nota_geral).toFixed(1)}` : '-'}
            <span style={{ fontSize: 12, color: 'var(--fg-3)', fontWeight: 400 }}>/10</span>
          </span>
          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Lead #{data.lead_id}</span>
          {data.telefone && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>· {data.telefone}</span>}
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: '1px solid var(--line-1)', borderRadius: 6,
          padding: '4px 10px', fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer',
        }}>Fechar</button>
      </div>

      {/* Resumo */}
      {data.resumo_avaliacao && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, background: 'var(--bg-2)',
          border: '1px solid var(--line-1)', marginBottom: 16, fontSize: 13, color: 'var(--fg-2)',
        }}>
          {data.resumo_avaliacao}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Violações */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 8 }}>
            Violações ({violacoes.length})
          </div>
          {violacoes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--fg-3)', fontStyle: 'italic' }}>Nenhuma violação detectada.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {violacoes.map((v, i) => (
                <div key={i} style={{
                  padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <SeveridadeBadge severidade={v.severidade} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-1)' }}>{v.regra} — {v.titulo}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}>{v.descricao}</div>
                  {v.citacao && (
                    <div style={{
                      fontSize: 11, color: 'var(--fg-3)', fontStyle: 'italic',
                      padding: '4px 8px', background: 'var(--bg-1)', borderRadius: 4,
                      borderLeft: '2px solid var(--line-2)',
                    }}>
                      "{v.citacao}"
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pontos positivos */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 8 }}>
            Pontos Positivos ({pontosPositivos.length})
          </div>
          {pontosPositivos.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--fg-3)', fontStyle: 'italic' }}>Nenhum ponto positivo registrado.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pontosPositivos.map((p, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 6,
                  padding: '8px 10px', borderRadius: 8, background: 'var(--success-soft)',
                  border: '1px solid oklch(72% 0.14 155 / 0.20)', fontSize: 12, color: 'var(--fg-2)',
                }}>
                  <CheckCircle size={12} style={{ marginTop: 2, color: 'oklch(40% 0.14 155)', flexShrink: 0 }} />
                  {p}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Conversa */}
      {mensagens.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 8 }}>
            Conversa Completa ({mensagens.length} mensagens)
          </div>
          <div style={{
            maxHeight: 320, overflowY: 'auto', padding: '10px 12px', borderRadius: 8,
            background: 'var(--bg-2)', border: '1px solid var(--line-1)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            {mensagens.map((msg, i) => (
              <div key={i} style={{ fontSize: 12 }}>
                {msg.user_message && (
                  <div style={{
                    padding: '6px 10px', borderRadius: '10px 10px 10px 2px',
                    background: 'var(--bg-1)', border: '1px solid var(--line-1)',
                    color: 'var(--fg-2)', marginBottom: 4, maxWidth: '80%',
                  }}>
                    <span style={{ fontSize: 10, color: 'var(--fg-3)', display: 'block', marginBottom: 2 }}>
                      LEAD · {formatTime(msg.created_at)}
                    </span>
                    {msg.user_message}
                  </div>
                )}
                {msg.bot_message && String(msg.bot_message).trim() && (
                  <div style={{
                    padding: '6px 10px', borderRadius: '10px 10px 2px 10px',
                    background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
                    color: 'var(--fg-1)', marginLeft: 'auto', maxWidth: '80%',
                  }}>
                    <span style={{ fontSize: 10, color: 'var(--accent-fg)', display: 'block', marginBottom: 2 }}>
                      IA · {formatTime(msg.created_at)}
                    </span>
                    {msg.bot_message}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Meta */}
      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--fg-3)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span>Modelo: {data.modelo_avaliador || '-'}</span>
        <span>Avaliado: {formatTime(data.created_at)}</span>
        <span>Detectado: {formatTime(data.detected_at)}</span>
        <span>{data.total_turnos_ia ?? '-'} turnos IA · {data.total_mensagens ?? '-'} msgs</span>
      </div>
    </div>
  )
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500,
      background: active ? 'var(--accent-soft)' : 'transparent',
      border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
      color: active ? 'var(--accent-fg)' : 'var(--fg-3)',
      cursor: 'pointer', transition: 'all 0.15s',
    }}>
      {children}
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FeedbackIAViewer() {
  const [tab, setTab] = useState('avaliacoes')
  const [status, setStatus] = useState(null)
  const [avaliacoes, setAvaliacoes] = useState([])
  const [pendentes, setPendentes] = useState([])
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Filtros
  const [filterVeredito, setFilterVeredito] = useState('')
  const [filterLeadId, setFilterLeadId] = useState('')
  const [page, setPage] = useState(1)

  // Detalhe expandido
  const [expandedId, setExpandedId] = useState(null)

  const fetchAll = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true)
    else setRefreshing(true)
    try {
      const [st, av, pend, runsData] = await Promise.all([
        loadStatus(),
        loadAvaliacoes({ page, limit: 15, veredito: filterVeredito || undefined, leadId: filterLeadId || undefined }),
        loadPendentes({ page: 1, limit: 15 }),
        loadRuns(10),
      ])
      setStatus(st)
      setAvaliacoes(av.rows || [])
      setPendentes(pend.rows || [])
      setRuns(Array.isArray(runsData) ? runsData : [])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [page, filterVeredito, filterLeadId])

  useEffect(() => {
    fetchAll(true)
  }, [fetchAll])

  // Polling a cada 30s
  useEffect(() => {
    const id = setInterval(() => fetchAll(false), 30_000)
    return () => clearInterval(id)
  }, [fetchAll])

  const handleFilter = () => {
    setPage(1)
    fetchAll(false)
  }

  const runner = status?.runner || {}
  const counts = status?.counts || {}

  if (loading) {
    return (
      <div style={{ padding: 32, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-3)' }}>
        <Loader size={16} className="spin" />
        <span>Carregando Feedback IA...</span>
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, margin: '0 auto' }}>
      {/* Cabeçalho */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, background: 'var(--accent-soft)',
            border: '1px solid var(--accent-line)', display: 'grid', placeItems: 'center', color: 'var(--accent-fg)',
          }}>
            <ShieldCheck size={18} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)' }}>Feedback IA</div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
              Avaliação automática da IA contra as Rules 1–18
            </div>
          </div>
        </div>
        <button
          onClick={() => fetchAll(false)}
          disabled={refreshing}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: 8, fontSize: 12,
            background: 'var(--bg-2)', border: '1px solid var(--line-1)',
            color: 'var(--fg-2)', cursor: 'pointer',
          }}
        >
          <RefreshCw size={12} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
          Atualizar
        </button>
      </div>

      {/* Status banner */}
      <div style={{
        padding: '8px 14px', borderRadius: 8, background: 'var(--bg-2)',
        border: '1px solid var(--line-1)', marginBottom: 16, fontSize: 12, color: 'var(--fg-3)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Bot size={13} style={{ color: 'var(--accent-fg)' }} />
        <span>Aguarda saída de leads do funil para avaliar</span>
        {runner.running && (
          <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
            · Avaliando lead #{runner.currentLeadId}...
          </span>
        )}
        {runner.queueSize > 0 && (
          <span style={{ color: 'var(--fg-2)' }}>
            · {runner.queueSize} na fila
          </span>
        )}
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <KPICard
          icon={CheckCircle}
          label="Avaliações hoje"
          value={counts.hoje ?? '-'}
          tone={counts.hoje > 0 ? 'success' : 'muted'}
        />
        <KPICard
          icon={ListChecks}
          label="Esta semana"
          value={counts.semana ?? '-'}
          tone="info"
        />
        <KPICard
          icon={Bot}
          label="Fila atual"
          value={runner.queueSize ?? 0}
          tone={runner.queueSize > 0 ? 'warning' : 'muted'}
          hint={runner.running ? `Avaliando #${runner.currentLeadId}` : 'Aguardando'}
        />
        <KPICard
          icon={AlertTriangle}
          label="Pendentes"
          value={pendentes.length}
          tone={pendentes.length > 0 ? 'warning' : 'muted'}
        />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <TabButton active={tab === 'avaliacoes'} onClick={() => setTab('avaliacoes')}>
          Avaliações ({avaliacoes.length})
        </TabButton>
        <TabButton active={tab === 'pendentes'} onClick={() => setTab('pendentes')}>
          Pendentes ({pendentes.length})
        </TabButton>
        <TabButton active={tab === 'runs'} onClick={() => setTab('runs')}>
          Execuções ({runs.length})
        </TabButton>
      </div>

      {/* Tab: Avaliações */}
      {tab === 'avaliacoes' && (
        <div>
          {/* Filtros */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 8, padding: '4px 8px' }}>
              <Search size={12} style={{ color: 'var(--fg-3)' }} />
              <input
                placeholder="Lead ID"
                value={filterLeadId}
                onChange={(e) => setFilterLeadId(e.target.value)}
                style={{
                  background: 'none', border: 'none', outline: 'none',
                  fontSize: 12, color: 'var(--fg-1)', width: 80,
                }}
              />
            </div>
            <select
              value={filterVeredito}
              onChange={(e) => setFilterVeredito(e.target.value)}
              style={{
                background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 8,
                padding: '5px 10px', fontSize: 12, color: 'var(--fg-2)', cursor: 'pointer',
              }}
            >
              <option value="">Todos os vereditos</option>
              <option value="aprovado">Aprovado</option>
              <option value="parcial">Parcial</option>
              <option value="reprovado">Reprovado</option>
            </select>
            <button
              onClick={handleFilter}
              style={{
                padding: '5px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
                color: 'var(--accent-fg)', cursor: 'pointer',
              }}
            >
              Filtrar
            </button>
            {(filterVeredito || filterLeadId) && (
              <button
                onClick={() => { setFilterVeredito(''); setFilterLeadId(''); setPage(1) }}
                style={{
                  padding: '5px 10px', borderRadius: 8, fontSize: 12,
                  background: 'none', border: '1px solid var(--line-1)',
                  color: 'var(--fg-3)', cursor: 'pointer',
                }}
              >
                Limpar
              </button>
            )}
          </div>

          {/* Lista */}
          {avaliacoes.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
              <MessageSquare size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div>Nenhuma avaliação encontrada.</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>As avaliações aparecem quando leads saem do status monitorado.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {avaliacoes.map((av) => (
                <div key={av.id} style={{
                  borderRadius: 10, background: 'var(--bg-2)',
                  border: `1px solid ${expandedId === av.id ? 'var(--accent-line)' : 'var(--line-1)'}`,
                  overflow: 'hidden', transition: 'border-color 0.15s',
                }}>
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 14px', cursor: 'pointer',
                    }}
                    onClick={() => setExpandedId(expandedId === av.id ? null : av.id)}
                  >
                    <VeredictoBadge veredito={av.veredito} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
                      {av.nota_geral != null ? `${Number(av.nota_geral).toFixed(1)}` : '-'}
                      <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--fg-3)' }}>/10</span>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Lead #{av.lead_id}</span>
                    {av.telefone && <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>· {av.telefone}</span>}
                    <span style={{ fontSize: 11, color: 'var(--fg-3)', marginLeft: 'auto' }}>{formatTime(av.created_at)}</span>
                    <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                      {av.total_turnos_ia ?? '-'} turnos IA
                    </span>
                    {expandedId === av.id ? <ChevronDown size={14} style={{ color: 'var(--fg-3)' }} /> : <ChevronRight size={14} style={{ color: 'var(--fg-3)' }} />}
                  </div>
                  {expandedId === av.id && (
                    <div style={{ borderTop: '1px solid var(--line-1)' }}>
                      <AvaliacaoDetail id={av.id} onClose={() => setExpandedId(null)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Paginação */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              style={{
                padding: '5px 14px', borderRadius: 8, fontSize: 12,
                background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                color: page === 1 ? 'var(--fg-3)' : 'var(--fg-2)', cursor: page === 1 ? 'not-allowed' : 'pointer',
              }}
            >
              ← Anterior
            </button>
            <span style={{ fontSize: 12, color: 'var(--fg-3)', alignSelf: 'center' }}>Página {page}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={avaliacoes.length < 15}
              style={{
                padding: '5px 14px', borderRadius: 8, fontSize: 12,
                background: 'var(--bg-2)', border: '1px solid var(--line-1)',
                color: avaliacoes.length < 15 ? 'var(--fg-3)' : 'var(--fg-2)',
                cursor: avaliacoes.length < 15 ? 'not-allowed' : 'pointer',
              }}
            >
              Próxima →
            </button>
          </div>
        </div>
      )}

      {/* Tab: Pendentes */}
      {tab === 'pendentes' && (
        <div>
          {pendentes.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
              <CheckCircle size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div>Nenhum pendente no momento.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pendentes.map((p) => (
                <div key={p.id} style={{
                  padding: '10px 14px', borderRadius: 10, background: 'var(--bg-2)',
                  border: '1px solid var(--line-1)',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <AlertTriangle size={14} style={{ color: 'var(--warn)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-1)' }}>
                      Lead #{p.lead_id}
                      {p.telefone && <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}> · {p.telefone}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>
                      Motivo: <span style={{ fontWeight: 600 }}>{p.motivo_pendencia || '-'}</span>
                      {' · '}Detectado: {formatTime(p.detected_at)}
                      {' · '}Salvo: {formatTime(p.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab: Runs */}
      {tab === 'runs' && (
        <div>
          {runs.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
              <Clock size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div>Nenhuma execução registrada.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {runs.map((r) => (
                <div key={r.id} style={{
                  padding: '10px 14px', borderRadius: 10, background: 'var(--bg-2)',
                  border: `1px solid ${r.status === 'running' ? 'var(--accent-line)' : r.status === 'error' ? 'oklch(68% 0.20 25 / 0.30)' : 'var(--line-1)'}`,
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: r.status === 'success' ? 'oklch(60% 0.14 155)' : r.status === 'error' ? 'oklch(60% 0.20 25)' : 'oklch(60% 0.14 75)',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-1)' }}>
                      {r.trigger || 'scheduler_diff'}
                      <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}> · {formatTime(r.started_at)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>
                      {r.duration_ms != null && `${formatDuration(r.duration_ms)} · `}
                      {r.avaliacoes_inseridas ?? 0} avaliadas · {r.pendentes_saved ?? 0} pendentes · {r.errors_count ?? 0} erros
                    </div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 600, textTransform: 'uppercase', padding: '2px 6px',
                    borderRadius: 4, background: 'var(--bg-1)', color: 'var(--fg-3)',
                    border: '1px solid var(--line-1)',
                  }}>
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
