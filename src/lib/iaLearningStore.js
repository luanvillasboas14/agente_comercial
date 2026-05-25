/**
 * Wrapper de fetch+json que detecta resposta HTML (timeout de proxy,
 * fallback de SPA, página de erro) e dá mensagem clara em vez do
 * críptico "Unexpected token '<', \"<!DOCTYPE\"... is not valid JSON".
 */
async function fetchJson(url, opts) {
  const res = await fetch(url, opts)
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('application/json')) {
    const txt = await res.text().catch(() => '')
    const isHtml = txt.trim().toLowerCase().startsWith('<!doctype') || txt.trim().startsWith('<')
    if (isHtml) {
      throw new Error(`servidor não respondeu JSON (provável timeout/proxy) — endpoint: ${url} status=${res.status}`)
    }
    throw new Error(`resposta inesperada (status=${res.status}, ct=${ct})`)
  }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function loadStatus() {
  return fetchJson('/api/ia-learning/status')
}

export async function loadConvertidosRecentes(limit = 50) {
  const data = await fetchJson(`/api/ia-learning/convertidos?limit=${limit}`)
  return data.rows || []
}

export async function triggerBatchAnalysis() {
  return fetchJson('/api/ia-learning/analyze', { method: 'POST' })
}

export async function loadAnalyzerStatus() {
  return fetchJson('/api/ia-learning/analyze/status')
}

export async function loadBatches(limit = 20) {
  const data = await fetchJson(`/api/ia-learning/batches?limit=${limit}`)
  return data.rows || []
}

export async function getBatchDetail(id) {
  return fetchJson(`/api/ia-learning/batches/${id}`)
}

export async function loadExamples(status = 'ativo') {
  const data = await fetchJson(`/api/ia-learning/examples?status=${encodeURIComponent(status)}`)
  return data.rows || []
}

export async function activateExample(id) {
  return fetchJson(`/api/ia-learning/examples/${id}/activate`, { method: 'POST' })
}

export async function rejectExample(id) {
  return fetchJson(`/api/ia-learning/examples/${id}/reject`, { method: 'POST' })
}

export async function archiveExample(id) {
  return fetchJson(`/api/ia-learning/examples/${id}/archive`, { method: 'POST' })
}

export async function triggerDetectorNow() {
  return fetchJson('/api/ia-learning/detector/run-now', { method: 'POST' })
}

export async function loadDetectorStatus() {
  return fetchJson('/api/ia-learning/detector/status')
}

/** Lista propostas pendentes do aprendizado positivo (filtrado client-side). */
export async function loadAprendizadoProposals() {
  const data = await fetchJson('/api/ia-feedback/proposals?status=pendente&limit=100')
  const rows = Array.isArray(data) ? data : (data.rows || data)
  return (Array.isArray(rows) ? rows : []).filter((p) => p.origem === 'aprendizado_positivo')
}

export async function applyProposal(id) {
  return fetchJson(`/api/ia-feedback/proposals/${id}/accept`, { method: 'POST' })
}

export async function rejectProposal(id) {
  return fetchJson(`/api/ia-feedback/proposals/${id}/reject`, { method: 'POST' })
}
