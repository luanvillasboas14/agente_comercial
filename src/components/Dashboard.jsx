import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  MessageSquare, Zap, DollarSign, AlertTriangle, Clock,
  TrendingUp, Database, Search, RefreshCw, Calendar
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

function StatCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className="dash-card">
      <div className="dash-card-icon" style={{ color, background: `${color}15` }}>
        <Icon size={20} />
      </div>
      <div className="dash-card-info">
        <span className="dash-card-value">{value}</span>
        <span className="dash-card-label">{label}</span>
        {sub && <span className="dash-card-sub">{sub}</span>}
      </div>
    </div>
  )
}

function BarChart({ data, label }) {
  const max = Math.max(...data.map((d) => d.value), 1)

  return (
    <div className="dash-section">
      <h3 className="dash-section-title">
        <TrendingUp size={16} /> {label}
      </h3>
      <div className="dash-bar-chart">
        {data.map((d, i) => (
          <div key={i} className="dash-bar-col">
            <div className="dash-bar-value">{d.value}</div>
            <div className="dash-bar-track">
              <div className="dash-bar-fill"
                style={{ height: `${Math.max((d.value / max) * 100, 2)}%` }} />
            </div>
            <div className="dash-bar-label">{d.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function HorizontalBars({ data, label, icon: SectionIcon }) {
  const max = Math.max(...data.map((d) => d.value), 1)

  return (
    <div className="dash-section">
      <h3 className="dash-section-title">
        <SectionIcon size={16} /> {label}
      </h3>
      <div className="dash-hbars">
        {data.map((d, i) => (
          <div key={i} className="dash-hbar-row">
            <span className="dash-hbar-name" title={d.label}>{d.label}</span>
            <div className="dash-hbar-track">
              <div className="dash-hbar-fill"
                style={{ width: `${Math.max((d.value / max) * 100, 2)}%` }} />
            </div>
            <span className="dash-hbar-value">{d.value}</span>
          </div>
        ))}
        {data.length === 0 && (
          <div className="dash-no-data">Sem dados no período</div>
        )}
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

export default function Dashboard() {
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(true)

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
  }

  const stats = useMemo(() => {
    const totalDays = daysBetween(startDate, endDate)

    const tokens = executions.reduce((sum, e) => sum + (e.usage?.total_tokens || 0), 0)
    const cost = executions.reduce((sum, e) => sum + calcCost(e.usage, e.model), 0)
    const errors = executions.filter((e) => e.error).length
    const avgTime = executions.length > 0
      ? Math.round(executions.reduce((sum, e) => sum + (e.totalDurationMs || 0), 0) / executions.length)
      : 0

    // Day chart — use YYYY-MM-DD string keys to avoid timezone issues
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

    // Tool usage
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
    }
    const toolsData = Object.entries(toolCounts)
      .map(([k, v]) => ({ label: toolLabels[k] || k, value: v }))
      .sort((a, b) => b.value - a.value)

    // Generalized topics: group only by action type (tool name)
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
    <div className="dashboard">
      <div className="dash-header">
        <h2 className="viewer-title">Dashboard</h2>
        <div className="dash-header-right">
          <button className="pg-action-btn" onClick={fetchData} title="Atualizar">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <div className="dash-content">
        <div className="dash-date-picker">
          <div className="dash-date-presets">
            {PRESETS.map((p) => (
              <button key={p.days} className="dash-preset-btn" onClick={() => applyPreset(p.days)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="dash-date-inputs">
            <Calendar size={14} />
            <input type="date" value={startDate} max={endDate}
              onChange={(e) => setStartDate(e.target.value)} />
            <span className="dash-date-sep">até</span>
            <input type="date" value={endDate} min={startDate} max={today}
              onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <span className="dash-date-summary">
            {periodLabel} — {stats.messagesCount} mensagens
          </span>
        </div>

        {loading ? (
          <div className="state-msg" style={{ minHeight: 200 }}>
            <div className="loader" />
          </div>
        ) : (
          <>
            <div className="dash-cards">
              <StatCard icon={MessageSquare} label="Mensagens" value={stats.messagesCount}
                color="#3b82f6" />
              <StatCard icon={Zap} label="Tokens gastos" value={stats.tokens.toLocaleString('pt-BR')}
                sub={`${((stats.tokens / 1000) || 0).toFixed(1)}k tokens`} color="#8b5cf6" />
              <StatCard icon={DollarSign} label="Custo estimado" value={formatBRL(stats.cost)}
                sub="Baseado no modelo usado" color="#10b981" />
              <StatCard icon={AlertTriangle} label="Erros" value={stats.errorsCount}
                color={stats.errorsCount > 0 ? '#ef4444' : '#6b7280'} />
              <StatCard icon={Clock} label="Tempo médio" value={stats.avgTime > 0 ? `${(stats.avgTime / 1000).toFixed(1)}s` : '-'}
                color="#f59e0b" />
            </div>

            <div className="dash-grid">
              <BarChart data={stats.chartData} label="Mensagens por dia" />

              <div className="dash-grid-right">
                <HorizontalBars data={stats.toolsData} label="Tools mais usadas" icon={Database} />
                <HorizontalBars data={stats.topicsData} label="Tópicos mais pedidos" icon={Search} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
