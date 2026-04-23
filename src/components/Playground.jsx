import { useState, useRef, useEffect } from 'react'
import { Send, Settings, Trash2, Bot, User, AlertCircle, Key, Sparkles, Check, DollarSign, FileText, MessageSquare, Phone, Clock } from 'lucide-react'
import { TOOL_DEFINITIONS, TOOL_EXECUTORS } from '../lib/supabaseSearch'
import { generateExecutionId, saveExecution } from '../lib/executionStore'

const MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1']
const DEFAULT_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || ''
const MAX_TOOL_ROUNDS = 5
const DEFAULT_DEBOUNCE_MS = 15000

const CHAT_STORAGE_KEY = 'playground_chat'
const WA_MODE_KEY = 'playground_wa_mode'
const WA_PHONE_KEY = 'playground_wa_phone'
const WA_SESSION_KEY = 'playground_wa_session'

function loadChat() {
  try { return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)) || [] }
  catch { return [] }
}

function generatePlaygroundSessionId() {
  const rand = Math.random().toString(36).slice(2, 10)
  return `playground-${rand}@s.whatsapp.net`
}

function resolveSessionId(phone, fallback) {
  const raw = String(phone || '').trim()
  if (!raw) return fallback
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits) return `${digits}@s.whatsapp.net`
  return fallback
}

