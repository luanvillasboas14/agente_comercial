const isDev = import.meta.env.DEV
const BASE = isDev ? '/api/supabase' : '/api/supabase'

let counter = 0

export function generateExecutionId() {
  const now = new Date()
  const date = now.toISOString().slice(2, 10).replace(/-/g, '')
  const time = now.toISOString().slice(11, 16).replace(':', '')
  counter++
  const seq = String(counter).padStart(3, '0')
  return `EX-${date}-${time}-${seq}`
}

export async function saveExecution(execution) {
  try {
    const row = {
      id: execution.id,
      created_at: execution.timestamp,
      user_message: execution.userMessage,
      model: execution.model,
      steps: execution.steps || [],
      tool_calls: execution.toolCalls || [],
      response: execution.response || null,
      error: execution.error || null,
      total_duration_ms: execution.totalDurationMs || 0,
      usage: execution.usage || {},
    }

    const res = await fetch(`${BASE}/rest/v1/mensagens_ia`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    })

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error('[ExecutionStore] Save failed:', res.status, err)
    }
  } catch (e) {
    console.error('[ExecutionStore] Save error:', e.message)
  }
}

export async function getAllExecutions() {
  try {
    const res = await fetch(
      `${BASE}/rest/v1/mensagens_ia?select=*&order=created_at.desc&limit=500`
    )
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      console.error('[ExecutionStore] Fetch failed:', res.status, err)
      return []
    }
    const rows = await res.json()
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.created_at,
      userMessage: r.user_message,
      model: r.model,
      steps: r.steps,
      toolCalls: r.tool_calls,
      response: r.response,
      error: r.error,
      totalDurationMs: r.total_duration_ms,
      usage: r.usage || {},
    }))
  } catch (e) {
    console.error('[ExecutionStore] Fetch error:', e.message)
    return []
  }
}

export async function getExecutionsByRange(startDate, endDate) {
  try {
    const startISO = `${startDate}T00:00:00.000Z`
    const endISO = `${endDate}T23:59:59.999Z`
    const res = await fetch(
      `${BASE}/rest/v1/mensagens_ia?select=*&created_at=gte.${startISO}&created_at=lte.${endISO}&order=created_at.desc`
    )
    if (!res.ok) return []
    const rows = await res.json()
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.created_at,
      userMessage: r.user_message,
      model: r.model,
      steps: r.steps,
      toolCalls: r.tool_calls,
      response: r.response,
      error: r.error,
      totalDurationMs: r.total_duration_ms,
      usage: r.usage || {},
    }))
  } catch (e) {
    console.error('[ExecutionStore] Fetch range error:', e.message)
    return []
  }
}

export async function clearExecutions() {
  try {
    await fetch(`${BASE}/rest/v1/mensagens_ia?id=neq.impossible`, {
      method: 'DELETE',
    })
  } catch (e) {
    console.error('[ExecutionStore] Clear error:', e.message)
  }
}
