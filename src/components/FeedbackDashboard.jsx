import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Activity, Zap, DollarSign, AlertTriangle, Clock, TrendingUp,
  CheckCircle2, FileText, Calendar, RefreshCw, Hourglass, Layers,
} from 'lucide-react'
import { getJobRunsByRange } from '../lib/feedbackJobStore'

const TOKEN_COSTS_USD_PER_1M = {
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4o-mini':  { input: 0.15, output: 0.60 },
  'gpt-4.1':      { input: 2.00, output: 8.00 },
  'gpt-4o':       { input: 2.50, output: 10.00 },
}
const DEFAULT_MODEL = 'gpt-4.1-mini'
const USD_TO_BRL = 5.70

function calcRunCostBRL(run) {
  const model = run.model || DEFAULT_MODEL
  const rates = TOKEN_COSTS_USD_PER_1M[model] || TOKEN_COSTS_USD_PER_1M[DEFAULT_MODEL]
  const input = ((run.prompt_tokens || 0) / 1_000_000) * rates.input
  const output = ((run.completion_tokens || 0) / 1_000_000) * rates.output
  return (input + output) * USD_TO_BRL
}

function formatBRL(v) {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 })
}
function formatInt(v) { return (v || 0).toLocaleString('pt-BR') }
function formatDuration(ms) {
  if (!ms || ms < 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), rs = s % 60
  return rs === 0 ? `${m}m` : `${m}m${String(rs).padStart(2, '0')}s`
}
function toInputDate(d) { return d.toISOString().slice(0, 10) }
function getDayLabel(d) {
  return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}
function toLocalDateKey(iso) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function daysBetween(s, e) {
  const a = new Date(s); a.setHours(0, 0, 0, 0)
  const b = new Date(e); b.setHours(0, 0, 0, 0)
  return Math.round((b - a) / 86400000) + 1
}

