import { getFeedbackSupabase } from '../iaFeedback/supabaseClient.js'

function getDb(env) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[IaLearning/examplesStore] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  return sb
}

export async function createExample(env, payload) {
  const db = getDb(env)
  const rows = await db.insert('ia_exemplos_conversas', {
    batch_id: payload.batch_id ?? null,
    categoria: payload.categoria || 'outro',
    contexto_resumido: payload.contexto_resumido ?? null,
    dialogo: payload.dialogo ?? [],
    qualidade_score: payload.qualidade_score ?? 3,
    status: 'pendente',
    consultor_id: payload.consultor_id ?? null,
    consultor_nome: payload.consultor_nome ?? null,
    fonte_lead_id: payload.fonte_lead_id ?? null,
    metadata: payload.metadata ?? {},
  }, { Prefer: 'return=representation' })
  return Array.isArray(rows) ? rows[0] : rows
}

export async function listExamples(env, { status = 'ativo', limit = 50 } = {}) {
  const db = getDb(env)
  const lim = Math.max(1, Math.min(200, Number(limit) || 50))
  const rows = await db.select(
    'ia_exemplos_conversas',
    `select=*&status=eq.${encodeURIComponent(status)}&order=qualidade_score.desc,created_at.desc&limit=${lim}`,
  )
  return Array.isArray(rows) ? rows : []
}

export async function listActiveExamples(env) {
  const db = getDb(env)
  const rows = await db.select(
    'ia_exemplos_conversas',
    'select=*&status=eq.ativo&order=ativado_em.desc',
  )
  return Array.isArray(rows) ? rows : []
}

export async function activateExample(env, id) {
  const db = getDb(env)
  await db.update('ia_exemplos_conversas', `id=eq.${id}`, {
    status: 'ativo',
    ativado_em: new Date().toISOString(),
  })
}

export async function rejectExample(env, id) {
  const db = getDb(env)
  await db.update('ia_exemplos_conversas', `id=eq.${id}`, {
    status: 'rejeitado',
    rejeitado_em: new Date().toISOString(),
  })
}

export async function archiveExample(env, id) {
  const db = getDb(env)
  await db.update('ia_exemplos_conversas', `id=eq.${id}`, {
    status: 'arquivado',
  })
}

export async function getExample(env, id) {
  const db = getDb(env)
  const rows = await db.select('ia_exemplos_conversas', `select=*&id=eq.${id}&limit=1`)
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
}
