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
