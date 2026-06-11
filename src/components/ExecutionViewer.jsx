import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Search, Trash2, Clock, Bot, Database,
  ChevronRight, ChevronDown, AlertCircle,
  User, Cpu, Zap, Copy, RefreshCw,
  Check, ListChecks, Wand2, BookOpen,
  Send, MessageSquare, Tag, BookMarked,
} from 'lucide-react'
import { getAllExecutions, clearExecutions, reindexPerguntasEmbeddings } from '../lib/executionStore'

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function truncate(text, max = 200) {
  if (!text) return '(vazio)'
  return text.length > max ? text.substring(0, max) + '…' : text
}

function RoundDetail({ round }) {
  const [open, setOpen] = useState(false)
  const [showMsgs, setShowMsgs] = useState(false)
  const decisionLabel = round.decision === 'tool_calls' ? 'chamou tools' : 'respondeu'
  const toolsSolicitadas = (round.llmResponse?.tool_calls || []).map((tc) => tc.name).join(', ')
  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        background: 'var(--bg-2, rgba(255,255,255,0.03))',
        border: '1px solid var(--border-1, rgba(255,255,255,0.06))',
        borderRadius: 4,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span style={{ fontWeight: 600 }}>Round {round.round}</span>
        <span
          className={`badge ${round.decision === 'tool_calls' ? '' : 'success'}`}
          style={{ fontSize: 10 }}
        >
          {decisionLabel}
          {toolsSolicitadas ? ` (${toolsSolicitadas})` : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-3)', fontSize: 11, display: 'flex', gap: 8 }}>
          <span><Clock size={10} /> {round.durationMs}ms</span>
          {round.usage && (
            <span>
              <Zap size={10} /> {round.usage.total_tokens || 0} tok
              <span style={{ color: 'var(--fg-3)' }}>
                {' '}
                ({round.usage.prompt_tokens || 0}→{round.usage.completion_tokens || 0})
              </span>
            </span>
          )}
          {round.finishReason && <span style={{ opacity: 0.7 }}>{round.finishReason}</span>}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <div style={{ marginBottom: 6, color: 'var(--fg-3)' }}>
            Mensagens enviadas: {round.messagesSentCount}
            {' · '}
            <button
              type="button"
              onClick={() => setShowMsgs(!showMsgs)}
              style={{
                background: 'transparent',
                border: '1px solid var(--border-1)',
                color: 'var(--fg-2)',
                padding: '2px 6px',
                fontSize: 11,
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              {showMsgs ? 'ocultar resumo' : 'ver resumo'}
            </button>
          </div>
          {showMsgs && (
            <pre className="flow-content-pre" style={{ maxHeight: 280, overflowY: 'auto' }}>
              {(round.messagesSent || []).map((m, idx) => {
                const tcs = (m.tool_calls || []).map((tc) => `${tc.name}(${tc.arguments || '{}'})`).join(', ')
                const body = m.content == null ? '' : `: ${m.content}`
                const tail = tcs ? ` · tool_calls=[${tcs}]` : ''
                return `[${idx + 1}] ${m.role}${body}${tail}`
              }).join('\n')}
            </pre>
          )}
          <div className="flow-label" style={{ marginTop: 6 }}>Resposta crua do LLM</div>
          <pre className="flow-content-pre" style={{ maxHeight: 240, overflowY: 'auto' }}>
{`role          : ${round.llmResponse?.role || '—'}
finish_reason : ${round.finishReason || '—'}
content       : ${round.llmResponse?.content == null ? '—' : round.llmResponse.content}
${(round.llmResponse?.tool_calls || []).length > 0
  ? `tool_calls    :\n${round.llmResponse.tool_calls.map((tc, i) =>
      `  ${i + 1}. ${tc.name}\n     args: ${tc.arguments || '{}'}`,
    ).join('\n')}`
  : 'tool_calls    : —'}`}
          </pre>
        </div>
      )}
    </div>
  )
}

