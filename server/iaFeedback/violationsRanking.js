/**
 * violationsRanking — agrega violações do ia_feedback por regra,
 * janelada pela data de ativação da versão ativa do prompt.
 */

import { getFeedbackSupabase } from './supabaseClient.js'

/**
 * Retorna o ranking de violações desde a ativação da versão atual do prompt.
 *
 * @param {Record<string,string>} env
 * @param {{ activeVersion: object, limit?: number }} opts
 *   activeVersion: objeto com { id, versao, activated_at, created_at }
 *   limit: máximo de avaliações a carregar (default 100)
 */
export async function getViolationsRanking(env, { activeVersion, limit = 100 }) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[violationsRanking/config] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')

  const cutoff = activeVersion.activated_at || activeVersion.created_at
  const now = new Date().toISOString()

  let rows
  try {
    rows = await sb.select(
      'ia_feedback',
      `select=id,veredito,violacoes,created_at&created_at=gte.${encodeURIComponent(cutoff)}&order=created_at.desc&limit=${Math.max(1, Math.min(500, limit))}`,
    )
  } catch (err) {
    throw new Error(`[violationsRanking/supabase] Falha ao buscar ia_feedback: ${err.message}`)
  }

  const avaliacoes = Array.isArray(rows) ? rows : []

  // Agrega violações por `regra`
  const byRegra = {}
  for (const av of avaliacoes) {
    const violacoes = Array.isArray(av.violacoes) ? av.violacoes : []
    for (const v of violacoes) {
      const regra = String(v.regra || '').trim()
      if (!regra) continue

      if (!byRegra[regra]) {
        byRegra[regra] = {
          regra,
          count: 0,
          severidades: { alta: 0, media: 0, baixa: 0 },
          exemplos: [],
        }
      }

      byRegra[regra].count++
      const sev = String(v.severidade || 'baixa').toLowerCase()
      if (Object.prototype.hasOwnProperty.call(byRegra[regra].severidades, sev)) {
        byRegra[regra].severidades[sev]++
      }

      if (byRegra[regra].exemplos.length < 5) {
        byRegra[regra].exemplos.push({
          execution_id: v.execution_id || null,
          citacao: String(v.citacao || ''),
          descricao: String(v.descricao || ''),
          severidade: sev,
          feedback_id: av.id,
          created_at: av.created_at,
        })
      }
    }
  }

  const ranking = Object.values(byRegra).sort((a, b) => b.count - a.count)

  return {
    janela_de: cutoff,
    janela_ate: now,
    versao_ativa: {
      versao: activeVersion.versao,
      id: activeVersion.id,
      activated_at: activeVersion.activated_at,
    },
    total_avaliacoes: avaliacoes.length,
    ranking,
  }
}

/**
 * Busca a conversa_completa de uma lista de ia_feedback IDs.
 * Retorna um Map<feedback_id, conversa_completa>.
 *
 * Pra economizar tokens, NÃO usar isso no ranking geral. Usar APENAS no analyzeRule.
 */
export async function fetchConversationsByFeedbackIds(env, feedbackIds) {
  if (!Array.isArray(feedbackIds) || feedbackIds.length === 0) return new Map()
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[violationsRanking/config] SUPABASE_URL_FEEDBACK não configurado')
  const idsCsv = feedbackIds.map((id) => encodeURIComponent(String(id))).join(',')
  try {
    const rows = await sb.select(
      'ia_feedback',
      `select=id,conversa_completa&id=in.(${idsCsv})`,
    )
    const map = new Map()
    for (const r of (Array.isArray(rows) ? rows : [])) {
      map.set(r.id, r.conversa_completa)
    }
    return map
  } catch (err) {
    console.warn(`[violationsRanking/conversation] Falha ao buscar conversas: ${err.message}`)
    return new Map()
  }
}
