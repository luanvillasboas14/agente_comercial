export async function loadStatus() {
  const res = await fetch('/api/ia-learning/status')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function loadConvertidosRecentes(limit = 50) {
  const res = await fetch(`/api/ia-learning/convertidos?limit=${limit}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.rows || []
}

export async function triggerBatchAnalysis() {
  const res = await fetch('/api/ia-learning/analyze', { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function loadBatches(limit = 20) {
  const res = await fetch(`/api/ia-learning/batches?limit=${limit}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.rows || []
}

export async function getBatchDetail(id) {
  const res = await fetch(`/api/ia-learning/batches/${id}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function loadExamples(status = 'ativo') {
  const res = await fetch(`/api/ia-learning/examples?status=${encodeURIComponent(status)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.rows || []
}

export async function activateExample(id) {
  const res = await fetch(`/api/ia-learning/examples/${id}/activate`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function rejectExample(id) {
  const res = await fetch(`/api/ia-learning/examples/${id}/reject`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function archiveExample(id) {
  const res = await fetch(`/api/ia-learning/examples/${id}/archive`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function triggerDetectorNow() {
  const res = await fetch('/api/ia-learning/detector/run-now', { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
