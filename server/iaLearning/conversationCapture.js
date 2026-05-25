/**
 * Captura a conversa de um lead convertido.
 *
 * Fonte PRIMÁRIA: tabela `mensagens_atendimento_comercial` no Supabase FEEDBACK
 * (a mesma usada pelo `feedbackJob`). Tem todas as colunas necessárias:
 * lead_id, contact_id, direction, message_text, sent_at, sender_type, consultor_responsavel.
 *
 * Estratégia:
 *   1) SELECT por lead_id=eq.X
 *   2) Se vazio, busca contact_ids do lead no Kommo e tenta por contact_id=in.(...)
 *   3) Normaliza pro formato { ts, remetente, texto }
 *
 * NÃO usamos mais a Chats API do Kommo — o endpoint REST público não retorna
 * o conteúdo das mensagens. As mensagens já estão no banco de Feedback.
 */

import { getFeedbackSupabase } from '../iaFeedback/supabaseClient.js'
import { getLeadContactIds } from '../kommoClient.js'

/**
 * Normaliza uma linha de mensagens_atendimento_comercial pro formato comum.
 */
function normalizeRow(row) {
  const ts = row.sent_at || row.created_at || null
  // direction: 'in' = veio do lead, 'out' = veio do consultor/sistema
  const dir = String(row.direction || '').toLowerCase()
  const remetente = (dir === 'in' || dir === 'incoming' || row.sender_type === 'contact' || row.sender_type === 'lead')
    ? 'lead'
    : 'consultor'
  const texto = String(row.message_text || row.content || '').trim()
  return { ts, remetente, texto }
}

async function fetchByLeadId(sb, leadId) {
  try {
    const rows = await sb.select(
      'mensagens_atendimento_comercial',
      `select=sent_at,created_at,direction,sender_type,sender_name,consultor_responsavel,message_text` +
      `&lead_id=eq.${Number(leadId)}` +
      `&order=sent_at.asc.nullslast,created_at.asc.nullslast` +
      `&limit=2000`,
    )
    return Array.isArray(rows) ? rows : []
  } catch (e) {
    console.warn(`[IaLearning/capture] fetchByLeadId lead=${leadId} err: ${e.message}`)
    return []
  }
}

async function fetchByContactIds(sb, contactIds) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) return []
  const idsCsv = contactIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0).join(',')
  if (!idsCsv) return []
  try {
    const rows = await sb.select(
      'mensagens_atendimento_comercial',
      `select=sent_at,created_at,direction,sender_type,sender_name,consultor_responsavel,message_text` +
      `&contact_id=in.(${idsCsv})` +
      `&order=sent_at.asc.nullslast,created_at.asc.nullslast` +
      `&limit=2000`,
    )
    return Array.isArray(rows) ? rows : []
  } catch (e) {
    console.warn(`[IaLearning/capture] fetchByContactIds contacts=${idsCsv} err: ${e.message}`)
    return []
  }
}

/**
 * Captura a conversa completa de um lead convertido.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId: number, consultorId?: number, consultorNome?: string }} opts
 * @returns {{ snapshot: object, fonte: string|null, totalMensagens: number, error?: string }}
 */
export async function captureConversation(env, { leadId, consultorId, consultorNome }) {
  const lid = Number(leadId)
  const sb = getFeedbackSupabase(env)
  if (!sb) {
    return {
      snapshot: { lead_id: lid, mensagens: [] },
      fonte: null,
      totalMensagens: 0,
      error: 'no_supabase_feedback',
    }
  }

  let rows = []
  let fonte = null

  // 1) tenta por lead_id
  rows = await fetchByLeadId(sb, lid)
  if (rows.length > 0) {
    fonte = 'mensagens_por_lead'
  } else {
    // 2) fallback: pega contact_ids via Kommo e tenta de novo
    try {
      const contactIds = await getLeadContactIds(env, lid)
      if (contactIds.length > 0) {
        rows = await fetchByContactIds(sb, contactIds)
        if (rows.length > 0) {
          fonte = 'mensagens_por_contact'
        }
      }
    } catch (e) {
      console.warn(`[IaLearning/capture] fallback contact_id lead=${lid} err: ${e.message}`)
    }
  }

  const mensagens = rows.map(normalizeRow).filter((m) => m.texto)

  // duração
  let duracaoHoras = null
  const tsList = mensagens.map((m) => m.ts).filter(Boolean)
  if (tsList.length >= 2) {
    const first = new Date(tsList[0]).getTime()
    const last = new Date(tsList[tsList.length - 1]).getTime()
    if (Number.isFinite(first) && Number.isFinite(last)) {
      duracaoHoras = Math.round(((last - first) / 3_600_000) * 10) / 10
    }
  }

  const snapshot = {
    lead_id: lid,
    consultor_id: consultorId ?? null,
    consultor_nome: consultorNome ?? null,
    fonte,
    total_mensagens: mensagens.length,
    duracao_horas: duracaoHoras,
    mensagens,
  }

  const error = mensagens.length === 0 ? 'sem_mensagens' : null

  console.log(
    `[IaLearning/capture] lead=${lid} fonte=${fonte || 'nenhuma'} total=${mensagens.length}${error ? ` err=${error}` : ''}`,
  )

  return {
    snapshot,
    fonte,
    totalMensagens: mensagens.length,
    ...(error ? { error } : {}),
  }
}
