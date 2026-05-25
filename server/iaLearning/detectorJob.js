/**
 * Job de detecção de leads convertidos (aceite).
 * Roda 1x/dia. Consulta kommo_consultor_eventos no Supabase principal
 * para encontrar leads que entraram no status de aceite nos últimos 7 dias.
 * Para cada novo lead: captura conversa e insere em ia_leads_convertidos.
 */

import { makeMainSupabase } from './mainSupabaseClient.js'
import { leadJaDetectado, insertLeadConvertido } from './leadsConvertidosStore.js'
import { captureConversation } from './conversationCapture.js'
import { getConsultoresAtivos } from '../kommoEvents/consultoresSource.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runDetectorJob(env, { trigger = 'manual' } = {}) {
  const aceiteStatusId = Number(env.KOMMO_ACEITE_STATUS_ID || 48566207)
  const aceitePipelineId = Number(env.KOMMO_ACEITE_PIPELINE_ID || 5481944)

  console.log(`[IaLearning] detector iniciando trigger=${trigger} aceiteStatus=${aceiteStatusId} aceitePipeline=${aceitePipelineId}`)

  const db = makeMainSupabase(env)
  if (!db) {
    console.error('[IaLearning] detector: SUPABASE_URL / SUPABASE_KEY não configurados — abortando')
    return { ok: false, reason: 'no_supabase' }
  }

  // 1) Busca eventos de mudança de status pro aceite nos últimos 7 dias
  let eventos = []
  try {
    // Filtra diretamente no PostgREST via contains JSONB — pega só os eventos
    // que mudaram pro status/pipeline alvo, sem trazer 15k+ rows desnecessárias.
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const containsObj = {
      value_after: [{ lead_status: { id: aceiteStatusId, pipeline_id: aceitePipelineId } }],
    }
    const containsCs = encodeURIComponent(JSON.stringify(containsObj))
    const rows = await db.select(
      'kommo_consultor_eventos',
      `select=entity_id,created_at_kommo,created_by,raw` +
      `&event_type=eq.lead_status_changed` +
      `&created_at_kommo=gte.${encodeURIComponent(sevenDaysAgoIso)}` +
      `&raw=cs.${containsCs}` +
      `&order=created_at_kommo.desc` +
      `&limit=1000`,
    )
    // PostgREST já filtrou; mas mantenho check defensivo
    eventos = (Array.isArray(rows) ? rows : []).filter((r) => {
      const raw = r.raw || {}
      const valueAfterArr = raw?.value_after || raw?.data?.value_after || []
      const va = Array.isArray(valueAfterArr) ? valueAfterArr[0] : valueAfterArr
      if (!va) return false
      const ls = va?.lead_status || va
      return (
        Number(ls?.id) === aceiteStatusId &&
        Number(ls?.pipeline_id) === aceitePipelineId
      )
    })
  } catch (e) {
    console.error(`[IaLearning] detector: erro ao buscar eventos: ${e.message}`)
    return { ok: false, reason: 'query_failed', error: e.message }
  }

  console.log(`[IaLearning] detector: ${eventos.length} eventos de aceite encontrados nos últimos 7 dias`)

  // 2) Busca mapa de consultores para resolução de nome
  let consultoresMap = new Map()
  try {
    const consultores = await getConsultoresAtivos(env)
    for (const c of consultores) {
      consultoresMap.set(Number(c.kommoUserId), c.nome)
    }
  } catch (e) {
    console.warn(`[IaLearning] detector: getConsultoresAtivos falhou: ${e.message}`)
  }

  let novos = 0
  let skipJaDetectado = 0
  let errosCaptura = 0

  for (const evento of eventos) {
    const leadId = Number(evento.entity_id)
    if (!Number.isFinite(leadId) || leadId <= 0) continue

    // Skip se já foi detectado antes
    const jaDetectado = await leadJaDetectado(env, leadId).catch(() => false)
    if (jaDetectado) {
      skipJaDetectado += 1
      continue
    }

    // Resolve consultor
    const consultorId = Number(evento.created_by) || null
    const consultorNome = consultorId ? (consultoresMap.get(consultorId) || null) : null

    // Captura conversa
    let captureResult
    try {
      captureResult = await captureConversation(env, { leadId, consultorId, consultorNome })
    } catch (e) {
      console.error(`[IaLearning] detector: captureConversation lead=${leadId} falhou: ${e.message}`)
      captureResult = { snapshot: {}, fonte: null, totalMensagens: 0, error: e.message.slice(0, 200) }
    }

    const { snapshot, fonte, totalMensagens, error: captureError } = captureResult
    if (captureError) errosCaptura += 1

    // Extrai pipeline_id do evento raw (estrutura: value_after[0].lead_status.pipeline_id)
    const raw = evento.raw || {}
    const valueAfterArr = raw?.value_after || raw?.data?.value_after || []
    const va = Array.isArray(valueAfterArr) ? valueAfterArr[0] : valueAfterArr
    const ls = va?.lead_status || va
    const pipelineId = Number(ls?.pipeline_id) || aceitePipelineId

    try {
      await insertLeadConvertido(env, {
        lead_id: leadId,
        status_novo: aceiteStatusId,
        pipeline_id: pipelineId,
        consultor_id: consultorId,
        consultor_nome: consultorNome,
        fonte_conversa: fonte,
        conversa_snapshot: snapshot,
        total_mensagens: totalMensagens,
        ...(captureError ? { capture_error: captureError } : {}),
      })
      novos += 1
    } catch (e) {
      // Se unique conflict (lead_id já existe), é race condition — OK ignorar
      if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
        skipJaDetectado += 1
      } else {
        console.error(`[IaLearning] detector: insertLeadConvertido lead=${leadId} falhou: ${e.message}`)
        errosCaptura += 1
      }
    }

    // Delay entre leads para não bombardear Kommo
    await sleep(1200)
  }

  console.log(
    `[IaLearning] detector: novos=${novos} skip_ja_detectado=${skipJaDetectado} erros_captura=${errosCaptura}`,
  )

  return {
    ok: true,
    trigger,
    novos,
    skipJaDetectado,
    errosCaptura,
    totalEventos: eventos.length,
  }
}
