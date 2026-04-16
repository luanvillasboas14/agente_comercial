import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import PromptViewer from './components/PromptViewer'
import Playground from './components/Playground'
import './App.css'

const STORAGE_KEY = 'prompt_edits'
const VERSIONS_KEY = 'prompt_versions'
const DAY_MS = 24 * 60 * 60 * 1000

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
    const toolDesc =
      typeof p.toolDescription === 'string' && p.toolDescription.trim()
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

function loadEdits() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}
  } catch { return {} }
}

function loadVersions() {
  try {
    const v = JSON.parse(localStorage.getItem(VERSIONS_KEY)) || {}
    const now = Date.now()
    for (const id in v) {
      v[id] = v[id].filter((entry) => now - entry.ts < DAY_MS)
      if (v[id].length === 0) delete v[id]
    }
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(v))
    return v
  } catch { return {} }
}

export default function App() {
  const [originalPrompts, setOriginalPrompts] = useState([])
  const [edits, setEdits] = useState(loadEdits)
  const [versions, setVersions] = useState(loadVersions)
  const [page, setPage] = useState('prompts')
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
        setOriginalPrompts(extractPrompts(data))
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  const prompts = originalPrompts.map((p) => ({
    ...p,
    body: edits[p.id] !== undefined ? edits[p.id] : p.body,
    originalBody: p.body,
  }))

  const handleSavePrompt = useCallback((id, newBody) => {
    setEdits((prev) => {
      const current = prev[id]
      const original = originalPrompts.find((p) => p.id === id)
      const previousBody = current !== undefined ? current : original?.body || ''

      if (previousBody !== newBody) {
        setVersions((vPrev) => {
          const list = vPrev[id] || []
          const entry = { body: previousBody, ts: Date.now() }
          const updated = { ...vPrev, [id]: [...list, entry].slice(-20) }
          localStorage.setItem(VERSIONS_KEY, JSON.stringify(updated))
          return updated
        })
      }

      const next = { ...prev, [id]: newBody }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [originalPrompts])

  const handleRestore = useCallback((id, body) => {
    setEdits((prev) => {
      const next = { ...prev, [id]: body }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const getVersions = useCallback((id) => {
    return (versions[id] || []).slice().reverse()
  }, [versions])

  return (
    <>
      <Sidebar page={page} onNavigate={setPage} />
      <main className="main-content">
        {loading && (
          <div className="state-msg">
            <div className="loader" />
            <p>Carregando...</p>
          </div>
        )}
        {error && (
          <div className="state-msg">
            <p className="error-text">Erro: {error}</p>
          </div>
        )}
        {!loading && !error && page === 'prompts' && (
          <PromptViewer
            prompts={prompts}
            onSave={handleSavePrompt}
            getVersions={getVersions}
            onRestore={handleRestore}
          />
        )}
        {!loading && !error && page === 'playground' && (
          <Playground prompts={prompts} />
        )}
      </main>
    </>
  )
}
