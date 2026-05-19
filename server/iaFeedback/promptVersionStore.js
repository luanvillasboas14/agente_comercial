/**
 * promptVersionStore — CRUD para ia_prompt_versions no Supabase de Feedback.
 */

import { getFeedbackSupabase } from './supabaseClient.js'
import { getFallbackAgentRulesText } from '../ai/promptsLoader.js'

function getClient(env) {
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[promptVersionStore/config] SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  return sb
}

/**
 * Retorna a versão atualmente ativa, ou null se não houver.
 */
export async function getActiveVersion(env) {
  const sb = getClient(env)
  try {
    const rows = await sb.select('ia_prompt_versions', 'ativa=eq.true&limit=1')
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    return row
      ? {
          id: row.id,
          versao: row.versao,
          agent_rules_text: row.agent_rules_text,
          activated_at: row.activated_at,
          created_at: row.created_at,
          diff_resumo: row.diff_resumo,
          created_by: row.created_by,
        }
      : null
  } catch (err) {
    throw new Error(`[promptVersionStore/supabase] getActiveVersion: ${err.message}`)
  }
}

/**
 * Lista versões em ordem decrescente de versao (sem agent_rules_text para economizar tráfego).
 */
export async function listVersions(env, { limit = 50 } = {}) {
  const sb = getClient(env)
  try {
    const rows = await sb.select(
      'ia_prompt_versions',
      `select=id,versao,ativa,activated_at,deactivated_at,created_at,created_by,origem_proposta_id,diff_resumo,metadata&order=versao.desc&limit=${Math.min(100, limit)}`,
    )
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    throw new Error(`[promptVersionStore/supabase] listVersions: ${err.message}`)
  }
}

/**
 * Retorna a versão completa (incluindo agent_rules_text) pelo id.
 */
export async function getVersionById(env, id) {
  const sb = getClient(env)
  try {
    const rows = await sb.select(
      'ia_prompt_versions',
      `id=eq.${encodeURIComponent(id)}&limit=1`,
    )
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  } catch (err) {
    throw new Error(`[promptVersionStore/supabase] getVersionById id=${id}: ${err.message}`)
  }
}

/**
 * Se a tabela estiver vazia, insere o FALLBACK_AGENT_RULES_TEXT como v1 ativa.
 * Retorna a versão criada, ou null se já havia pelo menos uma versão.
 */
export async function seedInitialVersionIfEmpty(env) {
  const sb = getClient(env)
  try {
    const existing = await sb.select('ia_prompt_versions', 'select=id&limit=1')
    if (Array.isArray(existing) && existing.length > 0) return null

    const fallbackText = getFallbackAgentRulesText()
    const now = new Date().toISOString()
    const inserted = await sb.insert(
      'ia_prompt_versions',
      {
        versao: 1,
        agent_rules_text: fallbackText,
        ativa: true,
        activated_at: now,
        created_at: now,
        created_by: 'seed',
      },
      true,
    )
    const row = Array.isArray(inserted) ? inserted[0] : inserted
    console.log(`[promptVersionStore/seed] Versão inicial criada: v1 id=${row?.id}`)
    return row
  } catch (err) {
    throw new Error(`[promptVersionStore/supabase] seedInitialVersionIfEmpty: ${err.message}`)
  }
}

/**
 * Cria uma nova versão, desativa a atual e ativa a nova.
 * Retorna a versão recém-criada.
 */
export async function createVersionAndActivate(env, { agent_rules_text, created_by, origem_proposta_id, diff_resumo }) {
  const sb = getClient(env)
  try {
    // 1. Pega o maior numero de versão atual
    const rows = await sb.select('ia_prompt_versions', 'select=versao&order=versao.desc&limit=1')
    const maxVersao = Array.isArray(rows) && rows.length > 0 ? (Number(rows[0].versao) || 0) : 0
    const novaVersao = maxVersao + 1

    // 2. Desativa a versão atual (antes do insert, para o unique index não conflitar)
    await sb.update('ia_prompt_versions', 'ativa=eq.true', {
      ativa: false,
      deactivated_at: new Date().toISOString(),
    })

    // 3. Insere nova versão ativa
    const now = new Date().toISOString()
    const inserted = await sb.insert(
      'ia_prompt_versions',
      {
        versao: novaVersao,
        agent_rules_text,
        ativa: true,
        activated_at: now,
        created_at: now,
        created_by: created_by || null,
        origem_proposta_id: origem_proposta_id || null,
        diff_resumo: diff_resumo || null,
      },
      true,
    )
    return Array.isArray(inserted) ? inserted[0] : inserted
  } catch (err) {
    throw new Error(`[promptVersionStore/supabase] createVersionAndActivate: ${err.message}`)
  }
}

/**
 * Cria uma nova versão copiando o conteúdo da versão alvo (rollback linear).
 * Não reativa a versão original — cria uma versão nova idêntica em conteúdo.
 */
export async function rollbackToVersion(env, versionId) {
  const target = await getVersionById(env, versionId)
  if (!target) throw new Error(`[promptVersionStore/rollback] Versão id=${versionId} não encontrada`)

  return createVersionAndActivate(env, {
    agent_rules_text: target.agent_rules_text,
    created_by: 'manual_rollback',
    diff_resumo: `Rollback para versão ${target.versao}`,
  })
}