export default function Playground({ prompts }) {
  const [messages, setMessages] = useState(loadChat)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [toolStatus, setToolStatus] = useState('')
  const [showConfig, setShowConfig] = useState(false)

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('oai_key') || DEFAULT_API_KEY)
  const [model, setModel] = useState(() => localStorage.getItem('oai_model') || 'gpt-4o-mini')

  const [waMode, setWaMode] = useState(() => localStorage.getItem(WA_MODE_KEY) === '1')
  const [waPhone, setWaPhone] = useState(() => localStorage.getItem(WA_PHONE_KEY) || '')
  const [waSessionId] = useState(() => {
    const existing = localStorage.getItem(WA_SESSION_KEY)
    if (existing) return existing
    const fresh = generatePlaygroundSessionId()
    localStorage.setItem(WA_SESSION_KEY, fresh)
    return fresh
  })
  const [debounceMs, setDebounceMs] = useState(DEFAULT_DEBOUNCE_MS)
  const [waCountdownAt, setWaCountdownAt] = useState(null)
  const [waCountdownRemaining, setWaCountdownRemaining] = useState(0)
  const [waFlushing, setWaFlushing] = useState(false)

  const chatRef = useRef(null)
  const inputRef = useRef(null)
  const flushTimerRef = useRef(null)
  const countdownTimerRef = useRef(null)

  useEffect(() => {
    fetch('/api/evolution/health')
      .then((r) => r.json())
      .then((d) => { if (d?.debounceMs) setDebounceMs(d.debounceMs) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages, toolStatus])

  useEffect(() => {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages))
  }, [messages])

  const saveKey = (k) => { setApiKey(k); localStorage.setItem('oai_key', k) }
  const saveModel = (m) => { setModel(m); localStorage.setItem('oai_model', m) }
  const saveWaMode = (v) => { setWaMode(v); localStorage.setItem(WA_MODE_KEY, v ? '1' : '0') }
  const saveWaPhone = (p) => { setWaPhone(p); localStorage.setItem(WA_PHONE_KEY, p) }

  const clearCountdownInterval = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }

  const clearFlushTimer = () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }

  useEffect(() => () => { clearFlushTimer(); clearCountdownInterval() }, [])

  useEffect(() => {
    if (!waCountdownAt) {
      clearCountdownInterval()
      setWaCountdownRemaining(0)
      return
    }
    const tick = () => {
      const left = Math.max(0, waCountdownAt - Date.now())
      setWaCountdownRemaining(left)
      if (left <= 0) clearCountdownInterval()
    }
    tick()
    countdownTimerRef.current = setInterval(tick, 200)
    return () => clearCountdownInterval()
  }, [waCountdownAt])

  const buildSystemMessage = () => {
    const promptsText = prompts
      .map((p) => `### ${p.name} (${p.type})\n\n${p.body}`)
      .join('\n\n---\n\n')

    const playgroundOverride = `
## INSTRUÇÕES DO PLAYGROUND (PRIORIDADE MÁXIMA)

Você está em um ambiente de teste (Playground). As regras abaixo substituem qualquer instrução conflitante dos prompts acima:

1. RESPONDA SEMPRE EM LINGUAGEM NATURAL, nunca em XML, JSON ou templates estruturados.
2. Você tem 8 tools reais: buscar_precos, buscar_informacoes, buscar_pos, buscar_perguntas, localizacao, inscricao, distribuir_humano e buscar_historico_conversa. USE-AS quando couber.
3. MEMÓRIA: se o telefone do lead estiver disponível no contexto e você ainda não conhecer a conversa prévia, chame buscar_historico_conversa UMA vez no início do turno (limit 8–20) para entender o que já foi conversado antes de responder. Nunca mencione essa consulta ao usuário.
4. Para localização, execute localizacao com o texto completo que o usuário informou (cidade, rua e número ou CEP) e apresente polo, endereço, tempo estimado e o link da rota.
5. Para inscrição, use inscricao com curso e tipo_ingresso. Se a resposta indicar integração pendente (telefone/id_lead), explique ao usuário de forma natural que o cadastro será concluído pelo canal oficial ou pela equipe, sem citar APIs.
6. Quando buscar preços ou informações, apresente os resultados encontrados ao usuário de forma clara e objetiva.
7. Se a busca retornar cursos com nomes parecidos (ex: usuário pediu "Economia" e a base tem "Ciências Econômicas"), apresente os cursos encontrados e pergunte se é o que o usuário procura, em vez de dizer que não encontrou.
8. NÃO mencione ferramentas internas, tools, agentes ou contexto técnico ao usuário.
9. distribuir_humano exige id_lead e telefone; sem integração CRM o modelo pode explicar ao usuário que um humano dará continuidade.
10. Seja direto, profissional e acolhedor.`

    return promptsText + '\n\n---\n\n' + playgroundOverride
  }

  async function callOpenAI(apiMessages) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: apiMessages, tools: TOOL_DEFINITIONS, temperature: 0.7, max_tokens: 2048 }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error?.message || `HTTP ${res.status}`)
    }
    return res.json()
  }

  async function executeToolCalls(toolCalls, trace) {
    const results = []
    for (const tc of toolCalls) {
      const fn = tc.function
      const executor = TOOL_EXECUTORS[fn.name]
      const step = { tool: fn.name, args: {}, result: null, error: null, durationMs: 0 }

      if (!executor) {
        step.error = `Ferramenta "${fn.name}" não disponível`
        trace.push(step)
        results.push({ tool_call_id: tc.id, role: 'tool', content: step.error })
        continue
      }

      const toolLabel = {
        buscar_precos: 'Buscando preços no Supabase',
        buscar_informacoes: 'Buscando informações do curso no Supabase',
        buscar_pos: 'Buscando pós-graduação no Supabase',
        buscar_perguntas: 'Buscando na base de perguntas',
        localizacao: 'Buscando polo mais próximo (Google Maps + base de polos)',
        inscricao: 'Executando fluxo de inscrição (Kommo + Supabase)',
        distribuir_humano: 'Distribuindo para consultor humano (Kommo + fila)',
        buscar_historico_conversa: 'Recuperando histórico da conversa (n8n_chat_histories)',
      }
      setToolStatus(toolLabel[fn.name] || `Executando ${fn.name}...`)

      const t0 = Date.now()
      try {
        const args = JSON.parse(fn.arguments)
        step.args = args
        const result = await executor(args, apiKey)
        step.result = result || 'Nenhum resultado encontrado na base.'
        step.durationMs = Date.now() - t0
        results.push({ tool_call_id: tc.id, role: 'tool', content: step.result })
      } catch (e) {
        step.error = e.message
        step.durationMs = Date.now() - t0
        results.push({ tool_call_id: tc.id, role: 'tool', content: `Erro: ${e.message}` })
      }
      trace.push(step)
    }
    return results
  }

  const effectiveSessionId = () => resolveSessionId(waPhone, waSessionId)

  const runFlush = async () => {
    clearFlushTimer()
    setWaCountdownAt(null)
    setWaFlushing(true)
    setToolStatus('Juntando mensagens do buffer e chamando a IA')
    setLoading(true)
    try {
      const res = await fetch('/api/playground/flush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: effectiveSessionId(),
          telefone: waPhone ? waPhone.replace(/[^0-9]/g, '') : '',
          pushName: 'Playground',
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        setMessages((prev) => [...prev, { role: 'error', content: `Flush: ${data.error || 'erro'}` }])
        return
      }
      if (data.empty) {
        setMessages((prev) => [...prev, { role: 'error', content: 'Buffer vazio ao processar (mensagem já consumida).' }])
        return
      }
      const reply = data.reply || 'Sem resposta.'
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: reply,
        waJoined: data.joined,
        waCount: data.count,
        waUsage: data.usage,
        waDurationMs: data.durationMs,
      }])
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'error', content: `Flush falhou: ${e.message}` }])
    } finally {
      setWaFlushing(false)
      setLoading(false)
      setToolStatus('')
      inputRef.current?.focus()
    }
  }

  const handleSendWhatsapp = async (text) => {
    const sessionId = effectiveSessionId()
    const userMsg = { role: 'user', content: text, waBuffered: true }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    try {
      const res = await fetch('/api/playground/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'error', content: `Erro ao empurrar no buffer: ${e.message}` }])
      return
    }

    clearFlushTimer()
    setWaCountdownAt(Date.now() + debounceMs)
    flushTimerRef.current = setTimeout(() => { runFlush() }, debounceMs)
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (waMode) { handleSendWhatsapp(text); return }
    if (!apiKey) { setShowConfig(true); return }

    const execId = generateExecutionId()
    const execution = {
      id: execId,
      timestamp: new Date().toISOString(),
      userMessage: text,
      model,
      steps: [],
      toolCalls: [],
      response: null,
      error: null,
      totalDurationMs: 0,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
    const t0 = Date.now()

    const userMsg = { role: 'user', content: text }
    const updated = [...messages, userMsg]
    setMessages(updated)
    setInput('')
    setLoading(true)
    setToolStatus('')

    const apiMessages = [
      { role: 'system', content: buildSystemMessage() },
      ...updated,
    ]

    try {
      let round = 0
      while (round < MAX_TOOL_ROUNDS) {
        execution.steps.push({ type: 'llm_call', round, messagesCount: apiMessages.length })
        const data = await callOpenAI(apiMessages)
        const choice = data.choices?.[0]
        const msg = choice?.message
        if (!msg) throw new Error('Sem resposta da API.')

        if (data.usage) {
          execution.usage.prompt_tokens += data.usage.prompt_tokens || 0
          execution.usage.completion_tokens += data.usage.completion_tokens || 0
          execution.usage.total_tokens += data.usage.total_tokens || 0
        }

        if (choice.finish_reason === 'tool_calls' || msg.tool_calls?.length > 0) {
          apiMessages.push(msg)
          const toolTrace = []
          const toolResults = await executeToolCalls(msg.tool_calls, toolTrace)
          execution.toolCalls.push(...toolTrace)
          execution.steps.push({ type: 'tool_execution', round, tools: toolTrace.map((t) => t.tool) })
          apiMessages.push(...toolResults)
          round++
          continue
        }

        setToolStatus('')
        const reply = msg.content || 'Sem resposta.'
        execution.response = reply
        execution.totalDurationMs = Date.now() - t0
        saveExecution(execution)
        setMessages((prev) => [...prev, { role: 'assistant', content: reply, execId }])
        return
      }

      setToolStatus('')
      const errMsg = 'Limite de buscas atingido. Tente reformular a pergunta.'
      execution.error = errMsg
      execution.totalDurationMs = Date.now() - t0
      saveExecution(execution)
      setMessages((prev) => [...prev, { role: 'error', content: errMsg }])
    } catch (e) {
      setToolStatus('')
      execution.error = e.message
      execution.totalDurationMs = Date.now() - t0
      saveExecution(execution)
      setMessages((prev) => [...prev, { role: 'error', content: e.message }])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const clearChat = () => { setMessages([]); localStorage.removeItem(CHAT_STORAGE_KEY); inputRef.current?.focus() }

  const [copyToast, setCopyToast] = useState(false)

  const copyExecId = (id) => {
    navigator.clipboard?.writeText(id)
    setCopyToast(true)
    setTimeout(() => setCopyToast(false), 1500)
  }

  return (
    <div className="playground">
      {copyToast && (
        <div className="toast">
          <Check size={14} className="toast-check" />
          ID copiado
        </div>
      )}

      {/* Header */}
      <div className="pg-header">
        <div className="pg-title-group">
          <h1 className="page-title" style={{ fontSize: 18 }}>Teste IA</h1>
          <span className="model-pill">
            <span className="dot" style={{ background: 'var(--success)' }} />
            {model}
          </span>
          <span className="badge accent">
            <Sparkles size={11} />
            {prompts.length} prompts ativos
          </span>
          {waMode && (
            <span className="badge" style={{ background: 'rgba(16,185,129,.12)', color: '#10b981', border: '1px solid rgba(16,185,129,.25)' }}>
              <Phone size={11} />
              Simulando WhatsApp · {Math.round(debounceMs / 1000)}s
            </span>
          )}
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={clearChat}>
            <Trash2 size={14} />
            <span>Limpar</span>
          </button>
          <button className={`btn-icon${showConfig ? ' active' : ''}`} onClick={() => setShowConfig(!showConfig)}>
            <Settings size={15} />
          </button>
        </div>
      </div>

      {/* Config panel */}
      {showConfig && (
        <div className="pg-config">
          <div>
            <label className="field-label">
              <Key size={12} />
              API Key OpenAI
            </label>
            <input className="input" type="password" placeholder="sk-..." value={apiKey} onChange={(e) => saveKey(e.target.value)} />
          </div>
          <div>
            <label className="field-label">
              <Bot size={12} />
              Modelo
            </label>
            <select className="select" value={model} onChange={(e) => saveModel(e.target.value)}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">
              <Phone size={12} />
              Simular WhatsApp
            </label>
            <label className="wa-toggle">
              <input
                type="checkbox"
                checked={waMode}
                onChange={(e) => saveWaMode(e.target.checked)}
              />
              <span>
                Buffer + debounce de {Math.round(debounceMs / 1000)}s (mesma tabela do webhook real).
              </span>
            </label>
          </div>
          <div>
            <label className="field-label">
              <Phone size={12} />
              Telefone do lead (opcional)
            </label>
            <input
              className="input"
              placeholder="5511998209798"
              value={waPhone}
              onChange={(e) => saveWaPhone(e.target.value)}
              disabled={!waMode}
            />
          </div>
          <div className="pg-config-info">
            Todos os {prompts.length} prompts são enviados juntos como system message.
            {DEFAULT_API_KEY ? ' API Key configurada via .env.' : ' A API Key fica salva no seu navegador.'}
            {' '}Tools de busca no Supabase ativas.
            {waMode && (
              <>
                {' '}· <strong>Modo WhatsApp ativo</strong>: suas mensagens são empurradas para <code>message_buffer</code> e, após {Math.round(debounceMs / 1000)}s sem novidades, o servidor junta tudo, apaga o buffer e chama o agente (o mesmo fluxo do webhook da Evolution).
                {waPhone
                  ? <> A memória <code>n8n_chat_histories</code> é consultada para o telefone <code>{waPhone.replace(/[^0-9]/g, '')}</code>.</>
                  : <> Sem telefone informado, a memória do WhatsApp não é consultada (sessão anônima do Playground).</>
                }
              </>
            )}
          </div>
        </div>
      )}

      {waMode && waCountdownAt && !waFlushing && (
        <div className="wa-countdown">
          <Clock size={13} />
          <span>Aguardando mais mensagens</span>
          <div className="wa-countdown-bar">
            <div
              className="wa-countdown-fill"
              style={{ width: `${Math.max(0, Math.min(100, (waCountdownRemaining / debounceMs) * 100))}%` }}
            />
          </div>
          <span className="wa-countdown-time">{(waCountdownRemaining / 1000).toFixed(1)}s</span>
        </div>
      )}

      {/* Chat */}
      <div className="pg-chat" ref={chatRef}>
        {messages.length === 0 && (
          <div className="pg-empty">
            <div className="pg-empty-icon">
              <Bot size={22} />
            </div>
            <h3>Envie uma mensagem para testar a IA</h3>
            <p>
              Usa todos os {prompts.length} prompts como system message + 8 tools (Supabase, Kommo, memória WhatsApp).
              {waMode && <> <br /><strong>Modo WhatsApp</strong>: cada mensagem é empurrada no <code>message_buffer</code> e aguarda {Math.round(debounceMs / 1000)}s antes de chamar o agente.</>}
            </p>
            <div className="pg-empty-suggestions">
              {[
                { icon: DollarSign, text: 'Qual o valor do curso de Direito?' },
                { icon: FileText, text: 'Quais pós-graduações em área de saúde?' },
                { icon: MessageSquare, text: 'Como funciona a matrícula para 2026?' },
              ].map((s, i) => (
                <button key={i} className="suggest-btn" onClick={() => { setInput(s.text); }}>
                  <s.icon size={14} />
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="msg-avatar">
              {m.role === 'user' ? <User size={14} /> : m.role === 'error' ? <AlertCircle size={14} /> : <Sparkles size={14} />}
            </div>
            <div className="msg-content">
              <div className="msg-meta-row">
                <span className="msg-role">
                  {m.role === 'user' ? 'Você' : m.role === 'error' ? 'Erro' : 'Assistente'}
                </span>
                {m.waBuffered && (
                  <span className="exec-pill" title="Mensagem empurrada no message_buffer, aguardando flush">
                    no buffer
                  </span>
                )}
                {m.waCount > 1 && (
                  <span className="exec-pill" title="Quantidade de mensagens juntadas neste flush">
                    {m.waCount} mensagens juntadas
                  </span>
                )}
                {m.execId && (
                  <button className="exec-pill" onClick={() => copyExecId(m.execId)}>
                    {m.execId}
                  </button>
                )}
              </div>
              <div className="msg-bubble">{m.content}</div>
              {m.waJoined && m.waCount > 1 && (
                <div className="msg-meta-joined" title="Texto combinado enviado ao agente">
                  Juntado: “{m.waJoined}”
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="msg assistant">
            <div className="msg-avatar">
              <Sparkles size={14} />
            </div>
            <div className="msg-content">
              <div className="msg-meta-row">
                <span className="msg-role">Assistente</span>
              </div>
              {toolStatus ? (
                <div className="tool-status">
                  <span className="pulse" />
                  <span>{toolStatus}...</span>
                </div>
              ) : (
                <div className="msg-bubble" style={{ padding: 0, background: 'transparent', border: 0 }}>
                  <div className="typing">
                    <span /><span /><span />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="pg-input-wrap">
        <div className="pg-input-inner">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="Pergunte algo à IA..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className={`pg-send${input.trim() ? ' ready' : ''}`}
            onClick={handleSend}
            disabled={!input.trim() || loading}
          >
            <Send size={15} />
          </button>
        </div>
        <div className="pg-input-hint">
          <kbd>Enter</kbd>
          <span>enviar</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <kbd>Shift + Enter</kbd>
          <span>quebrar linha</span>
        </div>
      </div>
    </div>
  )
}
