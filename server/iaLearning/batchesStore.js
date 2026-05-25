import { getFeedbackSupabase } from '../iaFeedback/supabaseClient.js'

function getDb(env) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[IaLearning/batchesStore] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  return sb
}

export async function createBatch(env, { trigger, modelo, leadsIds, totalLeads, totalMensagens }) {
  const db = getDb(env)
  const rows = await db.insert('ia_aprendizado_batches', {
    trigger: trigger || 'manual',
    modelo_analisador: modelo || 'o3-mini',
    leads_ids: leadsIds ?? [],
    total_leads: totalLeads ?? 0,
    total_mensagens: totalMensagens ?? 0,
    status: 'running',
  }, { Prefer: 'return=representation' })
  const row = Array.isArray(rows) ? rows[0] : rows
  if (!row?.id) throw new Error('[IaLearning/batchesStore] createBatch: falha ao obter id')
  console.log(`[IaLearning] batch criado id=${row.id} trigger=${trigger} leads=${totalLeads}`)
  return row.id
}

export async function finishBatch(env, batchId, patch) {
  const db = getDb(env)
  await db.update('ia_aprendizado_batches', `id=eq.${batchId}`, {
    finished_at: new Date().toISOString(),
    status: patch.status ?? 'success',
    total_propostas_geradas: patch.total_propostas_geradas ?? 0,
    total_propostas_descartadas: patch.total_propostas_descartadas ?? 0,
    total_exemplos_gerados: patch.total_exemplos_gerados ?? 0,
    total_exemplos_descartados: patch.total_exemplos_descartados ?? 0,
    ...(patch.raw_analyzer_response != null ? { raw_analyzer_response: patch.raw_analyzer_response } : {}),
    ...(patch.error_message != null ? { error_message: patch.error_message } : {}),
  })
}

export async function listBatches(env, limit = 20) {
  const db = getDb(env)
  const lim = Math.max(1, Math.min(50, Number(limit) || 20))
  const rows = await db.select(
    'ia_aprendizado_batches',
    `select=*&order=created_at.desc&limit=${lim}`,
  )
  return Array.isArray(rows) ? rows : []
}

export async function getBatch(env, batchId) {
  const db = getDb(env)
  const rows = await db.select('ia_aprendizado_batches', `select=*&id=eq.${batchId}&limit=1`)
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
}
