const BASE = '/api/feedback-supabase'

export async function getAllJobRuns() {
  try {
    const res = await fetch(
      `${BASE}/rest/v1/feedback_job_runs?select=*&order=started_at.desc&limit=500`,
    )
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error('[FeedbackJobStore] Fetch failed:', res.status, err)
      return []
    }
    return await res.json()
  } catch (e) {
    console.error('[FeedbackJobStore] Fetch error:', e.message)
    return []
  }
}

// Busca o status do cron/job. Funciona tanto em dev (vite) quanto em prod (server.js).
export async function getJobStatus() {
  try {
    const res = await fetch('/api/feedback-job/status')
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      return { _error: err || `HTTP ${res.status}`, cronEnabled: false }
    }
    return await res.json()
  } catch (e) {
    return { _error: e.message, cronEnabled: false }
  }
}

// Busca feedbacks gerados por uma execução específica
export async function getFeedbacksByExecutionId(executionId) {
  try {
    const [fbRes, pendRes] = await Promise.all([
      fetch(`${BASE}/rest/v1/comercial_feedback?select=id,contact_id,lead_id,consultor,nota_avaliacao,ponto_positivo,ponto_negativo,updated_at&job_execution_id=eq.${encodeURIComponent(executionId)}&order=updated_at.desc`),
      fetch(`${BASE}/rest/v1/comercial_feedback_pendente?select=id,contact_id,lead_id,consultor,motivo_pendencia,updated_at&job_execution_id=eq.${encodeURIComponent(executionId)}&order=updated_at.desc`),
    ])
    const feedbacks = fbRes.ok ? await fbRes.json() : []
    const pendentes = pendRes.ok ? await pendRes.json() : []
    return { feedbacks, pendentes }
  } catch (e) {
    console.error('[FeedbackJobStore] getFeedbacksByExecutionId error:', e.message)
    return { feedbacks: [], pendentes: [] }
  }
}
