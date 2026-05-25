/**
 * Captura a conversa de um lead convertido.
 * Estratégia:
 *   1. Lista talks via tryListTalksForLead (Kommo REST v4)
 *   2. Para cada talk, tenta GET /api/v4/talks/{id}/messages?limit=250&order[id]=asc
 *   3. Complementa com mensagens_atendimento_comercial (Supabase principal)
 *   4. Monta e retorna snapshot final normalizado
 */

import { tryListTalksForLead } from '../kommoClient.js'
import { makeMainSupabase } from './mainSupabaseClient.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Tenta buscar mensagens de um talk via REST Kommo.
 * Endpoint primário: GET /api/v4/talks/{talkId}/messages
 * Retorna array de mensagens normalizadas ou [] se indisponível.
 */
async function listTalkMessages(env, talkId) {
  const baseUrl = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''
  if (!baseUrl || !token) return []

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  // Tenta endpoint de mensagens do talk
  const endpoints = [
    `${baseUrl}/api/v4/talks/${talkId}/messages?limit=250&order[id]=asc`,
    `${baseUrl}/api/v4/talks/${talkId}`,
  ]

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) {
        console.warn(`[IaLearning/capture] listTalkMessages talk=${talkId} url=${url} status=${res.status}`)
        continue
      }
      const data = await res.json()

      // Endpoint /messages retorna {_embedded: {messages: [...]}} ou similar
      const msgs = data?._embedded?.messages
        || data?._embedded?.talk_messages
        || data?.messages
        || []
      if (Array.isArray(msgs) && msgs.length > 0) {
        return normalizeKommoMessages(msgs)
      }

      // Se retornou só o talk sem mensagens, sinaliza que o endpoint não tem mensagens
      console.warn(`[IaLearning/capture] listTalkMessages talk=${talkId}: sem mensagens em ${url}`)
    } catch (e) {
      console.warn(`[IaLearning/capture] listTalkMessages talk=${talkId} err: ${e.message}`)
    }
  }

  return []
}

/**
 * Normaliza mensagens brutas do Kommo para o formato { ts, remetente, texto }.
 */
function normalizeKommoMessages(rawMsgs) {
  const out = []
  for (const m of rawMsgs) {
    const ts = m.created_at
      ? new Date(Number(m.created_at) * 1000).toISOString()
      : (m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null)
    const remetente = m.author?.type === 'bot' || m.direction === 'outgoing' || m.from === 'system'
      ? 'consultor'
      : 'lead'
    const texto = m.content?.text || m.text || m.body || ''
    if (texto && texto.trim()) {
      out.push({ ts, remetente, texto: texto.trim() })
    }
  }
  return out
}

/**
 * Busca mensagens do Supabase principal (mensagens_atendimento_comercial).
 */
async function fetchMensagensAtendimento(env, leadId) {
  const db = makeMainSupabase(env)
  if (!db) return []
  try {
    const rows = await db.select(
      'mensagens_atendimento_comercial',
      `select=*&lead_id=eq.${Number(leadId)}&order=created_at.asc&limit=500`,
    )
    if (!Array.isArray(rows) || rows.length === 0) return []
    return rows.map((r) => ({
      ts: r.created_at || null,
      remetente: r.role === 'assistant' || r.direction === 'outgoing' ? 'consultor' : 'lead',
      texto: (r.content || r.message || r.text || '').trim(),
    })).filter((m) => m.texto)
  } catch (e) {
    console.warn(`[IaLearning/capture] fetchMensagensAtendimento lead=${leadId} err: ${e.message}`)
    return []
  }
}

/**
 * Mescla e deduplica mensagens de duas fontes, ordenando por ts.
 */
