import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  MessageSquare, Zap, DollarSign, AlertTriangle, Clock,
  TrendingUp, Database, Search, RefreshCw, Calendar, Filter, Tag
} from 'lucide-react'
import { getExecutionsByRange } from '../lib/executionStore'

const TOKEN_COSTS = {
  'gpt-4o-mini':  { input: 0.15,  output: 0.60  },
  'gpt-4.1-mini': { input: 0.15,  output: 0.60  },
  'gpt-4o':       { input: 2.50,  output: 10.00 },
  'gpt-4.1':      { input: 2.00,  output: 8.00  },
}
const USD_TO_BRL = 5.70

const TOPIC_LABELS = {
  buscar_precos: 'Pediu preço',
  buscar_informacoes: 'Pediu informações do curso',
  buscar_pos: 'Pediu pós-graduação',
  buscar_perguntas: 'Fez uma pergunta (FAQ)',
  localizacao: 'Pediu polo / localização',
  inscricao: 'Inscrição / matrícula',
  distribuir_humano: 'Distribuição para humano',
}

const TOPIC_COLORS = {
  'Pediu preço': 'oklch(66% 0.18 268)',
  'Pediu informações do curso': 'oklch(68% 0.16 215)',
  'Pediu pós-graduação': 'oklch(72% 0.14 155)',
  'Fez uma pergunta (FAQ)': 'oklch(78% 0.14 75)',
}

function calcCost(usage, model) {
  const rates = TOKEN_COSTS[model] || TOKEN_COSTS['gpt-4o-mini']
  const inputCost = ((usage?.prompt_tokens || 0) / 1_000_000) * rates.input
  const outputCost = ((usage?.completion_tokens || 0) / 1_000_000) * rates.output
  return (inputCost + outputCost) * USD_TO_BRL
}

function formatBRL(value) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function toInputDate(date) {
  return date.toISOString().slice(0, 10)
}

function getDayLabel(date) {
  return date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

function daysBetween(start, end) {
  const s = new Date(start); s.setHours(0,0,0,0)
  const e = new Date(end); e.setHours(0,0,0,0)
  return Math.round((e - s) / 86400000) + 1
}

function isInRange(iso, start, end) {
  const d = new Date(iso)
  return d >= new Date(start) && d <= new Date(end + 'T23:59:59.999Z')
}

/* ── UI Components ── */

function KPI({ label, icon: Icon, value, unit, sub }) {
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

function AreaChart({ data }) {
  if (data.length === 0) return <div className="empty">Sem dados no período</div>
  const W = 620, H = 200, padL = 34, padR = 10, padT = 8, padB = 24
  const max = Math.max(...data.map(d => d.value)) * 1.15 || 1
  const stepX = data.length > 1 ? (W - padL - padR) / (data.length - 1) : 0
  const pts = data.map((d, i) => [padL + i * stepX, padT + (H - padT - padB) * (1 - d.value / max)])
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ')
  const area = line + ` L${pts[pts.length - 1][0]},${H - padB} L${padL},${H - padB} Z`
  const yTicks = [max, max * 0.66, max * 0.33, 0].map(v => Math.round(v))

  return (
    <div className="chart-wrap">
      <div className="chart-y-labels">
        {yTicks.map((v, i) => <span key={i}>{v}</span>)}
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((v, i) => {
          const y = padT + ((H - padT - padB) * i) / 3
          return <line key={'g'+i} x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--line-subtle)" strokeDasharray={i === 3 ? '' : '2 4'} />
        })}
        <path d={area} fill="url(#area-grad)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {pts.map((p, i) => <circle key={'p'+i} cx={p[0]} cy={p[1]} r="3" fill="var(--bg-2)" stroke="var(--accent)" strokeWidth="2" />)}
      </svg>
      <div className="chart-x-labels tnum">
        {data.map((d, i) => <span key={i}>{d.label}</span>)}
      </div>
    </div>
  )
}

