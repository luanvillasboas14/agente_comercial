import { getFeedbackSupabase } from '../iaFeedback/supabaseClient.js'

/** Retorna lista [{ nome, kommoUserId }]. */
export async function getConsultoresAtivos(env) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[kommoEvents/consultores] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  const rows = await sb.select('consultores', 'select=nome,id_lead')
  const list = Array.isArray(rows) ? rows : []
  return list
    .map((r) => ({
      nome: String(r?.nome || '').trim(),
      kommoUserId: Number(r?.id_lead),
    }))
    .filter((c) => c.nome && Number.isFinite(c.kommoUserId) && c.kommoUserId > 0)
}
