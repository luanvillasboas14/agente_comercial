/**
 * negativosStore — CRUD para ia_feedback_negativos no Supabase de Feedback.
 *
 * Negativos são violações que o administrador confirmou como erros graves e prioritários.
 */

import { getFeedbackSupabase } from './supabaseClient.js'

function getClient(env) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[negativosStore/config] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  return sb
}

/**
 * Cria um novo registro de negativo (erro grave confirmado pelo admin).
 */
export async function createNegativo(env, { feedback_id, regra, citacao, descricao_violacao, motivo }) {
  const sb = getClient(env)
  if (!regra) throw new Error('[negativosStore/input] regra é obrigatório')
  if (!feedback_id) throw new Error('[negativosStore/input] feedback_id é obrigatório')
  try {
    const inserted = await sb.insert(
      'ia_feedback_negativos',
      {
        feedback_id: Number(feedback_id),
        regra: String(regra).slice(0, 200),
        citacao: citacao ? String(citacao).slice(0, 1000) : null,
        descricao_violacao: descricao_violacao ? String(descricao_violacao).slice(0, 2000) : null,
        motivo: motivo ? String(motivo).slice(0, 2000) : null,
        created_at: new Date().toISOString(),
        created_by: 'user',
      },
      true,
    )
    return Array.isArray(inserted) ? inserted[0] : inserted
  } catch (err) {
    throw new Error(`[negativosStore/supabase] createNegativo: ${err.message}`)
  }
}

/**
 * Lista negativos.
 * @param {{ status?: 'pendente'|'processado', limit?: number }} opts
 *   status 'pendente'   = processed_at IS NULL
 *   status 'processado' = processed_at IS NOT NULL
 */
export async function listNegativos(env, { status, limit = 50 } = {}) {
  const sb = getClient(env)
  try {
    let query = `order=created_at.desc&limit=${Math.min(200, Math.max(1, limit))}`
    if (status === 'pendente') {
      query += '&processed_at=is.null'
    } else if (status === 'processado') {
      query += '&processed_at=not.is.null'
    }
    const rows = await sb.select('ia_feedback_negativos', query)
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    throw new Error(`[negativosStore/supabase] listNegativos: ${err.message}`)
  }
}

/**
 * Retorna um negativo por ID.
 */
export async function getNegativoById(env, id) {
  const sb = getClient(env)
  try {
    const rows = await sb.select(
      'ia_feedback_negativos',
      `id=eq.${encodeURIComponent(id)}&limit=1`,
    )
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  } catch (err) {
    throw new Error(`[negativosStore/supabase] getNegativoById id=${id}: ${err.message}`)
  }
}

/**
 * Marca negativos como processados, associando a proposta gerada.
 * @param {string[]} ids - UUIDs dos negativos
 * @param {string} propostaId - UUID da proposta gerada (ou null)
 */
export async function markNegativosProcessados(env, ids, propostaId = null) {
  if (!Array.isArray(ids) || ids.length === 0) return
  const sb = getClient(env)
  const now = new Date().toISOString()
  const patch = {
    processed_at: now,
    ...(propostaId ? { proposta_id: propostaId } : {}),
  }
  try {
    const idsCsv = ids.map((id) => encodeURIComponent(id)).join(',')
    await sb.update('ia_feedback_negativos', `id=in.(${idsCsv})`, patch)
  } catch (err) {
    throw new Error(`[negativosStore/supabase] markNegativosProcessados: ${err.message}`)
  }
}