function HBars({ data, total }) {
  if (data.length === 0) return <div className="empty">Sem dados no período</div>
  const max = Math.max(...data.map(d => d.value))
  return (
    <div className="hbars">
      {data.map((d, i) => (
        <div key={i} className="hbar-row">
          <div className="hbar-label-row">
            <div className="hbar-name">
              <span className="hbar-rank tnum">{i + 1}</span>
              <span>{d.label}</span>
            </div>
            <div className="hbar-value tnum">
              {d.value.toLocaleString('pt-BR')}
              <span className="hbar-pct">{((d.value / (total || 1)) * 100).toFixed(1)}%</span>
            </div>
          </div>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Donut({ data }) {
  if (data.length === 0) return <div className="empty">Sem dados no período</div>
  const R = 56, SW = 14, C = 2 * Math.PI * R
  const total = data.reduce((s, d) => s + d.value, 0)
  let offset = 0

  return (
    <div className="donut-wrap">
      <div style={{ position: 'relative', width: 150, height: 150, flexShrink: 0 }}>
        <svg width="150" height="150" viewBox="0 0 150 150">
          <circle cx="75" cy="75" r={R} fill="none" stroke="var(--bg-4)" strokeWidth={SW} />
          {data.map((d, i) => {
            const len = (d.value / total) * C
            const el = (
              <circle key={i} cx="75" cy="75" r={R} fill="none"
                stroke={d.color} strokeWidth={SW}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 75 75)" />
            )
            offset += len
            return el
          })}
        </svg>
        <div className="donut-center">
          <div>
            <div className="donut-center-val tnum">{total.toLocaleString('pt-BR')}</div>
            <div className="donut-center-lbl">tópicos</div>
          </div>
        </div>
      </div>
      <div className="donut-legend">
        {data.map((d, i) => (
          <div key={i} className="legend-row">
            <span className="legend-dot" style={{ background: d.color }} />
            <span className="legend-name">{d.label}</span>
            <span className="legend-val tnum">
              {d.value.toLocaleString('pt-BR')}
              <span className="legend-pct">{((d.value / total) * 100).toFixed(0)}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Main Dashboard ── */

const PRESETS = [
  { label: 'Hoje', days: 0 },
  { label: '7 dias', days: 7 },
  { label: '15 dias', days: 15 },
  { label: '30 dias', days: 30 },
]

export default function Dashboard() {
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(true)
  const [activePreset, setActivePreset] = useState(7)

  const today = toInputDate(new Date())
  const sevenAgo = toInputDate(new Date(Date.now() - 6 * 86400000))
  const [startDate, setStartDate] = useState(sevenAgo)
  const [endDate, setEndDate] = useState(today)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const data = await getExecutionsByRange(startDate, endDate)
    setExecutions(data)
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
    const totalDays = daysBetween(startDate, endDate)

    const tokens = executions.reduce((sum, e) => sum + (e.usage?.total_tokens || 0), 0)
    const cost = executions.reduce((sum, e) => sum + calcCost(e.usage, e.model), 0)
    const errors = executions.filter((e) => e.error).length
    const avgTime = executions.length > 0
      ? Math.round(executions.reduce((sum, e) => sum + (e.totalDurationMs || 0), 0) / executions.length)
      : 0

    function toLocalDateKey(iso) {
      const d = new Date(iso)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    function dateKeyToDate(key) {
      const [y, m, d] = key.split('-').map(Number)
      return new Date(y, m - 1, d)
    }

    const dayMap = {}
    const baseDate = new Date(startDate + 'T12:00:00')
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(baseDate)
      d.setDate(baseDate.getDate() + i)
      const key = toLocalDateKey(d)
      dayMap[key] = { date: d, count: 0 }
    }
    executions.forEach((e) => {
      const key = toLocalDateKey(e.timestamp)
      if (dayMap[key]) dayMap[key].count++
    })
    const chartData = Object.values(dayMap).map((d) => ({
      label: getDayLabel(d.date),
      value: d.count,
    }))
    if (chartData.length > 14) {
      const step = Math.ceil(chartData.length / 14)
      const reduced = []
      for (let i = 0; i < chartData.length; i += step) {
        const slice = chartData.slice(i, i + step)
        reduced.push({
          label: slice[0].label,
          value: slice.reduce((s, d) => s + d.value, 0),
        })
      }
      chartData.length = 0
      chartData.push(...reduced)
    }

    const toolCounts = {}
    executions.forEach((e) => {
      (e.toolCalls || []).forEach((tc) => {
        const name = tc.tool || 'unknown'
        toolCounts[name] = (toolCounts[name] || 0) + 1
      })
    })
    const toolLabels = {
      buscar_precos: 'Buscar Preços',
      buscar_informacoes: 'Buscar Informações',
      buscar_pos: 'Buscar Pós-Graduação',
      buscar_perguntas: 'Buscar Perguntas',
      localizacao: 'Localização',
      inscricao: 'Inscrição',
      distribuir_humano: 'Distribuir humano',
    }
    const toolsData = Object.entries(toolCounts)
      .map(([k, v]) => ({ label: toolLabels[k] || k, value: v }))
      .sort((a, b) => b.value - a.value)

    const actionCounts = {}
    executions.forEach((e) => {
      (e.toolCalls || []).forEach((tc) => {
        const actionLabel = TOPIC_LABELS[tc.tool] || tc.tool
        actionCounts[actionLabel] = (actionCounts[actionLabel] || 0) + 1
      })
    })

    const topicsData = Object.entries(actionCounts)
      .map(([k, v]) => ({ label: k, value: v }))
      .sort((a, b) => b.value - a.value)

    return {
      messagesCount: executions.length,
      tokens,
      cost,
      errorsCount: errors,
      avgTime,
      chartData,
      toolsData,
      topicsData,
    }
  }, [executions, startDate, endDate])

  const periodLabel = startDate === endDate
    ? 'Hoje'
    : `${new Date(startDate).toLocaleDateString('pt-BR')} — ${new Date(endDate).toLocaleDateString('pt-BR')}`

  return (
    <div>
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-eyebrow">
            <span>Painel</span>
            <span className="sep">/</span>
            <span>Visão geral</span>
          </div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-subtitle">Acompanhe o desempenho da IA em tempo real.</div>
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
            <strong className="tnum">{stats.messagesCount}</strong>
            <span>mensagens</span>
          </div>
        </div>

        {loading ? (
          <div className="state-msg" style={{ minHeight: 200 }}>
            <div className="loader" />
          </div>
        ) : (
          <>
            <div className="kpi-grid">
              <KPI icon={MessageSquare} label="Mensagens" value={stats.messagesCount} />
              <KPI icon={Zap} label="Tokens usados" value={stats.tokens > 1000000 ? (stats.tokens/1000000).toFixed(2) : stats.tokens.toLocaleString('pt-BR')} unit={stats.tokens > 1000000 ? 'M' : ''} sub="Total de tokens consumidos" />
              <KPI icon={DollarSign} label="Custo estimado" value={formatBRL(stats.cost)} sub="Baseado no modelo usado" />
              <KPI icon={Clock} label="Tempo médio" value={stats.avgTime > 0 ? (stats.avgTime / 1000).toFixed(1) : '-'} unit={stats.avgTime > 0 ? 's' : ''} />
              <KPI icon={AlertTriangle} label="Erros" value={stats.errorsCount} sub={stats.messagesCount > 0 ? `${((stats.errorsCount / stats.messagesCount) * 100).toFixed(1)}% do total` : ''} />
            </div>

            <div className="dash-grid">
              <div className="dash-col">
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <TrendingUp size={14} />
                      Mensagens por dia
                    </div>
                  </div>
                  <div className="card-body">
                    <AreaChart data={stats.chartData} />
                  </div>
                </div>
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <Database size={14} />
                      Tools mais usadas
                    </div>
                    <span className="card-title-sub">{stats.toolsData.reduce((s, d) => s + d.value, 0).toLocaleString('pt-BR')} chamadas</span>
                  </div>
                  <div className="card-body">
                    <HBars data={stats.toolsData} total={stats.toolsData.reduce((s, d) => s + d.value, 0)} />
                  </div>
                </div>
              </div>
              <div className="dash-col">
                <div className="card">
                  <div className="card-header">
                    <div className="card-title">
                      <Tag size={14} />
                      Tópicos mais pedidos
                    </div>
                  </div>
                  <div className="card-body">
                    <Donut data={stats.topicsData.map(d => ({ ...d, color: TOPIC_COLORS[d.label] || 'var(--accent)' }))} />
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
