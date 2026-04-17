import { useState, useRef, useEffect } from 'react'
import { Send, Settings, Trash2, Bot, User, AlertCircle, Key, ChevronDown, Database } from 'lucide-react'
import { TOOL_DEFINITIONS, TOOL_EXECUTORS } from '../lib/supabaseSearch'

const MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1']
const DEFAULT_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || ''
const MAX_TOOL_ROUNDS = 5

export default function Playground({ prompts }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [toolStatus, setToolStatus] = useState('')
  const [showConfig, setShowConfig] = useState(false)

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('oai_key') || DEFAULT_API_KEY)
  const [model, setModel] = useState(() => localStorage.getItem('oai_model') || 'gpt-4o-mini')

  const chatRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [messages, toolStatus])

  const saveKey = (k) => {
    setApiKey(k)
    localStorage.setItem('oai_key', k)
  }

  const saveModel = (m) => {
    setModel(m)
    localStorage.setItem('oai_model', m)
  }

  const buildSystemMessage = () => {
    const promptsText = prompts
      .map((p) => `### ${p.name} (${p.type})\n\n${p.body}`)
      .join('\n\n---\n\n')

    const playgroundOverride = `
## INSTRUÇÕES DO PLAYGROUND (PRIORIDADE MÁXIMA)

Você está em um ambiente de teste (Playground). As regras abaixo substituem qualquer instrução conflitante dos prompts acima:

1. RESPONDA SEMPRE EM LINGUAGEM NATURAL, nunca em XML, JSON ou templates estruturados.
2. Você tem 4 tools reais disponíveis: buscar_precos, buscar_informacoes, buscar_pos, buscar_perguntas. USE-AS SEMPRE que o usuário perguntar sobre cursos, preços ou tiver dúvidas.
3. Quando buscar preços ou informações, apresente os resultados encontrados ao usuário de forma clara e objetiva.
4. Se a busca retornar cursos com nomes parecidos (ex: usuário pediu "Economia" e a base tem "Ciências Econômicas"), apresente os cursos encontrados e pergunte se é o que o usuário procura, em vez de dizer que não encontrou.
5. NÃO mencione ferramentas internas, tools, agentes ou contexto técnico ao usuário.
6. As tools inscricao, distribuir_humano e localizacao NÃO existem neste ambiente. Ignore instruções sobre elas.
7. Seja direto, profissional e acolhedor.`

    return promptsText + '\n\n---\n\n' + playgroundOverride
  }

  async function callOpenAI(apiMessages) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        tools: TOOL_DEFINITIONS,
        temperature: 0.7,
        max_tokens: 2048,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error?.message || `HTTP ${res.status}`)
    }
    return res.json()
  }

  async function executeToolCalls(toolCalls) {
    const results = []
    for (const tc of toolCalls) {
      const fn = tc.function
      const executor = TOOL_EXECUTORS[fn.name]
      if (!executor) {
        results.push({ tool_call_id: tc.id, role: 'tool', content: `Ferramenta "${fn.name}" não disponível neste ambiente de teste.` })
        continue
      }
      const toolLabel = {
        buscar_precos: 'Buscando preços no Supabase',
        buscar_informacoes: 'Buscando informações do curso no Supabase',
        buscar_pos: 'Buscando pós-graduação no Supabase',
        buscar_perguntas: 'Buscando na base de perguntas',
      }
      setToolStatus(toolLabel[fn.name] || `Executando ${fn.name}...`)
      try {
        const args = JSON.parse(fn.arguments)
        console.log(`[Tool] Chamando ${fn.name}(${JSON.stringify(args)})`)
        const result = await executor(args, apiKey)
        const preview = result ? result.substring(0, 150) : '(vazio)'
        console.log(`[Tool] ${fn.name} retornou ${result?.length || 0} chars:`, preview)
        results.push({ tool_call_id: tc.id, role: 'tool', content: result || 'Nenhum resultado encontrado na base.' })
      } catch (e) {
        const errMsg = `${fn.name}: ${e.message}`
        console.error(`[Tool] ERRO em ${fn.name}:`, e)
        results.push({ tool_call_id: tc.id, role: 'tool', content: `Erro ao buscar: ${errMsg}` })
      }
    }
    return results
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!apiKey) {
      setShowConfig(true)
      return
    }

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
        const data = await callOpenAI(apiMessages)
        const choice = data.choices?.[0]
        const msg = choice?.message

        if (!msg) throw new Error('Sem resposta da API.')

        if (choice.finish_reason === 'tool_calls' || msg.tool_calls?.length > 0) {
          apiMessages.push(msg)
          const toolResults = await executeToolCalls(msg.tool_calls)
          apiMessages.push(...toolResults)
          round++
          continue
        }

        setToolStatus('')
        const reply = msg.content || 'Sem resposta.'
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
        return
      }

      setToolStatus('')
      setMessages((prev) => [...prev, { role: 'error', content: 'Limite de buscas atingido. Tente reformular a pergunta.' }])
    } catch (e) {
      setToolStatus('')
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: e.message },
      ])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const clearChat = () => {
    setMessages([])
    inputRef.current?.focus()
  }

  return (
    <div className="playground">
      <div className="playground-header">
        <div className="playground-header-left">
          <h2 className="viewer-title">Teste IA</h2>
          <span className="playground-model-badge">{model}</span>
          <span className="playground-prompts-badge">{prompts.length} prompts ativos</span>
        </div>
        <div className="playground-actions">
          <button className="pg-action-btn" onClick={clearChat} title="Limpar chat">
            <Trash2 size={16} />
          </button>
          <button
            className={`pg-action-btn ${showConfig ? 'active' : ''}`}
            onClick={() => setShowConfig(!showConfig)}
            title="Configurações"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {showConfig && (
        <div className="pg-config">
          <div className="pg-config-field pg-config-field-wide">
            <label>
              <Key size={13} />
              API Key OpenAI
            </label>
            <input
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => saveKey(e.target.value)}
            />
          </div>
          <div className="pg-config-field">
            <label>
              <Bot size={13} />
              Modelo
            </label>
            <div className="pg-select-wrap">
              <select value={model} onChange={(e) => saveModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <ChevronDown size={14} className="pg-select-arrow" />
            </div>
          </div>
          <div className="pg-config-info">
            Todos os {prompts.length} prompts são enviados juntos como system message.
            {DEFAULT_API_KEY ? ' API Key configurada via .env.' : ' A API Key fica salva no seu navegador.'}
            {' '}Tools de busca no Supabase ativas.
          </div>
        </div>
      )}

      <div className="pg-chat" ref={chatRef}>
        {messages.length === 0 && (
          <div className="pg-empty">
            <Bot size={40} strokeWidth={1.2} />
            <p>Envie uma mensagem para testar a IA</p>
            <span className="pg-empty-prompt">
              Usando todos os <strong>{prompts.length} prompts</strong> como system message + <strong>4 tools</strong> de busca no Supabase
            </span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`pg-msg pg-msg-${m.role}`}>
            <div className="pg-msg-avatar">
              {m.role === 'user' ? <User size={16} /> : m.role === 'error' ? <AlertCircle size={16} /> : <Bot size={16} />}
            </div>
            <div className="pg-msg-content">
              <span className="pg-msg-role">
                {m.role === 'user' ? 'Você' : m.role === 'error' ? 'Erro' : 'Assistente'}
              </span>
              <div className="pg-msg-text">{m.content}</div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="pg-msg pg-msg-assistant">
            <div className="pg-msg-avatar"><Bot size={16} /></div>
            <div className="pg-msg-content">
              <span className="pg-msg-role">Assistente</span>
              {toolStatus ? (
                <div className="pg-tool-status">
                  <Database size={14} className="pg-tool-icon" />
                  <span>{toolStatus}...</span>
                </div>
              ) : (
                <div className="pg-typing">
                  <span /><span /><span />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="pg-input-area">
        <textarea
          ref={inputRef}
          rows={1}
          placeholder="Digite sua mensagem..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={(e) => {
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
          }}
        />
        <button
          className={`pg-send-btn ${input.trim() ? 'ready' : ''}`}
          onClick={handleSend}
          disabled={!input.trim() || loading}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  )
}
