import { Fragment, useCallback, useEffect, useState } from 'react'
import { RefreshCw, ChevronRight, ChevronDown } from 'lucide-react'

function getYesterdayISO() {
  const ms = Date.now() - 3 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function fmtMin(min) {
  if (!min || min <= 0) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}min`
  return `${h}h${String(m).padStart(2, '0')}`
}

function fmtTipoResumo(tipos) {
  if (!tipos || typeof tipos !== 'object') return '—'
  const entries = Object.entries(tipos)
  if (entries.length === 0) return '—'
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ')
}

function gapSeverity(min) {
  if (min >= 120) return 'var(--danger)'
  if (min >= 60) return 'var(--warning)'
  return 'var(--muted)'
}

export default function KommoEventsMetrics() {
  const [date, setDate] = useState(getYesterdayISO())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(new Set())

  const fetchMetrics = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/kommo-events/metrics?date=${encodeURIComponent(date)}`)
      const data = await r.json()
      if (!r.ok) throw new Error(data?.error || 'falha ao carregar')
      setRows(Array.isArray(data?.rows) ? data.rows : [])
      setExpanded(new Set())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { fetchMetrics() }, [fetchMetrics])

  const toggleRow = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const sorted = [...rows].sort(
    (a, b) => (b.tempo_ativo_estimado_minutos || 0) - (a.tempo_ativo_estimado_minutos || 0)
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Atividade Consultores</h1>
          <p className="muted">Tempo trabalhado estimado por consultor (gaps ≤ 15min) • clique pra ver intervalos de inatividade</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{
              background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '6px 10px', fontSize: 14,
            }}
          />
          <button className="btn btn-primary" onClick={fetchMetrics} disabled={loading}>
            <RefreshCw size={14} /> {loading ? 'Carregando...' : 'Buscar'}
          </button>
        </div>
      </div>

      {error && <div className="state-msg" style={{ color: 'var(--danger)' }}>Erro: {error}</div>}

      {!loading && rows.length === 0 && (
        <div className="card"><p className="muted">Nenhum dado pra {date}. Talvez o sync ainda não tenha rodado ou não houve atividade.</p></div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '10px 8px', width: 28 }}></th>
                <th style={{ padding: '10px 8px' }}>Consultor</th>
                <th style={{ padding: '10px 8px' }}>1ª ação</th>
                <th style={{ padding: '10px 8px' }}>Última</th>
                <th style={{ padding: '10px 8px' }}>Tempo ativo</th>
                <th style={{ padding: '10px 8px' }}>Gaps {'>'}15min</th>
                <th style={{ padding: '10px 8px' }}>Ações</th>
                <th style={{ padding: '10px 8px' }}>Leads</th>
                <th style={{ padding: '10px 8px' }}>Por tipo</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const gaps = Array.isArray(r.gaps_maiores_15min) ? r.gaps_maiores_15min : []
                const isExpanded = expanded.has(r.consultor_id)
                const hasGaps = gaps.length > 0
                return (
                  <Fragment key={r.consultor_id}>
                    <tr
                      style={{
                        borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                        cursor: hasGaps ? 'pointer' : 'default',
                      }}
                      onClick={() => hasGaps && toggleRow(r.consultor_id)}
                    >
                      <td style={{ padding: '10px 8px', color: 'var(--muted)' }}>
                        {hasGaps ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        <div style={{ fontWeight: 600 }}>{r.consultor_nome || `ID ${r.consultor_id}`}</div>
                        {r.consultor_nome && <div className="muted" style={{ fontSize: 11 }}>ID {r.consultor_id}</div>}
                      </td>
                      <td style={{ padding: '10px 8px' }}>{fmtTime(r.primeira_acao)}</td>
                      <td style={{ padding: '10px 8px' }}>{fmtTime(r.ultima_acao)}</td>
                      <td style={{ padding: '10px 8px', fontWeight: 600 }}>{fmtMin(r.tempo_ativo_estimado_minutos)}</td>
                      <td style={{ padding: '10px 8px' }}>
                        {hasGaps ? (
                          <span>
                            <span style={{ fontWeight: 600 }}>{gaps.length}</span>
                            <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                              (maior {fmtMin(r.maior_intervalo_sem_acao_minutos)})
                            </span>
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 8px' }}>{r.total_acoes}</td>
                      <td style={{ padding: '10px 8px' }}>{r.total_leads_unicos}</td>
                      <td style={{ padding: '10px 8px', fontSize: 12 }} className="muted">{fmtTipoResumo(r.total_eventos_por_tipo)}</td>
                    </tr>
                    {isExpanded && hasGaps && (
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={9} style={{ padding: '8px 12px 16px 40px', background: 'rgba(255,255,255,0.02)' }}>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                            Intervalos sem atividade de {r.consultor_nome || r.consultor_id}:
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 6 }}>
                            {gaps.map((g, i) => (
                              <div
                                key={i}
                                style={{
                                  padding: '8px 10px',
                                  borderRadius: 6,
                                  border: '1px solid var(--border)',
                                  fontSize: 13,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 8,
                                }}
                              >
                                <span style={{ fontFamily: 'monospace' }}>
                                  {fmtTime(g.inicio)} → {fmtTime(g.fim)}
                                </span>
                                <span style={{ color: gapSeverity(g.duracao_minutos), fontWeight: 600 }}>
                                  {fmtMin(g.duracao_minutos)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
