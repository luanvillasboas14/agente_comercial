import { useState, useRef, useEffect } from 'react'
import { Send, Settings, Trash2, Bot, User, AlertCircle, Key, ChevronDown } from 'lucide-react'

const MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1']

export default function Playground({ prompts }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [showConfig, setShowConfig] = useState(false)

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('oai_key') || '')
  const [model, setModel] = useState(() => localStorage.getItem('oai_model') || 'gpt-4o-mini')
  const [selectedPrompt, setSelectedPrompt] = useState('')

  const chatRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (prompts.length > 0 && !selectedPrompt) {
      setSelectedPrompt(prompts[0].id)
    }
  }, [prompts, selectedPrompt])

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [messages])

  const saveKey = (k) => {
    setApiKey(k)
    localStorage.setItem('oai_key', k)
  }

  const saveModel = (m) => {
    setModel(m)
    localStorage.setItem('oai_model', m)
  }

  const activePrompt = prompts.find((p) => p.id === selectedPrompt)

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

    const systemContent = activePrompt ? activePrompt.body : 'Você é um assistente comercial.'
    const apiMessages = [
      { role: 'system', content: systemContent },
      ...updated,
    ]

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: apiMessages,
          temperature: 0.7,
          max_tokens: 2048,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error?.message || `HTTP ${res.status}`)
      }

      const data = await res.json()
      const reply = data.choices?.[0]?.message?.content || 'Sem resposta.'
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (e) {
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
          <h2 className="viewer-title">Playground</h2>
          <span className="playground-model-badge">{model}</span>
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
          <div className="pg-config-field">
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
          <div className="pg-config-field">
            <label>
              <Settings size={13} />
              Prompt (system)
            </label>
            <div className="pg-select-wrap">
              <select
                value={selectedPrompt}
                onChange={(e) => setSelectedPrompt(e.target.value)}
              >
                {prompts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <ChevronDown size={14} className="pg-select-arrow" />
            </div>
          </div>
          {!apiKey && (
            <div className="pg-config-warning">
              <AlertCircle size={14} />
              Insira sua API Key para usar o Playground.
            </div>
          )}
        </div>
      )}

      <div className="pg-chat" ref={chatRef}>
        {messages.length === 0 && (
          <div className="pg-empty">
            <Bot size={40} strokeWidth={1.2} />
            <p>Envie uma mensagem para testar a IA</p>
            {activePrompt && (
              <span className="pg-empty-prompt">
                Usando: <strong>{activePrompt.name}</strong>
              </span>
            )}
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
              <div className="pg-typing">
                <span /><span /><span />
              </div>
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
          className={`pg-send-btn ${input.trim() && apiKey ? 'ready' : ''}`}
          onClick={handleSend}
          disabled={!input.trim() || loading}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  )
}