function FlowStep({ icon: Icon, iconKind, title, duration, headerBadge, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const hasContent = !!children
  return (
    <div className="flow-step">
      <div className={`flow-indicator ${iconKind || ''}`}>
        <Icon size={14} />
      </div>
      <div className="flow-card">
        <div className="flow-card-head" onClick={() => hasContent && setOpen(!open)}>
          <div className="flow-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{title}</span>
            {headerBadge}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {duration != null && (
              <span className="flow-card-duration">
                <Clock size={10} /> {formatDuration(duration)}
              </span>
            )}
            {hasContent && (open ? <ChevronDown size={14} style={{ color: 'var(--fg-3)' }} /> : <ChevronRight size={14} style={{ color: 'var(--fg-3)' }} />)}
          </div>
        </div>
        {open && hasContent && <div className="flow-card-body">{children}</div>}
      </div>
    </div>
  )
}

function ExecutionDetail({ execution, onCopy }) {
  const hasTools = execution.toolCalls?.length > 0
  return (
    <div className="exec-detail">
      <div className="exec-detail-header">
        <div className="exec-detail-id-row">
          <button className="exec-detail-id" onClick={() => { navigator.clipboard?.writeText(execution.id); onCopy() }}>
            {execution.id}
            <Copy size={13} />
          </button>
          <span className={`badge ${execution.error ? 'danger' : 'success'}`}>
            {execution.error ? 'Erro' : 'Sucesso'}
          </span>
        </div>
        <div className="exec-detail-meta">
          <span><Clock size={12} /> {formatTime(execution.timestamp)}</span>
          <span><Cpu size={12} /> {execution.model}</span>
          <span><Zap size={12} /> {formatDuration(execution.totalDurationMs)}</span>
        </div>
      </div>
      <div className="flow-track">
        <FlowStep icon={User} iconKind="" title="Mensagem do usuário" defaultOpen>
          <div className="flow-content-text">{execution.userMessage}</div>
        </FlowStep>
        {execution.aiMeta?.history && (
          <FlowStep
            icon={BookOpen}
            iconKind={execution.aiMeta.history.count > 0 ? 'info' : 'warning'}
            title={`Memória da conversa · ${execution.aiMeta.history.count} mensagens`}
            headerBadge={
              execution.aiMeta.history.count === 0 ? (
                <span style={{ fontSize: 11, color: 'var(--warning, #f59e0b)' }}>
                  ⚠️ histórico vazio
                </span>
              ) : execution.aiMeta.history.source === 'chat_messages_fallback' ? (
                <span style={{ fontSize: 11, color: 'var(--warning, #f59e0b)' }}>
                  ⚠️ via fallback (chat_messages)
                </span>
              ) : null
            }
            defaultOpen={execution.aiMeta.history.count === 0}
          >
            {execution.aiMeta.history.count === 0 ? (
              <div className="flow-content-text" style={{ color: 'var(--fg-3)' }}>
                Nenhuma mensagem de conversa anterior foi injetada no prompt.
                Verifique se a tabela <code>n8n_chat_histories</code> está sendo
                populada (campo <code>session_id</code> = <code>&lt;digitos&gt;@s.whatsapp.net</code>).
                <br />
                Quando isso acontecer com mensagem curta do lead ("Sim", "Ok"),
                o orquestrador agora recebe um aviso explícito para NÃO inventar
                cursos e perguntar o interesse do lead.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                  Mostrando últimas {execution.aiMeta.history.preview?.length || 0} de{' '}
                  {execution.aiMeta.history.count} mensagens injetadas no prompt do orquestrador:
                </div>
                {execution.aiMeta.history.preview?.map((m, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '6px 8px',
                      borderLeft: `3px solid ${m.role === 'user' ? 'var(--accent, #3b82f6)' : 'var(--success, #10b981)'}`,
                      background: 'var(--bg-2, rgba(255,255,255,0.02))',
                      borderRadius: 3,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ fontWeight: 600, marginRight: 6, color: 'var(--fg-2)' }}>
                      {m.role === 'user' ? '👤' : '🤖'} {m.role}:
                    </span>
                    <span style={{ color: 'var(--fg-1)' }}>{m.content}</span>
                  </div>
                ))}
              </div>
            )}
          </FlowStep>
        )}
        {(() => {
          const ctxStep = (execution.steps || []).find((s) => s?.type === 'ctx_snapshot')
          const ctx = ctxStep?.result
          if (!ctx) return null
          return (
            <FlowStep
              icon={ListChecks}
              iconKind="info"
              title="Contexto enviado ao orquestrador"
              defaultOpen={false}
            >
              <pre className="flow-content-pre">{`System prompt : ${ctx.systemPromptChars} chars
Tools         : ${(ctx.toolsAvailable || []).join(', ') || '—'}
Histórico     : ${ctx.historyCount} msg${ctx.historyCount === 1 ? '' : 's'} injetadas${ctx.historySource ? ` (fonte: ${ctx.historySource})` : ''}${ctx.noContextWarning ? '\nBackstop     : ⚠️ aviso "sem contexto + msg ambígua" injetado no system' : ''}
${ctx.contextPreamble ? `Preâmbulo:\n${ctx.contextPreamble}` : 'Preâmbulo: (vazio)'}

Mensagem do user:
${ctx.userMessage || '—'}`}</pre>
            </FlowStep>
          )
        })()}
        {(() => {
          const rounds = (execution.steps || []).filter((s) => s?.type === 'llm_call')
          const totalTokens = rounds.reduce((acc, r) => acc + (r.usage?.total_tokens || 0), 0)
          return (
            <FlowStep
              icon={Bot}
              iconKind="info"
              title={`Orquestrador · ${execution.model}`}
              headerBadge={
                rounds.length > 0 ? (
                  <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    {rounds.length} round{rounds.length === 1 ? '' : 's'} · {totalTokens} tokens
                  </span>
                ) : null
              }
              defaultOpen={rounds.length > 1}
            >
              <div className="flow-content-text">
                Rounds: {rounds.length || 1}
                {hasTools && <><br />Tools chamadas: {execution.toolCalls.map(t => t.tool).join(', ')}</>}
              </div>
              {rounds.map((r, idx) => (
                <RoundDetail key={idx} round={r} />
              ))}
            </FlowStep>
          )
        })()}
        {execution.toolCalls?.map((tc, i) => (
          <FlowStep
            key={i}
            icon={Database}
            iconKind={tc.error ? 'error' : 'success'}
            title={tc.tool.replace('buscar_', 'Buscar ')}
            duration={tc.durationMs}
            // Abre automaticamente quando tem reescrita ou erro pra
            // facilitar a auditoria do LLM nano sem clicar.
            defaultOpen={!!tc.queryRewrite || !!tc.error}
            headerBadge={tc.queryRewrite ? (
              <span
                className={`badge ${tc.queryRewrite.applied ? 'success' : ''}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                title={tc.queryRewrite.applied
                  ? `Reescrita: "${tc.queryRewrite.originalQuery}" → "${tc.queryRewrite.query}"`
                  : `Reescrita pulada (${tc.queryRewrite.reason || 'skip'})`}
              >
                <Wand2 size={10} />
                {tc.queryRewrite.applied
                  ? <>reescrito → <code style={{ fontSize: 10 }}>{tc.queryRewrite.query}</code></>
                  : <>sem reescrita ({tc.queryRewrite.reason || 'skip'})</>}
              </span>
            ) : null}
          >
            <div>
              <div className="flow-section">
                <div className="flow-label">Entrada</div>
                <pre className="flow-content-pre">{JSON.stringify(tc.args, null, 2)}</pre>
              </div>
              {tc.queryRewrite && (
                <div className="flow-section">
                  <div className="flow-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Wand2 size={11} />
                    Reescrita da query (LLM {tc.queryRewrite.model || 'nano'})
                    {tc.queryRewrite.applied
                      ? <span className="badge success" style={{ marginLeft: 4 }}>aplicada</span>
                      : <span className="badge" style={{ marginLeft: 4 }}>{tc.queryRewrite.reason || 'skip'}</span>}
                  </div>
                  <pre className="flow-content-pre">
{`Original    : ${tc.queryRewrite.originalQuery ?? '-'}
Reescrita   : ${tc.queryRewrite.applied ? tc.queryRewrite.query : '(usou a original)'}
Motivo      : ${tc.queryRewrite.reason || '-'}
Tempo       : ${tc.queryRewrite.elapsedMs ?? 0} ms` +
(tc.queryRewrite.usage
  ? `
Tokens LLM  : prompt=${tc.queryRewrite.usage.prompt_tokens || 0}, completion=${tc.queryRewrite.usage.completion_tokens || 0}, total=${tc.queryRewrite.usage.total_tokens || 0}`
  : '')}
                  </pre>
                </div>
              )}
              <div className="flow-section">
                <div className="flow-label">{tc.error ? 'Erro' : 'Resultado'}</div>
                <pre className="flow-content-pre" style={tc.error ? { color: 'var(--danger)' } : {}}>
                  {tc.error || truncate(tc.result, 4000)}
                </pre>
              </div>
            </div>
          </FlowStep>
        ))}
        {execution.response && (
          <FlowStep icon={Bot} iconKind="success" title="Resposta final" defaultOpen>
            <div className="flow-content-text">{execution.response}</div>
          </FlowStep>
        )}
        {(() => {
          // Renderiza os steps de pós-resposta: kommo lookup, envio WhatsApp,
          // persistência da conversa. Se algum deles falhou, abre automático
          // pra ficar visível.
          const steps = Array.isArray(execution.steps) ? execution.steps : []
          const lookupStep = steps.find((s) => s?.tool === 'kommo.findLeadByPhone')
          const sendStep = steps.find((s) => s?.tool === 'whatsapp.sendMessageWithNote')
          const histStep = steps.find((s) => s?.tool === 'history.saveConversation')
          const out = []
          if (lookupStep) {
            out.push(
              <FlowStep
                key="kommoLookup"
                icon={Tag}
                iconKind="info"
                title={`Lead Kommo · ${lookupStep.result?.leadId || 'não encontrado'}`}
              >
                <div className="flow-content-text" style={{ fontSize: 12 }}>
                  ID resolvido pra criar nota e referenciar nas tools:{' '}
                  <code>{lookupStep.result?.leadId ?? '—'}</code>
                </div>
              </FlowStep>,
            )
          }
          if (sendStep) {
            const r = sendStep.result || {}
            const failed = r.ok === false
            out.push(
              <FlowStep
                key="sendWA"
                icon={Send}
                iconKind={failed ? 'error' : 'success'}
                title={`Envio WhatsApp · ${r.sent || 0}/${r.total || 0} partes`}
                defaultOpen={failed}
                headerBadge={
                  failed ? (
                    <span style={{ fontSize: 11, color: 'var(--danger, #ef4444)' }}>✗ falhou</span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--success, #10b981)' }}>✓ enviado</span>
                  )
                }
              >
                {failed ? (
                  <div className="flow-content-text" style={{ color: 'var(--danger)' }}>
                    {r.error || 'Erro desconhecido — verifique WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN. Teste em /api/whatsapp/health.'}
                  </div>
                ) : (
                  <div className="flow-content-text" style={{ fontSize: 12 }}>
                    Mensagem entregue ao WhatsApp Cloud API ({r.sent} parte{r.sent === 1 ? '' : 's'}).
                    Deve ter aparecido como nota no Kommo.
                  </div>
                )}
              </FlowStep>,
            )
          }
          if (histStep) {
            const r = histStep.result || {}
            const failed = r.ok === false
            out.push(
              <FlowStep
                key="hist"
                icon={MessageSquare}
                iconKind={failed ? 'warning' : 'success'}
                title="Memória da conversa salva"
                defaultOpen={failed}
                headerBadge={
                  failed ? (
                    <span style={{ fontSize: 11, color: 'var(--warning, #f59e0b)' }}>⚠ falhas</span>
                  ) : null
                }
              >
                {failed ? (
                  <div className="flow-content-text" style={{ color: 'var(--warning)' }}>
                    Substeps com falha: {(r.failedSubsteps || []).join(', ') || '(desconhecido)'}
                  </div>
                ) : (
                  <div className="flow-content-text" style={{ fontSize: 12 }}>
                    Mensagem do user + resposta da IA gravadas em <code>n8n_chat_histories</code>.
                  </div>
                )}
              </FlowStep>,
            )
          }
          return out
        })()}
        {execution.error && (
          <FlowStep icon={AlertCircle} iconKind="error" title="Erro" defaultOpen>
            <div className="flow-content-text" style={{ color: 'var(--danger)' }}>{execution.error}</div>
          </FlowStep>
        )}
      </div>
    </div>
  )
}

export default function ExecutionViewer() {
  const [searchId, setSearchId] = useState('')
  const [selected, setSelected] = useState(null)
  const [executions, setExecutions] = useState([])
  const [loading, setLoading] = useState(true)
  const [copyToast, setCopyToast] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [reindexResult, setReindexResult] = useState(null)

  const fetchExecutions = useCallback(async () => {
    setLoading(true)
    const data = await getAllExecutions()
    setExecutions(data)
    setLoading(false)
  }, [])

  useEffect(() => { fetchExecutions() }, [fetchExecutions])

  useEffect(() => {
    if (executions.length === 0) return
    const pending = sessionStorage.getItem('pendingExecutionId')
    if (!pending) return
    sessionStorage.removeItem('pendingExecutionId')
    const match = executions.find((e) => e.id === pending)
    if (match) setSelected(match)
  }, [executions])

  const handleClear = async () => {
    if (window.confirm('Limpar todas as execuções?')) {
      await clearExecutions()
      setExecutions([])
      setSelected(null)
    }
  }

  const showCopyToast = () => {
    setCopyToast(true)
    setTimeout(() => setCopyToast(false), 1500)
  }

  const onReindexPerguntas = async (opts = {}) => {
    const force = opts.force === true
    const msg = force
      ? 'FORÇA o reindex de TODAS as linhas do FAQ. Use depois de mudar a normalização. Confirma?'
      : 'Gera embedding só das linhas novas do FAQ (embedding NULL). Use depois de inserir uma pergunta via SQL. Confirma?'
    if (!window.confirm(msg)) return
    setReindexing(true)
    setReindexResult(null)
    try {
      const r = await reindexPerguntasEmbeddings({ force })
      setReindexResult(r)
    } catch (e) {
      setReindexResult({ ok: false, error: e?.message || 'falhou' })
    } finally {
      setReindexing(false)
    }
  }

  const filtered = useMemo(() => {
    if (!searchId.trim()) return executions
    const q = searchId.trim().toLowerCase()
    return executions.filter((e) =>
      e.id.toLowerCase().includes(q) ||
      e.userMessage.toLowerCase().includes(q)
    )
  }, [executions, searchId])

  const handleSelect = (exec) => {
    setSelected(exec.id === selected?.id ? null : exec)
  }

  const copyId = (id, evt) => {
    evt.stopPropagation()
    navigator.clipboard?.writeText(id)
    showCopyToast()
  }

  return (
    <div className="exec-viewer">
      {copyToast && <div className="toast"><Check size={14} className="toast-check" /> ID copiado</div>}

      <div className="pg-header">
        <div className="pg-title-group">
          <h1 className="page-title" style={{ fontSize: 18 }}>Execuções</h1>
          <span className="badge">{executions.length} registradas</span>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-ghost"
            onClick={() => onReindexPerguntas({ force: false })}
            disabled={reindexing}
            title="Gera embedding das linhas novas do FAQ (documents_perguntas) — use depois de inserir uma pergunta via SQL"
          >
            <BookMarked size={14} /> <span>{reindexing ? 'Indexando…' : 'Reindexar FAQ'}</span>
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => onReindexPerguntas({ force: true })}
            disabled={reindexing}
            title="FORÇA reindex de TODAS as linhas do FAQ — use quando mudar a normalização"
          >
            <BookMarked size={14} /> <span>{reindexing ? 'Forçando…' : 'Reindexar FAQ (forçar)'}</span>
          </button>
          <button className="btn btn-ghost" onClick={fetchExecutions}>
            <RefreshCw size={14} /> <span>Atualizar</span>
          </button>
          <button className="btn btn-ghost btn-danger-ghost" onClick={handleClear}>
            <Trash2 size={14} /> <span>Limpar</span>
          </button>
        </div>
      </div>

      {reindexResult && (
        <div
          style={{
            padding: '8px 12px',
            background: reindexResult.ok
              ? 'rgba(34,197,94,0.08)'
              : 'rgba(239,68,68,0.08)',
            border: `1px solid ${reindexResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 12,
          }}
        >
          {reindexResult.ok ? (
            <>
              ✓ Reindex FAQ ok · {reindexResult.total} linha{reindexResult.total === 1 ? '' : 's'} processada{reindexResult.total === 1 ? '' : 's'}
              {' '}({reindexResult.batches} batch{reindexResult.batches === 1 ? '' : 'es'}, {reindexResult.durationMs}ms,{' '}
              {reindexResult.usage?.total_tokens || 0} tokens)
              {reindexResult.message ? ` · ${reindexResult.message}` : ''}
            </>
          ) : (
            <>✗ Erro: {reindexResult.error || 'falha desconhecida'}</>
          )}
        </div>
      )}

      <div className="exec-layout">
        <div className="exec-list-panel">
          <div className="exec-list-head">
            <div className="search-wrap">
              <Search size={14} className="search-icon" />
              <input className="input" placeholder="Buscar por ID ou mensagem..."
                value={searchId} onChange={(e) => setSearchId(e.target.value)} />
            </div>
          </div>
          <div className="exec-list-items">
            {loading && <div className="empty"><div className="loader" style={{ margin: '0 auto' }} /></div>}
            {!loading && filtered.length === 0 && (
              <div className="empty">
                <ListChecks size={28} className="empty-icon" />
                <div className="empty-title">Nenhuma execução</div>
                <div>Use o Teste IA para gerar</div>
              </div>
            )}
            {!loading && filtered.map((exec) => (
              <div key={exec.id} className={`exec-item${selected?.id === exec.id ? ' selected' : ''}`}
                onClick={() => handleSelect(exec)}>
                <div className="exec-item-head">
                  <button className="exec-item-id" onClick={(e) => copyId(exec.id, e)}>
                    {exec.id}
                    <Copy size={10} />
                  </button>
                  <span className={`status-dot ${exec.error ? 'error' : 'success'}`} />
                </div>
                <div className="exec-item-msg">{truncate(exec.userMessage, 80)}</div>
                <div className="exec-item-footer tnum">
                  <span><Clock size={10} /> {formatTime(exec.timestamp)}</span>
                  <span><Zap size={10} /> {formatDuration(exec.totalDurationMs)}</span>
                  {exec.toolCalls?.length > 0 && (
                    <span><Database size={10} /> {exec.toolCalls.length} tool{exec.toolCalls.length > 1 ? 's' : ''}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="exec-detail-panel">
          {selected ? (
            <ExecutionDetail execution={selected} onCopy={showCopyToast} />
          ) : (
            <div className="exec-detail-empty">
              <div>
                <div className="empty-icon"><ListChecks size={24} /></div>
                <div style={{ color: 'var(--fg-2)', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Selecione uma execução</div>
                <div style={{ fontSize: 12 }}>Ou busque pelo ID no Teste IA</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
