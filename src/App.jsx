import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import PromptViewer from './components/PromptViewer'
import './App.css'

function extractPrompts(data) {
  const nodes = data.nodes || []
  const prompts = []

  function dig(params, out, depth = 0) {
    if (!params || typeof params !== 'object' || depth > 12) return
    if (Array.isArray(params)) {
      params.forEach((x) => dig(x, out, depth + 1))
      return
    }
    for (const [k, v] of Object.entries(params)) {
      if (k === 'systemMessage' && typeof v === 'string' && v.trim().length > 40) {
        let t = v.trim()
        if (t.startsWith('=') && !t.startsWith('={{')) t = t.slice(1).trim()
        out.push(t)
      } else if (v && typeof v === 'object') {
        dig(v, out, depth + 1)
      }
    }
  }

  for (const node of nodes) {
    const texts = []
    dig(node.parameters || {}, texts)
    const uniq = [...new Set(texts)]
    if (uniq.length === 0) continue

    const p = node.parameters || {}
    const toolDesc = typeof p.toolDescription === 'string' && p.toolDescription.trim()
      ? p.toolDescription.trim()
      : typeof p.description === 'string' && p.description.length < 500
        ? p.description
        : ''

    for (let i = 0; i < uniq.length; i++) {
      prompts.push({
        id: `${node.id || node.name || 'n'}-${i}`,
        name: node.name || 'Sem nome',
        type: (node.type || '').split('.').pop() || node.type || '',
        toolDesc: i === 0 ? toolDesc : '',
        body: uniq[i],
      })
    }
  }
  return prompts
}

export default function App() {
  const [prompts, setPrompts] = useState([])
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/APAGAR.txt')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((txt) => {
        const data = JSON.parse(txt)
        const items = extractPrompts(data)
        setPrompts(items)
        if (items.length > 0) setSelected(items[0].id)
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  const q = filter.toLowerCase()
  const filtered = q
    ? prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.type.toLowerCase().includes(q) ||
          p.body.toLowerCase().includes(q)
      )
    : prompts

  const active = prompts.find((p) => p.id === selected)

  return (
    <>
      <Sidebar
        prompts={filtered}
        selected={selected}
        onSelect={setSelected}
        filter={filter}
        onFilter={setFilter}
        loading={loading}
      />
      <main className="main-content">
        {loading && (
          <div className="state-msg">
            <div className="loader" />
            <p>Carregando prompts...</p>
          </div>
        )}
        {error && (
          <div className="state-msg">
            <p className="error-text">Erro ao carregar: {error}</p>
          </div>
        )}
        {!loading && !error && active && <PromptViewer prompt={active} />}
        {!loading && !error && !active && (
          <div className="state-msg">
            <p>Selecione um prompt na sidebar.</p>
          </div>
        )}
      </main>
    </>
  )
}
