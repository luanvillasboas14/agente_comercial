import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Search, Clock, RefreshCw, Copy, Check,
  MessageSquare, Zap, Users, FileCheck, AlertTriangle,
  Bot, PauseCircle, TrendingUp, List, ChevronRight, ChevronDown,
  AlertCircle, ListChecks, Play, Star,
} from 'lucide-react'
import { getAllJobRuns, getFeedbacksByExecutionId, getJobStatus } from '../lib/feedbackJobStore'

function formatDuration(ms) {
  if (!ms) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function formatCountdown(futureIso, nowMs) {
  if (!futureIso) return '-'
  const target = new Date(futureIso).getTime()
  const diff = target - nowMs
  if (diff <= 0) return 'agora'
  const min = Math.floor(diff / 60000)
  const sec = Math.floor((diff % 60000) / 1000)
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`
  if (min >= 1) return `${min}m ${sec.toString().padStart(2, '0')}s`
  return `${sec}s`
}

function formatElapsed(startIso, nowMs) {
  if (!startIso) return '-'
  const diff = nowMs - new Date(startIso).getTime()
  if (diff <= 0) return '0s'
  return formatDuration(diff)
}

function StatusCard({ icon: Icon, label, value, hint, tone }) {
  const toneStyles = {
    success: { color: 'var(--success)', border: 'oklch(72% 0.14 155 / 0.25)', bg: 'var(--success-soft)' },
    warning: { color: 'var(--warn)', border: 'oklch(78% 0.14 75 / 0.25)', bg: 'var(--warn-soft)' },
    danger: { color: 'var(--danger)', border: 'oklch(68% 0.20 25 / 0.25)', bg: 'var(--danger-soft)' },
    info: { color: 'var(--accent-fg)', border: 'var(--accent-line)', bg: 'var(--accent-soft)' },
    muted: { color: 'var(--fg-3)', border: 'var(--line-1)', bg: 'var(--bg-2)' },
  }
  const s = toneStyles[tone] || toneStyles.muted
  return (
    <div style={{
      flex: 1,
      minWidth: 180,
      padding: '10px 14px',
      borderRadius: 10,
      background: s.bg,
      border: `1px solid ${s.border}`,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
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

function formatTime(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function FlowStep({ icon: Icon, iconKind, title, duration, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const has = !!children
  return (
    <div className="flow-step">
      <div className={`flow-indicator ${iconKind || ''}`}><Icon size={14} /></div>
      <div className="flow-card">
        <div className="flow-card-head" onClick={() => has && setOpen(!open)}>
          <div className="flow-card-title">{title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {duration != null && (
              <span className="flow-card-duration"><Clock size={10} /> {formatDuration(duration)}</span>
            )}
            {has && (open ? <ChevronDown size={14} style={{ color: 'var(--fg-3)' }} /> : <ChevronRight size={14} style={{ color: 'var(--fg-3)' }} />)}
          </div>
        </div>
        {open && has && <div className="flow-card-body">{children}</div>}
      </div>
    </div>
  )
}

function RunDetail({ run, onCopy }) {
  const [related, setRelated] = useState({ feedbacks: [], pendentes: [] })
  const [loadingRelated, setLoadingRelated] = useState(true)

  useEffect(() => {
    let mounted = true
    setLoadingRelated(true)
    getFeedbacksByExecutionId(run.id).then((d) => {
      if (mounted) { setRelated(d); setLoadingRelated(false) }
    })
    return () => { mounted = false }
  }, [run.id])

  const steps = Array.isArray(run.steps) ? run.steps : []
  const fetchStep = steps.find((s) => s.type === 'fetch_messages_done')
  const groupStep = steps.find((s) => s.type === 'group_segments')
  const segmentFeedbackSteps = steps.filter((s) => s.type === 'segment_feedback')
  const segmentPendenteSteps = steps.filter((s) => s.type === 'segment_pendente')
  const segmentErrorSteps = steps.filter((s) => s.type === 'segment_error')
  const fatalError = steps.find((s) => s.type === 'fatal_error')

  return (
    <div className="exec-detail">
      <div className="exec-detail-header">
        <div className="exec-detail-id-row">
          <button className="exec-detail-id" onClick={() => { navigator.clipboard?.writeText(run.id); onCopy() }}>
            {run.id}
            <Copy size={13} />
          </button>
          <span className={`badge ${run.status === 'error' ? 'danger' : run.status === 'running' ? 'warning' : 'success'}`}>
            {run.status === 'running' ? 'Em execução' : run.status === 'error' ? 'Erro' : 'Sucesso'}
          </span>
          <span className="badge">{run.trigger === 'manual' ? 'Manual' : 'Cron'}</span>
        </div>
        <div className="exec-detail-meta">
          <span><Clock size={12} /> {formatTime(run.started_at)}</span>
          {run.finished_at && <span><Zap size={12} /> {formatDuration(run.duration_ms)}</span>}
        </div>
      </div>

      {/* KPIs rápidos */}
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <KpiMini icon={MessageSquare} label="Mensagens lidas" value={run.total_messages_fetched || 0} />
        <KpiMini icon={Users} label="Segmentos" value={run.total_segments || 0} />
        <KpiMini icon={FileCheck} label="Inseridos" value={run.feedbacks_inserted || 0} color="var(--success)" />
        <KpiMini icon={TrendingUp} label="Atualizados" value={run.feedbacks_updated || 0} color="var(--info)" />
        <KpiMini icon={PauseCircle} label="Pendentes" value={run.pendentes_saved || 0} color="var(--warning)" />
        <KpiMini icon={Bot} label="Chamadas IA" value={run.ai_calls || 0} />
      </div>

      <div className="flow-track">
        <FlowStep icon={Play} iconKind={run.trigger === 'manual' ? 'info' : ''} title={`Trigger: ${run.trigger}`} defaultOpen>
          <div className="flow-content-text">
            Iniciado em {formatTime(run.started_at)}.
            {run.finished_at && <><br />Finalizado em {formatTime(run.finished_at)} ({formatDuration(run.duration_ms)}).</>}
          </div>
        </FlowStep>

        <FlowStep icon={MessageSquare} iconKind="info" title={`Buscou ${run.total_messages_fetched || 0} mensagens da janela`}>
          <div className="flow-content-text">
            Query em <code>mensagens_atendimento_comercial</code> para a janela configurada.
            {fetchStep && <><br />Rows retornadas: {fetchStep.count}</>}
          </div>
        </FlowStep>

        <FlowStep icon={Users} iconKind="" title={`Agrupou em ${run.total_segments || 0} segmento(s)`}>
          <div className="flow-content-text">
            Cada segmento = (entidade, consultor). Bots e mensagens sem entidade foram descartados.
            {groupStep && <><br />Total de segmentos: {groupStep.count}</>}
          </div>
        </FlowStep>

        {segmentFeedbackSteps.length > 0 && (
          <FlowStep icon={FileCheck} iconKind="success" title={`${segmentFeedbackSteps.length} feedback(s) gerado(s)`}>
            <div className="flow-section">
              {segmentFeedbackSteps.map((s, i) => (
                <div key={i} style={{ padding: '6px 0', borderBottom: i < segmentFeedbackSteps.length - 1 ? '1px solid var(--line-subtle)' : 'none' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                    <span className={`badge ${s.action === 'inserted' ? 'success' : 'accent'}`}>{s.action}</span>
                    {s.nota != null && <span className="badge"><Star size={10} /> {s.nota}</span>}
                    <span style={{ color: 'var(--fg-2)' }}>{s.segment}</span>
                  </div>
                </div>
              ))}
            </div>
          </FlowStep>
        )}

        {segmentPendenteSteps.length > 0 && (
          <FlowStep icon={PauseCircle} iconKind="warning" title={`${segmentPendenteSteps.length} segmento(s) salvos como pendente`}>
            <div className="flow-section">
              {segmentPendenteSteps.map((s, i) => (
                <div key={i} style={{ padding: '6px 0', borderBottom: i < segmentPendenteSteps.length - 1 ? '1px solid var(--line-subtle)' : 'none', fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="badge warning">{s.motivo}</span>
                    <span style={{ color: 'var(--fg-2)' }}>{s.segment}</span>
                  </div>
                </div>
              ))}
            </div>
          </FlowStep>
        )}

        {segmentErrorSteps.length > 0 && (
          <FlowStep icon={AlertTriangle} iconKind="error" title={`${segmentErrorSteps.length} erro(s) em segmento(s)`} defaultOpen>
            <div className="flow-section">
              {segmentErrorSteps.map((s, i) => (
                <div key={i} style={{ padding: '6px 0', borderBottom: i < segmentErrorSteps.length - 1 ? '1px solid var(--line-subtle)' : 'none', fontSize: 12 }}>
                  <div style={{ color: 'var(--fg-2)', marginBottom: 4 }}>{s.segment}</div>
                  <div style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.error}</div>
                </div>
              ))}
            </div>
          </FlowStep>
        )}

        {fatalError && (
          <FlowStep icon={AlertCircle} iconKind="error" title="Erro fatal" defaultOpen>
            <div className="flow-content-text" style={{ color: 'var(--danger)' }}>{fatalError.error}</div>
          </FlowStep>
        )}

        {/* Feedbacks rastreados */}
        <FlowStep icon={List} iconKind="info" title={`Rastreabilidade (${related.feedbacks.length + related.pendentes.length} registros)`}>
          {loadingRelated ? (
            <div className="loader" style={{ margin: '0 auto' }} />
          ) : (related.feedbacks.length === 0 && related.pendentes.length === 0) ? (
            <div className="flow-content-text" style={{ color: 'var(--fg-3)' }}>
              Nenhum registro encontrado com este job_execution_id.
            </div>
          ) : (
            <div className="flow-section">
              {related.feedbacks.map((f) => (
                <div key={`fb-${f.id}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-subtle)', fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="badge success">feedback #{f.id}</span>
                    {f.nota_avaliacao != null && <span className="badge"><Star size={10} /> {f.nota_avaliacao}</span>}
                    <span style={{ color: 'var(--fg-2)' }}>
                      {f.consultor || '-'} · {f.contact_id ? `contact ${f.contact_id}` : `lead ${f.lead_id}`}
                    </span>
                  </div>
                  {f.ponto_positivo && <div style={{ marginTop: 4, color: 'var(--fg-2)' }}>✓ {f.ponto_positivo}</div>}
                  {f.ponto_negativo && <div style={{ marginTop: 2, color: 'var(--fg-3)' }}>✗ {f.ponto_negativo}</div>}
                </div>
              ))}
              {related.pendentes.map((p) => (
                <div key={`pd-${p.id}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-subtle)', fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="badge warning">pendente #{p.id}</span>
                    <span className="badge">{p.motivo_pendencia}</span>
                    <span style={{ color: 'var(--fg-2)' }}>
                      {p.consultor || '-'} · {p.contact_id ? `contact ${p.contact_id}` : `lead ${p.lead_id}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </FlowStep>
      </div>
    </div>
  )
}

function KpiMini({ icon: Icon, label, value, color }) {
  return (
    <div className="kpi">
      <div className="kpi-head">
        <div className="kpi-label">
          <Icon size={13} style={color ? { color } : {}} />
          <span>{label}</span>
        </div>
      </div>
      <div className="kpi-value tnum" style={{ fontSize: 20, ...(color ? { color } : {}) }}>{value}</div>
    </div>
  )
}

function StatusBar({ status, nowMs }) {
  if (!status) {
    return (
      <div style={{ display: 'flex', gap: 12, padding: '12px 24px 0', flexWrap: 'wrap' }}>
        <StatusCard icon={Clock} label="Próxima execução" value="Carregando..." tone="muted" />
        <StatusCard icon={Play} label="Status" value="Carregando..." tone="muted" />
        <StatusCard icon={MessageSquare} label="Mensagens na fila" value="-" tone="muted" />
      </div>
    )
  }

  if (status._error) {
    return (
      <div style={{ display: 'flex', gap: 12, padding: '12px 24px 0', flexWrap: 'wrap' }}>
        <StatusCard
          icon={AlertCircle}
          label="Status indisponível"
          value="Não foi possível consultar"
          hint={status._error}
          tone="danger"
        />
      </div>
    )
  }

  const cronOff = status.cronEnabled === false

  const nextIn = formatCountdown(status.nextRunAt, nowMs)
  const runningFor = status.isRunning ? formatElapsed(status.currentRunStartedAt, nowMs) : null
  const pendingMsgs = status.pendingCount

  const windowMin = status.window?.window_minutes
  const extra = status.window?.extra_minutes_over_hour || 0
  const windowHint = windowMin
    ? `Janela: ${windowMin}min${extra > 0 ? ` (+${extra}min de atraso anterior)` : ''}`
    : null

  return (
    <div style={{ display: 'flex', gap: 12, padding: '12px 24px 0', flexWrap: 'wrap' }}>
      <StatusCard
        icon={Clock}
        label="Próxima execução"
        value={cronOff ? 'Cron desligado' : status.isRunning ? 'logo após o atual' : `em ${nextIn}`}
        hint={cronOff
          ? 'FEEDBACK_JOB_ENABLED=false no .env'
          : status.hasPending
            ? 'Execução enfileirada: roda logo após o atual'
            : 'No minuto :01 de toda hora'}
        tone={cronOff ? 'warning' : status.hasPending ? 'warning' : 'info'}
      />
      <StatusCard
        icon={status.isRunning ? RefreshCw : Check}
        label="Status"
        value={status.isRunning ? `Rodando há ${runningFor}` : 'Aguardando'}
        hint={status.isRunning
          ? (nowMs - new Date(status.currentRunStartedAt || 0).getTime() > 60 * 60 * 1000
              ? 'Passou de 1h — a próxima janela vai cobrir o atraso'
              : 'Execução em andamento')
          : 'Nenhum job em execução'}
        tone={status.isRunning ? 'success' : 'muted'}
      />
      <StatusCard
        icon={MessageSquare}
        label="Mensagens na fila"
        value={pendingMsgs == null ? '-' : `${pendingMsgs}`}
        hint={windowHint}
        tone={pendingMsgs > 0 ? 'info' : 'muted'}
      />
    </div>
  )
}

export default function FeedbackJobViewer() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [copyToast, setCopyToast] = useState(false)
  const [status, setStatus] = useState(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const fetchRuns = useCallback(async () => {
    setLoading(true)
    const data = await getAllJobRuns()
    setRuns(data)
    setLoading(false)
  }, [])

  const fetchStatus = useCallback(async () => {
    const s = await getJobStatus()
    setStatus(s)
  }, [])

  useEffect(() => { fetchRuns() }, [fetchRuns])
  useEffect(() => { fetchStatus() }, [fetchStatus])

  // Tick de relógio para countdown/elapsed; e refetch do status a cada 10s
  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000)
    const poll = setInterval(() => { fetchStatus() }, 10000)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [fetchStatus])

  const filtered = useMemo(() => {
    if (!search.trim()) return runs
    const q = search.trim().toLowerCase()
    return runs.filter((r) =>
      r.id.toLowerCase().includes(q) ||
      (r.error_message || '').toLowerCase().includes(q) ||
      (r.status || '').toLowerCase().includes(q)
    )
  }, [runs, search])

  const showCopyToast = () => {
    setCopyToast(true)
    setTimeout(() => setCopyToast(false), 1500)
  }

  const handleCopyId = (id, e) => {
    e.stopPropagation()
    navigator.clipboard?.writeText(id)
    showCopyToast()
  }

  const stats = useMemo(() => {
    const total = runs.length
    const successes = runs.filter((r) => r.status === 'success').length
    const errors = runs.filter((r) => r.status === 'error').length
    const last = runs[0]
    return { total, successes, errors, last }
  }, [runs])

  return (
    <div className="exec-viewer">
      {copyToast && <div className="toast"><Check size={14} className="toast-check" /> ID copiado</div>}

      <div className="pg-header">
        <div className="pg-title-group">
          <h1 className="page-title" style={{ fontSize: 18 }}>Feedback Comercial</h1>
          <span className="badge">{stats.total} execuções</span>
          {stats.errors > 0 && <span className="badge danger">{stats.errors} erros</span>}
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={() => { fetchRuns(); fetchStatus() }}>
            <RefreshCw size={14} /> <span>Atualizar</span>
          </button>
        </div>
      </div>

      <StatusBar status={status} nowMs={nowMs} />

      <div className="exec-layout">
        <div className="exec-list-panel">
          <div className="exec-list-head">
            <div className="search-wrap">
              <Search size={14} className="search-icon" />
              <input
                className="input"
                placeholder="Buscar por ID ou erro..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="exec-list-items">
            {loading && <div className="empty"><div className="loader" style={{ margin: '0 auto' }} /></div>}
            {!loading && filtered.length === 0 && (
              <div className="empty">
                <ListChecks size={28} className="empty-icon" />
                <div className="empty-title">Nenhuma execução</div>
                <div>Clique em "Rodar agora" para iniciar</div>
              </div>
            )}
            {!loading && filtered.map((r) => (
              <div
                key={r.id}
                className={`exec-item${selected?.id === r.id ? ' selected' : ''}`}
                onClick={() => setSelected(r.id === selected?.id ? null : r)}
              >
                <div className="exec-item-head">
                  <button className="exec-item-id" onClick={(e) => handleCopyId(r.id, e)}>
                    {r.id}
                    <Copy size={10} />
                  </button>
                  <span className={`status-dot ${r.status === 'error' ? 'error' : r.status === 'running' ? 'warning' : 'success'}`} />
                </div>
                <div className="exec-item-msg" style={{ fontSize: 12 }}>
                  {r.status === 'error'
                    ? <span style={{ color: 'var(--danger)' }}>{r.error_message?.slice(0, 80) || 'Erro'}</span>
                    : r.status === 'running'
                      ? <span style={{ color: 'var(--warning)' }}>Executando…</span>
                      : (
                        <span>
                          <strong className="tnum">{r.feedbacks_inserted + r.feedbacks_updated}</strong> feedback(s)
                          {r.pendentes_saved > 0 && <span> · <strong className="tnum">{r.pendentes_saved}</strong> pendente(s)</span>}
                        </span>
                      )
                  }
                </div>
                <div className="exec-item-footer tnum">
                  <span><Clock size={10} /> {formatTime(r.started_at)}</span>
                  {r.duration_ms > 0 && <span><Zap size={10} /> {formatDuration(r.duration_ms)}</span>}
                  <span className="badge" style={{ fontSize: 10, padding: '1px 6px' }}>{r.trigger}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="exec-detail-panel">
          {selected ? (
            <RunDetail run={selected} onCopy={showCopyToast} />
          ) : (
            <div className="exec-detail-empty">
              <div>
                <div className="empty-icon"><ListChecks size={24} /></div>
                <div style={{ color: 'var(--fg-2)', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  Selecione uma execução
                </div>
                <div style={{ fontSize: 12 }}>
                  Busque pelo ID do <code>job_execution_id</code> de um feedback para depurar
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
