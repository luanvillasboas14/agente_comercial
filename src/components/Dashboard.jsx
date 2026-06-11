import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  MessageSquare, Zap, DollarSign, AlertTriangle, Clock,
  TrendingUp, Database, Search, RefreshCw, Calendar, Filter, Tag,
  Wand2, Bot, Wrench, Layers
} from 'lucide-react'
import { getExecutionsByRange } from '../lib/executionStore'
import { calcCostBRL } from '../lib/openaiPricing'

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
  'Pediu preço': '#f472b6',
  'Pediu informações do curso': '#34d399',
  'Pediu pós-graduação': '#c084fc',
  'Fez uma pergunta (FAQ)': '#fbbf24',
  'Pediu polo / localização': '#38bdf8',
  'Inscrição / matrícula': '#f87171',
  'Distribuição para humano': '#94a3b8',
}

const FALLBACK_TOPIC_COLORS = [
  '#f472b6', '#34d399', '#c084fc', '#fbbf24',
  '#38bdf8', '#f87171', '#94a3b8', '#a3e635',
]

function resolveTopicColor(label, index) {
  return TOPIC_COLORS[label] || FALLBACK_TOPIC_COLORS[index % FALLBACK_TOPIC_COLORS.length]
}

/**
 * Custo da execução em BRL.
 *
 * Considera além do orquestrador:
 *   - usage do query rewrite (ai_meta.queryRewriteUsage[])
 *   - usage de tools auxiliares com LLM próprio
 *     (ai_meta.toolUsage[]: inscricao, distribuir_humano)
 *   - usage de embeddings RAG (ai_meta.embeddingsUsage[])
 *
 * Fallback gracioso: execuções antigas (sem ai_meta) são contadas só
 * pelo usage do orquestrador, igual antes.
 */
