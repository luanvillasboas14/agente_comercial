const BASE = '/api/ia-feedback'

export async function loadAvaliacoes({ page = 1, limit = 20, veredito, leadId } = {}) {
  try {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('limit', String(limit))
    if (veredito) params.set('veredito', veredito)
    if (leadId) params.set('lead_id', String(leadId))
    const res = await fetch(`${BASE}/avaliacoes?${params}`)
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error('[iaFeedbackStore] loadAvaliacoes failed:', res.status, err)
      return { rows: [], total: 0 }
    }
    return await res.json()
  } catch (e) {
    console.error('[iaFeedbackStore] loadAvaliacoes error:', e.message)
    return { rows: [], total: 0 }
  }
}

export async function loadAvaliacao(id) {
  try {
    const res = await fetch(`${BASE}/avaliacoes/${id}`)
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    console.error('[iaFeedbackStore] loadAvaliacao error:', e.message)
    return null
  }
}

export async function loadRuns(limit = 20) {
  try {
    const res = await fetch(`${BASE}/runs?limit=${limit}`)
    if (!res.ok) return []
    return await res.json()
  } catch (e) {
    console.error('[iaFeedbackStore] loadRuns error:', e.message)
    return []
  }
}

export async function loadStatus() {
  try {
    const res = await fetch(`${BASE}/status`)
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      return { _error: err || `HTTP ${res.status}` }
    }
    return await res.json()
  } catch (e) {
    return { _error: e.message }
  }
}

export async function avaliarManual({ lead_id, telefone } = {}) {
  try {
    const res = await fetch(`${BASE}/avaliar-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id, telefone }),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      return { ok: false, error: err || `HTTP ${res.status}` }
    }
    return await res.json()
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ─── Otimizador de Prompt ─────────────────────────────────────────────────────

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = null }
    const msg = parsed?.error || body || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json()
}

export async function loadViolationsRanking() {
  return apiFetch(`${BASE}/violations-ranking`)
}

export async function requestRuleAnalysis(regraAlvo) {
  return apiFetch(`${BASE}/analyze-rule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regra_alvo: regraAlvo }),
  })
}

export async function loadProposals(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return apiFetch(`${BASE}/proposals${qs}`)
}

export async function loadProposalById(id) {
  return apiFetch(`${BASE}/proposals/${id}`)
}

export async function acceptProposal(id) {
  return apiFetch(`${BASE}/proposals/${id}/accept`, { method: 'POST' })
}

export async function rejectProposal(id) {
  return apiFetch(`${BASE}/proposals/${id}/reject`, { method: 'POST' })
}

export async function reanalyzeProposal(id, instrucaoExtra) {
  const res = await fetch(`${BASE}/proposals/${id}/reanalyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instrucao_extra: instrucaoExtra }),
  })
  const text = await res.text()
  if (!res.ok) {
    const detail = text ? (JSON.parse(text).error || text) : `HTTP ${res.status}`
    throw new Error(detail)
  }
  return text ? JSON.parse(text) : {}
}

export async function loadPromptVersions() {
  return apiFetch(`${BASE}/prompt-versions`)
}

export async function loadPromptVersionById(id) {
  return apiFetch(`${BASE}/prompt-versions/${id}`)
}

export async function rollbackPromptVersion(id) {
  return apiFetch(`${BASE}/prompt-versions/${id}/rollback`, { method: 'POST' })
}

export async function syncPromptFromFallback() {
  const res = await fetch('/api/ia-feedback/prompt-versions/sync-from-fallback', { method: 'POST' })
  const text = await res.text()
  if (!res.ok) {
    const detail = text ? JSON.parse(text).error || text : `HTTP ${res.status}`
    throw new Error(detail)
  }
  return text ? JSON.parse(text) : {}
}

// ─── Multi-violação ───────────────────────────────────────────────────────────

export async function analyzeMultiViolations(violationIds, hint) {
  return apiFetch(`${BASE}/analyze-multi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ violationIds, hint: hint || undefined }),
  })
}

// ─── Acertos (falsos positivos) ───────────────────────────────────────────────

export async function createAcerto({ feedback_id, regra, citacao, descricao_violacao, motivo }) {
  return apiFetch(`${BASE}/acertos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback_id, regra, citacao, descricao_violacao, motivo }),
  })
}

export async function loadAcertos(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return apiFetch(`${BASE}/acertos${qs}`)
}

export async function analyzeAcertos(acertoIds, hint) {
  return apiFetch(`${BASE}/acertos/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acertoIds, hint: hint || undefined }),
  })
}

// ─── Negativos (erros graves confirmados) ─────────────────────────────────────

export async function createNegativo({ feedback_id, regra, citacao, descricao_violacao, motivo }) {
  return apiFetch(`${BASE}/negativos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback_id, regra, citacao, descricao_violacao, motivo }),
  })
}

export async function listNegativos({ status = 'pendente', limit = 100 } = {}) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return apiFetch(`${BASE}/negativos${qs}`)
}

export async function analyzeNegativos(negativoIds, hint) {
  return apiFetch(`${BASE}/negativos/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ negativoIds, hint: hint || undefined }),
  })
}
