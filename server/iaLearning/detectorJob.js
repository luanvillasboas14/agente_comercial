/**
 * Job de detecção de leads convertidos (aceite).
 * Roda 1x/dia. Consulta kommo_consultor_eventos no Supabase principal
 * para encontrar leads que entraram no status de aceite nos últimos 7 dias.
 * Para cada novo lead: captura conversa e insere em ia_leads_convertidos.
 */

import { makeMainSupabase } from './mainSupabaseClient.js'
import { leadJaDetectado, insertLeadConvertido, deleteLeadsComErroNaoProcessados } from './leadsConvertidosStore.js'
import { captureConversation } from './conversationCapture.js'
import { getConsultoresAtivos } from '../kommoEvents/consultoresSource.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runDetectorJob(env, { trigger = 'manual', onProgress = null } = {}) {
  const reportProgress = (patch) => {
    if (typeof onProgress === 'function') {
      try { onProgress(patch) } catch { /* noop */ }
    }
  }
  const aceiteStatusId = Number(env.KOMMO_ACEITE_STATUS_ID || 48566207)
  const aceitePipelineId = Number(env.KOMMO_ACEITE_PIPELINE_ID || 5481944)

  console.log(`[IaLearning] detector iniciando trigger=${trigger} aceiteStatus=${aceiteStatusId} aceitePipeline=${aceitePipelineId}`)

  // Limpa registros com erro de captura não-processados — permite re-tentar
  // com a estratégia atual de captura.
  try {
    const removed = await deleteLeadsComErroNaoProcessados(env)
    if (removed > 0) console.log(`[IaLearning] detector: ${removed} leads com erro_captura limpos pra re-tentativa`)
  } catch (e) {
    console.warn(`[IaLearning] detector: falha ao limpar erros antigos: ${e.message}`)
  }

  const db = makeMainSupabase(env)
  if (!db) {
    console.error('[IaLearning] detector: SUPABASE_URL / SUPABASE_KEY não configurados — abortando')
    return { ok: false, reason: 'no_supabase' }
  }

  // 1) Busca eventos de mudança de status pro aceite nos últimos 7 dias
  let eventos = []
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

  // Helper de filtragem defensiva (caso PostgREST traga eventos sem o status alvo)
  const matchesAceite = (r) => {
    const raw = r.raw || {}
    const valueAfterArr = raw?.value_after || raw?.data?.value_after || []
    const va = Array.isArray(valueAfterArr) ? valueAfterArr[0] : valueAfterArr
    if (!va) return false
    const ls = va?.lead_status || va
    return Number(ls?.id) === aceiteStatusId && Number(ls?.pipeline_id) === aceitePipelineId
  }

  try {
    // Caminho 1 (rápido): filtra direto no PostgREST via contains JSONB.
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
    eventos = (Array.isArray(rows) ? rows : []).filter(matchesAceite)
  } catch (e) {
    console.warn(`[IaLearning] detector: query rápida falhou (${e.message}). Tentando fallback paginado sem filtro JSONB...`)
    try {
      // Caminho 2 (fallback): pagina sem o filtro `raw=cs` (caso PostgREST não suporte
      // ou o JSONB não tenha índice GIN). Mais lento mas robusto.
      const PAGE = 1000
      const MAX_PAGES = 20 // teto: 20k eventos em 7 dias
      const acumulados = []
      for (let p = 0; p < MAX_PAGES; p++) {
        const offset = p * PAGE
        const rows = await db.select(
          'kommo_consultor_eventos',
          `select=entity_id,created_at_kommo,created_by,raw` +
          `&event_type=eq.lead_status_changed` +
          `&created_at_kommo=gte.${encodeURIComponent(sevenDaysAgoIso)}` +
          `&order=created_at_kommo.desc` +
          `&limit=${PAGE}&offset=${offset}`,
        )
        const arr = Array.isArray(rows) ? rows : []
        acumulados.push(...arr)
        if (arr.length < PAGE) break
      }
      console.log(`[IaLearning] detector: fallback trouxe ${acumulados.length} eventos lead_status_changed em 7d, filtrando localmente`)
      eventos = acumulados.filter(matchesAceite)
    } catch (e2) {
      console.error(`[IaLearning] detector: erro ao buscar eventos (fallback também falhou): ${e2.message}`)
      return { ok: false, reason: 'query_failed', error: e2.message }
    }
  }

  console.log(`[IaLearning] detector: ${eventos.length} eventos de aceite encontrados nos últimos 7 dias`)
  reportProgress({ total: eventos.length, processados: 0, novos: 0, skipJaDetectado: 0, errosCaptura: 0 })

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

    reportProgress({ total: eventos.length, processados: novos + skipJaDetectado + errosCaptura, novos, skipJaDetectado, errosCaptura })

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