function calcCost(usage, model, aiMeta) {
  let total = calcCostBRL(usage, model)
  const extras = [
    ...((aiMeta?.queryRewriteUsage) || []),
    ...((aiMeta?.toolUsage) || []),
    ...((aiMeta?.embeddingsUsage) || []),
  ]
  for (const x of extras) total += calcCostBRL(x?.usage || {}, x?.model)
  return total
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

function fingerprintError(err) {
  return String(err || '')
    .split('\n')[0]
    .replace(/\b\d+\b/g, 'N')
    .replace(/EX-[\w-]+/g, 'EX-X')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function relativeTime(iso) {
  if (!iso) return '-'
  const diffMs = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h}h`
  const d = Math.floor(h / 24)
  return `há ${d}d`
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

/**
 * Breakdown de custo por componente do agente.
 *
 * Mostra cada parte do pipeline (orquestrador, reescrita de query,
 * embeddings, tools auxiliares) com seu custo, % do total, modelo
 * usado e tokens consumidos. O custo total acima do card é a soma
 * dessas barras (igual ao KPI "Custo estimado").
 */
function CostBreakdown({ items, total }) {
  if (!items || items.length === 0) return <div className="empty">Sem dados no período</div>
  const maxCost = Math.max(...items.map((d) => d.cost)) || 1
  return (
    <div className="hbars">
      {items.map((d, i) => {
        const Icon = d.icon
        const pct = total > 0 ? (d.cost / total) * 100 : 0
        const fillPct = (d.cost / maxCost) * 100
        const tokensLabel = d.tokens > 0 ? `${d.tokens.toLocaleString('pt-BR')} tokens` : 'sem uso'
        const modelsLabel = d.models?.length ? d.models.join(', ') : '—'
        return (
          <div key={d.key || i} className="hbar-row">
            <div className="hbar-label-row">
              <div className="hbar-name">
                <Icon size={13} style={{ color: d.color, flexShrink: 0 }} />
                <span>{d.label}</span>
                <span className="card-title-sub" style={{ marginLeft: 6, fontSize: 11 }}>
                  {modelsLabel} · {tokensLabel}
                </span>
              </div>
              <div className="hbar-value tnum">
                {formatBRL(d.cost)}
                <span className="hbar-pct">{pct.toFixed(1)}%</span>
              </div>
            </div>
            <div className="hbar-track">
              <div
                className="hbar-fill"
                style={{ width: `${fillPct}%`, background: d.color }}
                title={d.hint}
              />
            </div>
          </div>
        )
      })}
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
  const topicsCount = data.length
  const GAP = data.length > 1 ? 3 : 0
  let offset = 0

  return (
    <div className="donut-wrap">
      <div style={{ position: 'relative', width: 150, height: 150, flexShrink: 0 }}>
        <svg width="150" height="150" viewBox="0 0 150 150">
          <circle cx="75" cy="75" r={R} fill="none" stroke="var(--bg-4)" strokeWidth={SW} />
          {data.map((d, i) => {
            const fullLen = (d.value / total) * C
            const len = Math.max(0, fullLen - GAP)
            const el = (
              <circle key={i} cx="75" cy="75" r={R} fill="none"
                stroke={d.color} strokeWidth={SW} strokeLinecap="round"
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 75 75)" />
            )
            offset += fullLen
            return el
          })}
        </svg>
        <div className="donut-center">
          <div>
            <div className="donut-center-val tnum">{topicsCount.toLocaleString('pt-BR')}</div>
            <div className="donut-center-lbl">{topicsCount === 1 ? 'tópico' : 'tópicos'}</div>
          </div>
        </div>
      </div>
      <div className="donut-legend">
        {data.map((d, i) => (
          <div key={i} className="legend-row" style={{ '--topic-color': d.color }}>
            <span className="legend-dot" style={{ background: d.color }} />
            <span className="legend-name">{d.label}</span>
            <span className="legend-val tnum">{d.value.toLocaleString('pt-BR')}</span>
            <span className="legend-pct tnum">{((d.value / total) * 100).toFixed(0)}%</span>
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

export default function Dashboard({ onSelectExecution }) {
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(true)
  const [activePreset, setActivePreset] = useState(7)
  const [showAllErrors, setShowAllErrors] = useState(false)

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
    const cost = executions.reduce((sum, e) => sum + calcCost(e.usage, e.model, e.aiMeta), 0)
    const errors = executions.filter((e) => e.error).length
    const avgTime = executions.length > 0
      ? Math.round(executions.reduce((sum, e) => sum + (e.totalDurationMs || 0), 0) / executions.length)
      : 0

    // Breakdown de custo por componente — útil pra identificar quem está
    // gastando mais (orquestrador, reescrita de query, embeddings ou
    // tools auxiliares com LLM próprio como inscricao/distribuir_humano).
    let costOrchestrator = 0
    let costRewrite = 0
    let costEmbeddings = 0
    let costAuxTools = 0
    let tokensOrchestrator = 0
    let tokensRewrite = 0
    let tokensEmbeddings = 0
    let tokensAuxTools = 0
    const modelsByComponent = {
      orchestrator: new Set(),
      rewrite: new Set(),
      embeddings: new Set(),
      auxTools: new Set(),
    }
    executions.forEach((e) => {
      costOrchestrator += calcCostBRL(e.usage || {}, e.model)
      tokensOrchestrator += Number(e.usage?.total_tokens) || 0
      if (e.model) modelsByComponent.orchestrator.add(e.model)

      for (const u of e.aiMeta?.queryRewriteUsage || []) {
        costRewrite += calcCostBRL(u.usage || {}, u.model)
        tokensRewrite += Number(u.usage?.total_tokens) || 0
        if (u.model) modelsByComponent.rewrite.add(u.model)
      }
      for (const u of e.aiMeta?.embeddingsUsage || []) {
        costEmbeddings += calcCostBRL(u.usage || {}, u.model)
        tokensEmbeddings += Number(u.usage?.total_tokens) || Number(u.usage?.prompt_tokens) || 0
        if (u.model) modelsByComponent.embeddings.add(u.model)
      }
      for (const u of e.aiMeta?.toolUsage || []) {
        costAuxTools += calcCostBRL(u.usage || {}, u.model)
        tokensAuxTools += Number(u.usage?.total_tokens) || 0
        if (u.model) modelsByComponent.auxTools.add(u.model)
      }
    })
    const costBreakdown = [
      {
        key: 'orchestrator',
        label: 'Orquestrador',
        hint: 'LLM principal que decide qual tool usar e responde ao cliente.',
        cost: costOrchestrator,
        tokens: tokensOrchestrator,
        models: [...modelsByComponent.orchestrator],
        color: '#34d399',
        icon: Bot,
      },
      {
        key: 'rewrite',
        label: 'Reescrita de query',
        hint: 'LLM nano que transforma a pergunta do cliente em uma query melhor antes do RAG.',
        cost: costRewrite,
        tokens: tokensRewrite,
        models: [...modelsByComponent.rewrite],
        color: '#c084fc',
        icon: Wand2,
      },
      {
        key: 'embeddings',
        label: 'Embeddings (RAG)',
        hint: 'text-embedding-3-small para buscar nos documentos do Supabase.',
        cost: costEmbeddings,
        tokens: tokensEmbeddings,
        models: [...modelsByComponent.embeddings],
        color: '#38bdf8',
        icon: Layers,
      },
      {
        key: 'auxTools',
        label: 'Tools auxiliares',
        hint: 'LLMs internos das tools (ex.: resumo da inscrição / distribuição humana).',
        cost: costAuxTools,
        tokens: tokensAuxTools,
        models: [...modelsByComponent.auxTools],
        color: '#f472b6',
        icon: Wrench,
      },
    ]

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
      costBreakdown,
    }
  }, [executions, startDate, endDate])

  const errorData = useMemo(() => {
    const errosNaJanela = executions.filter((e) => e.error)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const errosUltimas24h = errosNaJanela.filter((e) => new Date(e.timestamp).getTime() >= cutoff)

    const groupMap = {}
    for (const e of errosNaJanela) {
      const fp = fingerprintError(e.error)
      if (!groupMap[fp]) {
        groupMap[fp] = { fingerprint: fp, count: 0, ultima: null, exemplo: null }
      }
      groupMap[fp].count++
      if (!groupMap[fp].ultima || new Date(e.timestamp) > new Date(groupMap[fp].ultima.timestamp)) {
        groupMap[fp].ultima = { timestamp: e.timestamp, executionId: e.id, lead: e.lead || e.leadId || null }
        groupMap[fp].exemplo = e
      }
    }

    const gruposErro = Object.values(groupMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    let dominante = null
    if (errosUltimas24h.length > 0) {
      const map24 = {}
      for (const e of errosUltimas24h) {
        const fp = fingerprintError(e.error)
        map24[fp] = (map24[fp] || 0) + 1
      }
      dominante = Object.entries(map24).sort((a, b) => b[1] - a[1])[0]
    }

    return { errosNaJanela, errosUltimas24h, gruposErro, dominante }
  }, [executions])

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
            {errorData.errosUltimas24h.length > 0 && (
              <div
                role="alert"
                style={{
                  padding: '10px 14px',
                  background: 'oklch(68% 0.20 25 / 0.12)',
                  border: '1px solid oklch(68% 0.20 25 / 0.35)',
                  borderRadius: 6,
                  marginBottom: 12,
                  fontSize: 13,
                  color: 'var(--danger, oklch(68% 0.20 25))',
                  cursor: 'pointer',
                  lineHeight: 1.5,
                  userSelect: 'none',
                }}
                onClick={() => document.getElementById('erros-painel')?.scrollIntoView({ behavior: 'smooth' })}
              >
                Atenção: {errorData.errosUltimas24h.length} erro{errorData.errosUltimas24h.length !== 1 ? 's' : ''} nas últimas 24h.
                {errorData.dominante && (
                  <> Padrão dominante: &ldquo;{errorData.dominante[0]}&rdquo; ({errorData.dominante[1]}&times; nas últimas 24h).</>
                )}
                {' '}Veja detalhes abaixo.
              </div>
            )}

            <div className="kpi-grid">
              <KPI icon={MessageSquare} label="Mensagens" value={stats.messagesCount} />
              <KPI icon={Zap} label="Tokens usados" value={stats.tokens > 1000000 ? (stats.tokens/1000000).toFixed(2) : stats.tokens.toLocaleString('pt-BR')} unit={stats.tokens > 1000000 ? 'M' : ''} sub="Total de tokens consumidos" />
              <KPI icon={DollarSign} label="Custo estimado" value={formatBRL(stats.cost)} sub="Soma de todos os componentes" />
              <KPI icon={Clock} label="Tempo médio" value={stats.avgTime > 0 ? (stats.avgTime / 1000).toFixed(1) : '-'} unit={stats.avgTime > 0 ? 's' : ''} />
              <KPI icon={AlertTriangle} label="Erros" value={stats.errorsCount} sub={stats.messagesCount > 0 ? `${((stats.errorsCount / stats.messagesCount) * 100).toFixed(1)}% do total` : ''} />
            </div>

            <div className="card">
              <div className="card-header">
                <div className="card-title">
                  <DollarSign size={14} />
                  Custo por componente
                </div>
                <span className="card-title-sub">{formatBRL(stats.cost)} no total</span>
              </div>
              <div className="card-body">
                <CostBreakdown items={stats.costBreakdown} total={stats.cost} />
              </div>
            </div>

            <div id="erros-painel" className="card">
              <div className="card-header">
                <div className="card-title">
                  <AlertTriangle size={14} />
                  Últimos erros
                </div>
                <span className="card-title-sub">
                  {errorData.errosNaJanela.length} no período
                </span>
              </div>
              <div className="card-body">
                {errorData.errosNaJanela.length === 0 ? (
                  <div className="empty" style={{ color: 'var(--fg-3)', textAlign: 'center', padding: '12px 0' }}>
                    Nenhum erro na janela selecionada.
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {errorData.gruposErro.map((g, i) => (
                        <div
                          key={i}
                          style={{
                            padding: '8px 10px',
                            background: 'var(--bg-2)',
                            border: '1px solid var(--line-1, var(--border-1))',
                            borderRadius: 4,
                          }}
                        >
                          <div
                            style={{
                              fontFamily: 'monospace',
                              fontSize: 12,
                              color: 'var(--fg-1)',
                              wordBreak: 'break-all',
                              marginBottom: 4,
                            }}
                          >
                            {g.fingerprint.length > 120 ? g.fingerprint.slice(0, 120) + '…' : g.fingerprint}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--fg-3)' }}>
                            <span>
                              {g.count} ocorrência{g.count !== 1 ? 's' : ''} · última {relativeTime(g.ultima?.timestamp)}
                            </span>
                            <button
                              type="button"
                              style={{
                                marginLeft: 'auto',
                                background: 'transparent',
                                border: '1px solid var(--border-1)',
                                color: 'var(--fg-2)',
                                padding: '2px 8px',
                                fontSize: 11,
                                borderRadius: 3,
                                cursor: 'pointer',
                              }}
                              onClick={() => onSelectExecution?.(g.ultima?.executionId)}
                            >
                              Ver execução
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    {errorData.errosNaJanela.length > errorData.gruposErro.length && (
                      <button
                        type="button"
                        style={{
                          marginTop: 10,
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--accent)',
                          fontSize: 12,
                          cursor: 'pointer',
                          padding: 0,
                        }}
                        onClick={() => setShowAllErrors((v) => !v)}
                      >
                        {showAllErrors
                          ? '[ - ] Recolher'
                          : `[ + ] Ver todos os ${errorData.errosNaJanela.length} erros`}
                      </button>
                    )}

                    {showAllErrors && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {errorData.errosNaJanela.map((e, i) => (
                          <div
                            key={i}
                            style={{
                              padding: '6px 10px',
                              background: 'var(--bg-2)',
                              border: '1px solid var(--line-1, var(--border-1))',
                              borderRadius: 4,
                              fontSize: 11,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            <span style={{ color: 'var(--fg-3)' }}>{relativeTime(e.timestamp)}</span>
                            {(e.lead || e.leadId) && (
                              <span style={{ color: 'var(--fg-3)' }}>lead {e.lead || e.leadId}</span>
                            )}
                            <span
                              style={{
                                fontFamily: 'monospace',
                                color: 'var(--fg-2)',
                                flexGrow: 1,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {String(e.error || '').split('\n')[0].slice(0, 120)}
                            </span>
                            <button
                              type="button"
                              style={{
                                flexShrink: 0,
                                background: 'transparent',
                                border: '1px solid var(--border-1)',
                                color: 'var(--fg-2)',
                                padding: '1px 6px',
                                fontSize: 11,
                                borderRadius: 3,
                                cursor: 'pointer',
                              }}
                              onClick={() => onSelectExecution?.(e.id)}
                            >
                              Abrir
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
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
                    <Donut data={stats.topicsData.map((d, i) => ({ ...d, color: resolveTopicColor(d.label, i) }))} />
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