function KPI({ icon: Icon, label, value, unit, sub }) {
  return (
    <div className="kpi">
      <div className="kpi-head">
        <div className="kpi-label">
          <Icon size={13} />
          <span>{label}</span>
        </div>
      </div>
      <div className="kpi-value tnum">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

function AreaChart({ data, format = (v) => v, color = 'var(--accent)' }) {
  if (!data.length) return <div className="empty">Sem dados no período</div>
  const W = 620, H = 200, padL = 44, padR = 10, padT = 8, padB = 24
  const max = Math.max(...data.map((d) => d.value)) * 1.15 || 1
  const stepX = data.length > 1 ? (W - padL - padR) / (data.length - 1) : 0
  const pts = data.map((d, i) => [padL + i * stepX, padT + (H - padT - padB) * (1 - d.value / max)])
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ')
  const area = line + ` L${pts[pts.length - 1][0]},${H - padB} L${padL},${H - padB} Z`
  const yTicks = [max, max * 0.66, max * 0.33, 0]
  const gradId = `fb-area-${Math.random().toString(36).slice(2)}`

  return (
    <div className="chart-wrap">
      <div className="chart-y-labels">
        {yTicks.map((v, i) => <span key={i}>{format(Math.round(v))}</span>)}
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((_, i) => {
          const y = padT + ((H - padT - padB) * i) / 3
          return <line key={i} x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--line-subtle)" strokeDasharray={i === 3 ? '' : '2 4'} />
        })}
        <path d={area} fill={`url(#${gradId})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2" />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="3" fill="var(--bg-2)" stroke={color} strokeWidth="2" />)}
      </svg>
      <div className="chart-x-labels tnum">
        {data.map((d, i) => <span key={i}>{d.label}</span>)}
      </div>
    </div>
  )
}

const PRESETS = [
  { label: 'Hoje', days: 0 },
  { label: '7 dias', days: 7 },
  { label: '15 dias', days: 15 },
  { label: '30 dias', days: 30 },
]

export default function FeedbackDashboard() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [activePreset, setActivePreset] = useState(7)

  const today = toInputDate(new Date())
  const sevenAgo = toInputDate(new Date(Date.now() - 6 * 86400000))
  const [startDate, setStartDate] = useState(sevenAgo)
  const [endDate, setEndDate] = useState(today)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const startIso = new Date(startDate + 'T00:00:00').toISOString()
    const endIso = new Date(endDate + 'T23:59:59.999').toISOString()
    const data = await getJobRunsByRange(startIso, endIso)
    setRuns(data)
    setLoading(false)
  }, [startDate, endDate])

  useEffect(() => { fetchData() }, [fetchData])

  const applyPreset = (days) => {
    const end = new Date()
    const start = new Date()
    if (days > 0) start.setDate(start.getDate() - (days - 1))
    setStartDate(toInputDate(start))
    setEndDate(toInputDate(end))
    setActivePreset(days)
  }

  const stats = useMemo(() => {
    const totalRuns = runs.length
    const success = runs.filter((r) => r.status === 'success').length
    const errors = runs.filter((r) => r.status === 'error').length
    const running = runs.filter((r) => r.status === 'running').length

    const feedbacksInserted = runs.reduce((s, r) => s + (r.feedbacks_inserted || 0), 0)
    const feedbacksUpdated = runs.reduce((s, r) => s + (r.feedbacks_updated || 0), 0)
    const totalFeedbacks = feedbacksInserted + feedbacksUpdated
    const pendentes = runs.reduce((s, r) => s + (r.pendentes_saved || 0), 0)
    const messages = runs.reduce((s, r) => s + (r.total_messages_fetched || 0), 0)
    const segments = runs.reduce((s, r) => s + (r.total_segments || 0), 0)
    const aiCalls = runs.reduce((s, r) => s + (r.ai_calls || 0), 0)

    const promptTokens = runs.reduce((s, r) => s + (r.prompt_tokens || 0), 0)
    const completionTokens = runs.reduce((s, r) => s + (r.completion_tokens || 0), 0)
    const totalTokens = runs.reduce((s, r) => s + (r.total_tokens || 0), 0)
    const totalCostBRL = runs.reduce((s, r) => s + calcRunCostBRL(r), 0)

    const finishedRuns = runs.filter((r) => r.duration_ms)
    const avgDuration = finishedRuns.length
      ? finishedRuns.reduce((s, r) => s + r.duration_ms, 0) / finishedRuns.length
      : 0

    // Timeline diária
    const days = daysBetween(startDate, endDate)
    const baseDate = new Date(startDate + 'T12:00:00')
    const dayMap = {}
    for (let i = 0; i < days; i++) {
      const d = new Date(baseDate)
      d.setDate(baseDate.getDate() + i)
      const key = toLocalDateKey(d)
      dayMap[key] = { date: d, feedbacks: 0, tokens: 0, cost: 0, runs: 0 }
    }
    runs.forEach((r) => {
      const key = toLocalDateKey(r.started_at)
      if (dayMap[key]) {
        dayMap[key].feedbacks += (r.feedbacks_inserted || 0) + (r.feedbacks_updated || 0)
        dayMap[key].tokens += r.total_tokens || 0
        dayMap[key].cost += calcRunCostBRL(r)
        dayMap[key].runs += 1
      }
    })
    let daily = Object.values(dayMap).map((d) => ({
      label: getDayLabel(d.date), feedbacks: d.feedbacks, tokens: d.tokens, cost: d.cost, runs: d.runs,
    }))
    if (daily.length > 14) {
      const step = Math.ceil(daily.length / 14)
      const reduced = []
      for (let i = 0; i < daily.length; i += step) {
        const slice = daily.slice(i, i + step)
        reduced.push({
          label: slice[0].label,
          feedbacks: slice.reduce((s, d) => s + d.feedbacks, 0),
          tokens: slice.reduce((s, d) => s + d.tokens, 0),
          cost: slice.reduce((s, d) => s + d.cost, 0),
          runs: slice.reduce((s, d) => s + d.runs, 0),
        })
      }
      daily = reduced
    }

    return {
      totalRuns, success, errors, running,
      feedbacksInserted, feedbacksUpdated, totalFeedbacks,
      pendentes, messages, segments, aiCalls,
      promptTokens, completionTokens, totalTokens, totalCostBRL,
      avgDuration,
      daily,
    }
  }, [runs, startDate, endDate])

  const periodLabel = startDate === endDate
    ? 'Hoje'
    : `${new Date(startDate).toLocaleDateString('pt-BR')} — ${new Date(endDate).toLocaleDateString('pt-BR')}`

  const tokensForKpi = stats.totalTokens
  const tokensDisplay = tokensForKpi >= 1_000_000
    ? (tokensForKpi / 1_000_000).toFixed(2) : formatInt(tokensForKpi)
  const tokensUnit = tokensForKpi >= 1_000_000 ? 'M' : ''

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            <span>Feedback Comercial</span>
            <span className="sep">/</span>
            <span>Dashboard</span>
          </div>
          <h1 className="page-title">Dashboard Feedback</h1>
          <div className="page-subtitle">Consumo de IA, custo e produtividade do job de feedback.</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={fetchData}>
            <RefreshCw size={14} />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      <div className="page">
        <div className="dash-toolbar">
          <div className="date-presets">
            {PRESETS.map((p) => (
              <button key={p.days} className={activePreset === p.days ? 'active' : ''} onClick={() => applyPreset(p.days)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="date-range">
            <Calendar size={13} />
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
            <span className="sep">—</span>
            <input type="date" value={endDate} min={startDate} max={today} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="spacer" />
          <div className="period-summary">
            <span>{periodLabel}</span>
            <span>·</span>
            <strong className="tnum">{stats.totalRuns}</strong>
            <span>execuções</span>
          </div>
        </div>

        {loading ? (
          <div className="state-msg" style={{ minHeight: 200 }}>
            <div className="loader" />
          </div>
        ) : (
          <>
            <div className="kpi-grid kpi-grid-6">
              <KPI icon={Activity} label="Execuções" value={formatInt(stats.totalRuns)}
                sub={`${stats.success} ok · ${stats.errors} erro · ${stats.running} rodando`} />
              <KPI icon={CheckCircle2} label="Feedbacks gerados" value={formatInt(stats.totalFeedbacks)}
                sub={`${stats.feedbacksInserted} novos · ${stats.feedbacksUpdated} atualizados`} />
              <KPI icon={Hourglass} label="Pendentes" value={formatInt(stats.pendentes)}
                sub="Segmentos aguardando dados" />
              <KPI icon={Zap} label="Tokens usados" value={tokensDisplay} unit={tokensUnit}
                sub={`in: ${formatInt(stats.promptTokens)} · out: ${formatInt(stats.completionTokens)}`} />
              <KPI icon={DollarSign} label="Custo estimado" value={formatBRL(stats.totalCostBRL)}
                sub={`USD→BRL ${USD_TO_BRL} · ${DEFAULT_MODEL}`} />
              <KPI icon={Clock} label="Duração média" value={formatDuration(stats.avgDuration)}
                sub={stats.avgDuration > 0 ? `${Math.round(stats.avgDuration / 1000)}s por execução` : '-'} />
            </div>

            <div className="dash-grid">
              <div className="dash-col">
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <TrendingUp size={14} />
                      Feedbacks por dia
                    </div>
                    <span className="card-title-sub">{formatInt(stats.totalFeedbacks)} no período</span>
                  </div>
                  <div className="card-body">
                    <AreaChart data={stats.daily.map((d) => ({ label: d.label, value: d.feedbacks }))}
                      format={(v) => formatInt(v)} />
                  </div>
                </div>
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <DollarSign size={14} />
                      Custo por dia
                    </div>
                    <span className="card-title-sub">{formatBRL(stats.totalCostBRL)} no período</span>
                  </div>
                  <div className="card-body">
                    <AreaChart data={stats.daily.map((d) => ({ label: d.label, value: +d.cost.toFixed(4) }))}
                      format={(v) => 'R$ ' + (v || 0).toFixed(2)} color="oklch(78% 0.14 150)" />
                  </div>
                </div>
              </div>
              <div className="dash-col">
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <Zap size={14} />
                      Tokens por dia
                    </div>
                    <span className="card-title-sub">{formatInt(stats.totalTokens)} tokens</span>
                  </div>
                  <div className="card-body">
                    <AreaChart data={stats.daily.map((d) => ({ label: d.label, value: d.tokens }))}
                      format={(v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}
                      color="oklch(78% 0.14 75)" />
                  </div>
                </div>
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <Layers size={14} />
                      Volume processado
                    </div>
                  </div>
                  <div className="card-body">
                    <div className="volume-list">
                      <div className="volume-row">
                        <FileText size={14} />
                        <span className="volume-label">Mensagens lidas</span>
                        <span className="volume-value tnum">{formatInt(stats.messages)}</span>
                      </div>
                      <div className="volume-row">
                        <Layers size={14} />
                        <span className="volume-label">Segmentos agrupados</span>
                        <span className="volume-value tnum">{formatInt(stats.segments)}</span>
                      </div>
                      <div className="volume-row">
                        <Zap size={14} />
                        <span className="volume-label">Chamadas IA</span>
                        <span className="volume-value tnum">{formatInt(stats.aiCalls)}</span>
                      </div>
                      <div className="volume-row">
                        <AlertTriangle size={14} />
                        <span className="volume-label">Runs com erro</span>
                        <span className="volume-value tnum">
                          {formatInt(stats.errors)}
                          {stats.totalRuns > 0 && (
                            <span className="volume-pct"> ({((stats.errors / stats.totalRuns) * 100).toFixed(1)}%)</span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </>
        )}
      </div>
    </div>
  )
}
