/**
 * proposalsStore — CRUD para ia_prompt_proposals no Supabase de Feedback.
 */

import { getFeedbackSupabase } from './supabaseClient.js'

/**
 * Verifica se o trecho_antes da proposta ainda existe no texto ativo do prompt.
 * Usa string.includes (literal) — match flexível só vale no momento de criar a proposta.
 */
export function isProposalObsolete(proposal, activeAgentRulesText) {
  if (!proposal || !activeAgentRulesText) return false
  if (proposal.tipo_mudanca === 'nenhuma') return false
  if (proposal.status !== 'pendente') return false
  if (!proposal.trecho_antes) return true
  return !activeAgentRulesText.includes(proposal.trecho_antes)
}

function getClient(env) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[proposalsStore/config] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  return sb
}

/**
 * Insere uma nova proposta com status 'pendente'.
 */
export async function createProposal(env, payload) {
  const sb = getClient(env)
  try {
    const row = {
      baseada_em_versao_id: payload.baseada_em_versao_id,
      modelo_analisador: payload.modelo_analisador,
      status: 'pendente',
      regra_alvo: payload.regra_alvo,
      tipo_mudanca: payload.tipo_mudanca,
      trecho_antes: payload.trecho_antes || '',
      trecho_depois: payload.trecho_depois || '',
      justificativa: payload.justificativa,
      conflitos_potenciais: payload.conflitos_potenciais || null,
      exemplos_violacoes: payload.exemplos_violacoes || null,
      total_violacoes: payload.total_violacoes,
      janela_de: payload.janela_de,
      janela_ate: payload.janela_ate,
      created_at: new Date().toISOString(),
    }
    if (payload.origem != null) row.origem = payload.origem
    if (payload.violacoes_origem_ids != null) row.violacoes_origem_ids = payload.violacoes_origem_ids
    const inserted = await sb.insert('ia_prompt_proposals', row, true)
    return Array.isArray(inserted) ? inserted[0] : inserted
  } catch (err) {
    throw new Error(`[proposalsStore/supabase] createProposal: ${err.message}`)
  }
}

/**
 * Lista propostas em ordem decrescente de criação.
 * @param {{ status?: string, limit?: number }} opts
 */
export async function listProposals(env, { status, limit = 50 } = {}) {
  const sb = getClient(env)
  try {
    let query = `order=created_at.desc&limit=${Math.min(100, limit)}`
    if (status) query += `&status=eq.${encodeURIComponent(status)}`
    const rows = await sb.select('ia_prompt_proposals', query)
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    throw new Error(`[proposalsStore/supabase] listProposals: ${err.message}`)
  }
}

/**
 * Retorna uma proposta completa pelo id.
 */
export async function getProposalById(env, id) {
  const sb = getClient(env)
  try {
    const rows = await sb.select(
      'ia_prompt_proposals',
      `id=eq.${encodeURIComponent(id)}&limit=1`,
    )
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  } catch (err) {
    throw new Error(`[proposalsStore/supabase] getProposalById id=${id}: ${err.message}`)
  }
}

/**
 * Marca uma proposta como 'aplicada' e registra a versão resultante.
 */
export async function markProposalApplied(env, id, resultadoVersaoId) {
  const sb = getClient(env)
  try {
    await sb.update(
      'ia_prompt_proposals',
      `id=eq.${encodeURIComponent(id)}`,
      {
        status: 'aplicada',
        applied_at: new Date().toISOString(),
        resultado_versao_id: resultadoVersaoId,
      },
    )
  } catch (err) {
    throw new Error(`[proposalsStore/supabase] markProposalApplied id=${id}: ${err.message}`)
  }
}

/**
 * Marca uma proposta como 'rejeitada'.
 */
export async function markProposalRejected(env, id) {
  const sb = getClient(env)
  try {
    await sb.update(
      'ia_prompt_proposals',
      `id=eq.${encodeURIComponent(id)}`,
      {
        status: 'rejeitada',
        rejected_at: new Date().toISOString(),
      },
    )
  } catch (err) {
    throw new Error(`[proposalsStore/supabase] markProposalRejected id=${id}: ${err.message}`)
  }
}