function mergeMensagens(kommoMsgs, supabaseMsgs) {
  const all = [...kommoMsgs, ...supabaseMsgs]
  // Dedup por (ts, remetente, primeiros 60 chars do texto)
  const seen = new Set()
  const deduped = []
  for (const m of all) {
    const key = `${m.ts}|${m.remetente}|${String(m.texto).slice(0, 60)}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(m)
    }
  }
  deduped.sort((a, b) => {
    if (!a.ts) return 1
    if (!b.ts) return -1
    return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
  })
  return deduped
}

/**
 * Captura a conversa completa de um lead convertido.
 *
 * @param {Record<string,string>} env
 * @param {{ leadId: number, consultorId?: number, consultorNome?: string }} opts
 * @returns {{ snapshot: object, fonte: string, totalMensagens: number, error?: string }}
 */
export async function captureConversation(env, { leadId, consultorId, consultorNome }) {
  const lid = Number(leadId)
  let kommoMsgs = []
  let supabaseMsgs = []
  let captureError = null

  // 1) Tenta talks + mensagens via Kommo REST
  try {
    const talksResult = await tryListTalksForLead(env, lid)
    const talks = talksResult.ok ? (talksResult.talks || []) : []

    if (talks.length === 0) {
      console.warn(`[IaLearning/capture] lead=${lid}: nenhum talk encontrado`)
      captureError = 'no_talks_found'
    }

    for (const talk of talks.slice(0, 5)) {
      const talkId = talk?.id ?? talk?.talk_id
      if (!talkId) continue
      const msgs = await listTalkMessages(env, talkId)
      kommoMsgs.push(...msgs)
      await sleep(500)
    }

    if (talks.length > 0 && kommoMsgs.length === 0) {
      console.warn(`[IaLearning/capture] lead=${lid}: talks encontrados mas sem mensagens — chats_api_unavailable`)
      captureError = 'chats_api_unavailable'
    }
  } catch (e) {
    console.warn(`[IaLearning/capture] lead=${lid} talks err: ${e.message}`)
    captureError = captureError || `talks_error: ${e.message.slice(0, 100)}`
  }

  // 2) Complementa com mensagens_atendimento_comercial
  try {
    supabaseMsgs = await fetchMensagensAtendimento(env, lid)
  } catch (e) {
    console.warn(`[IaLearning/capture] lead=${lid} supabase msgs err: ${e.message}`)
  }

  // 3) Mescla
  const merged = mergeMensagens(kommoMsgs, supabaseMsgs)

  // 4) Determina fonte
  let fonte = 'kommo_chats'
  if (kommoMsgs.length > 0 && supabaseMsgs.length > 0) {
    fonte = 'hibrido'
  } else if (kommoMsgs.length === 0 && supabaseMsgs.length > 0) {
    fonte = 'mensagens_atendimento_comercial'
    captureError = null // fonte alternativa funcionou
  } else if (kommoMsgs.length === 0 && supabaseMsgs.length === 0) {
    captureError = captureError || 'sem_mensagens'
  }

  // 5) Calcula duração
  let duracaoHoras = null
  const timestamps = merged.map((m) => m.ts).filter(Boolean)
  if (timestamps.length >= 2) {
    const first = new Date(timestamps[0]).getTime()
    const last = new Date(timestamps[timestamps.length - 1]).getTime()
    duracaoHoras = Math.round(((last - first) / 3_600_000) * 10) / 10
  }

  const snapshot = {
    lead_id: lid,
    consultor_id: consultorId ?? null,
    consultor_nome: consultorNome ?? null,
    fonte,
    total_mensagens: merged.length,
    duracao_horas: duracaoHoras,
    mensagens: merged,
  }

  console.log(
    `[IaLearning/capture] lead=${lid} fonte=${fonte} msgs_kommo=${kommoMsgs.length} msgs_supa=${supabaseMsgs.length} total=${merged.length}${captureError ? ` err=${captureError}` : ''}`,
  )

  return {
    snapshot,
    fonte,
    totalMensagens: merged.length,
    ...(captureError ? { error: captureError } : {}),
  }
}
