import { getFeedbackSupabase } from '../iaFeedback/supabaseClient.js'

function getDb(env) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[IaLearning/leadsConvertidosStore] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  return sb
}

export async function leadJaDetectado(env, leadId) {
  const db = getDb(env)
  const rows = await db.select('ia_leads_convertidos', `select=id&lead_id=eq.${Number(leadId)}&limit=1`)
  return Array.isArray(rows) && rows.length > 0
}

export async function insertLeadConvertido(env, payload) {
  const db = getDb(env)
  const rows = await db.insert('ia_leads_convertidos', {
    lead_id: payload.lead_id,
    status_novo: payload.status_novo,
    pipeline_id: payload.pipeline_id ?? null,
    consultor_id: payload.consultor_id ?? null,
    consultor_nome: payload.consultor_nome ?? null,
    fonte_conversa: payload.fonte_conversa ?? null,
    conversa_snapshot: payload.conversa_snapshot ?? {},
    total_mensagens: payload.total_mensagens ?? 0,
    capture_error: payload.capture_error ?? null,
    metadata: payload.metadata ?? {},
  }, { Prefer: 'return=representation' })
  return Array.isArray(rows) ? rows[0] : rows
}

export async function listPendentes(env, limit = 200) {
  const db = getDb(env)
  const lim = Math.max(1, Math.min(500, Number(limit) || 200))
  const rows = await db.select(
    'ia_leads_convertidos',
    `select=*&processed_at=is.null&capture_error=is.null&order=detected_at.asc&limit=${lim}`,
  )
  return Array.isArray(rows) ? rows : []
}

export async function countPendentes(env) {
  const db = getDb(env)
  const rows = await db.select(
    'ia_leads_convertidos',
    'select=id&processed_at=is.null&capture_error=is.null',
  )
  return Array.isArray(rows) ? rows.length : 0
}

export async function listRecentes(env, limit = 50) {
  const db = getDb(env)
  const lim = Math.max(1, Math.min(200, Number(limit) || 50))
  const rows = await db.select(
    'ia_leads_convertidos',
    `select=*&order=detected_at.desc&limit=${lim}`,
  )
  return Array.isArray(rows) ? rows : []
}

export async function marcarProcessados(env, leadConvertidoIds, batchId) {
  if (!leadConvertidoIds || leadConvertidoIds.length === 0) return
  const db = getDb(env)
  const ids = leadConvertidoIds.map((id) => `"${id}"`).join(',')
  await db.update(
    'ia_leads_convertidos',
    `id=in.(${ids})`,
    {
      processed_at: new Date().toISOString(),
      batch_id: batchId,
    },
  )
}

export async function marcarErroCaptura(env, leadId, error) {
  const db = getDb(env)
  await db.update(
    'ia_leads_convertidos',
    `lead_id=eq.${Number(leadId)}`,
    { capture_error: String(error).slice(0, 500) },
  )
}

/**
 * Deleta leads que falharam na captura e ainda não foram processados em batch.
 * Permite que o detector os re-detecte numa próxima rodada (útil quando a
 * estratégia de captura mudou).
 */
export async function deleteLeadsComErroNaoProcessados(env) {
  const db = getDb(env)
  // PostgREST: DELETE com filtros
  const rows = await db.select(
    'ia_leads_convertidos',
    `select=id&capture_error=not.is.null&processed_at=is.null&limit=10000`,
  )
  const ids = Array.isArray(rows) ? rows.map((r) => `"${r.id}"`) : []
  if (ids.length === 0) return 0
  // PostgREST DELETE
  const sb = getDb(env)
  // makeMainSupabase-like helper precisa de DELETE. Implemento via filtro
  // genérico no helper. Como o helper só tem select/insert/update,
  // vou fazer fetch direto.
  const url = (env.SUPABASE_URL_FEEDBACK || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY_FEEDBACK || ''
  if (!url || !key) return 0
  const res = await fetch(`${url}/rest/v1/ia_leads_convertidos?id=in.(${ids.join(',')})`, {
    method: 'DELETE',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[IaLearning/store] delete falhou: ${res.status} ${text.slice(0, 200)}`)
  }
  // sb apenas pra evitar warn de variável não utilizada
  void sb
  return ids.length
}
