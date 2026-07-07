// Feedback Comercial - Job Runner
// Reimplementa o fluxo n8n em JS puro, usando Supabase REST API
//
// env esperado:
//   SUPABASE_URL_FEEDBACK    - URL do Supabase das tabelas de atendimento/feedback
//   SUPABASE_KEY_FEEDBACK    - secret key (server-side apenas)
//   OPENAI_API_KEY           - obrigatório para este job (ou VITE_OPENAI_API_KEY em dev)
//   FEEDBACK_JOB_OPENAI_MODEL — opcional, default gpt-4o-mini
//   FEEDBACK_JOB_WINDOW_MINUTES (default 90) — janela deslizante até “agora”
//   Mensagens na janela: sent_at >= since OU (sent_at nulo E created_at >= since), sempre com contact_id ou lead_id.
//   FEEDBACK_JOB_EXPECTED_INTERVAL_MINUTES (default 60) — intervalo esperado entre runs com sucesso
//   FEEDBACK_JOB_MAX_LOOKBACK_EXTENSION_MINUTES (default 120) — amplia lookback se run atrasou / faltou
//   FEEDBACK_JOB_USE_HOUR_SLOT_LOCK (default true) — 1 execução cron/catchup por hora UTC (id FB-HOURUTC-…)
//   FEEDBACK_JOB_STARTUP_CATCHUP — ver feedbackJobRunner.js (default desligado)

import {
  normalizeConsultor, parseDate, toIso, numericOrNull, average, maxOrNull,
  contentFromMessage, chooseBetterRow, parseJsonMaybe,
  getSaoPauloParts, isSundayInSaoPaulo, isOutOfHours, isBusinessHour,
  getLocalDateKey, exceededFollowupDeadline, hasUrl, detectDecline,
  looksLikeWeakClosingWithoutNextStep, clamp, completenessScoreMessage,
  generateJobExecutionId,
  makeCronHourSlotExecId,
} from './feedbackHelpers.js'

import { resolveModel } from './ai/modelRegistry.js'
import { loadKommoStatusMap, resolveFase } from './kommoStatusMap.js'
import { fetchKnowledgeGrounding } from './feedbackGrounding.js'

/** Janela temporal na busca: sent_at >= since OU (sent_at nulo E created_at >= since). Inclui linhas antigas só com created_at. */
function buildMensagensWindowAndEntityFilter(sinceIso) {
  const enc = encodeURIComponent(sinceIso)
  return (
    'and=(' +
    'or(contact_id.not.is.null,lead_id.not.is.null),' +
    `or(sent_at.gte.${enc},and(sent_at.is.null,created_at.gte.${enc}))` +
    ')'
  )
}

function formatInstantBrasilia(iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'medium',
    })
  } catch {
    return iso
  }
}

/**
 * Monta o texto linear da conversa (o que vai pra IA e fica salvo em
 * conversa_completa.conversation_text). Horários em America/Sao_Paulo
 * (antes iam em UTC ISO cru — "2026-06-26T19:13:40.000Z" — o que confundia
 * na leitura e no dashboard). Mensagens pré-prontas ("/") ganham o marcador
 * [MSG PRONTA] pra IA e o dashboard saberem que foi template do consultor.
 */
function buildConversationText(messages, consultorName) {
  return (messages || []).map((m) => {
    const when = m.sent_at_sp || (m.sent_at ? formatInstantBrasilia(m.sent_at) : '')
    const isCtx = m.is_context_only === true
    const sender = isCtx
      ? (m.sender_name || 'Robô/Automação')
      : (m.sender_name || (String(m.sender_type).toLowerCase() === 'user' ? consultorName : 'Contato'))
    const tag = isCtx ? ' [ROBÔ - CONTEXTO, NÃO AVALIAR]' : (m.is_template ? ' [MSG PRONTA]' : '')
    const content = m.content || m.message_text || (m.media_url ? `[MIDIA]: ${m.media_url}` : '[SEM CONTEUDO]')
    return `${when} | ${sender} | ${m.sender_type}${tag}: ${content}`
  }).join('\n')
}

function getAIConfig(env) {
  const key = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
  // Resolve via registry: respeita OPENAI_MODEL_FEEDBACK e cai pra
  // FEEDBACK_JOB_OPENAI_MODEL / OPENAI_FEEDBACK_MODEL legados.
  const model = resolveModel(env, 'feedback')
  return { key, model }
}

/* ───────────── Supabase REST wrapper ───────────── */

/**
 * Fetch com timeout via AbortController. Sem isso o fetch pode pendurar
 * indefinidamente se o destino travar — foi uma das causas dos runs do
 * feedback ficarem 'Executando pra sempre'.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(url, options)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Timeout: ${options.method || 'GET'} ${url} não respondeu em ${timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

function makeSupabaseClient(url, key, { timeoutMs = 60_000 } = {}) {
  const baseHeaders = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  }

  async function request(method, path, body, extraHeaders = {}) {
    const res = await fetchWithTimeout(
      `${url}${path}`,
      {
        method,
        headers: { ...baseHeaders, ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
    )
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : null
  }

  return {
    select: (table, query = '') => request('GET', `/rest/v1/${table}${query ? '?' + query : ''}`),
    insert: (table, row, returning = false) =>
      request('POST', `/rest/v1/${table}`, row, returning ? { Prefer: 'return=representation' } : {}),
    update: (table, query, patch) =>
      request('PATCH', `/rest/v1/${table}?${query}`, patch, { Prefer: 'return=minimal' }),
    delete: (table, query) =>
      request('DELETE', `/rest/v1/${table}?${query}`),
    upsert: (table, row) =>
      request('POST', `/rest/v1/${table}`, row, { Prefer: 'resolution=merge-duplicates' }),
  }
}

/* ───────────── Preview do status / janela atual ───────────── */

// Conta quantas mensagens "estariam" na próxima execução, sem rodar nada.
/**
 * Roda o reaper manualmente — útil pra desbloquear a UI quando há runs
 * presos em 'Executando...' sem precisar esperar a próxima execução do
 * cron. Exposto via endpoint POST /api/feedback-job/reap-stale.
 */
export async function reapStaleFeedbackRuns(env, maxAgeMinutes) {
  const { SUPABASE_URL_FEEDBACK, SUPABASE_KEY_FEEDBACK } = env
  if (!SUPABASE_URL_FEEDBACK || !SUPABASE_KEY_FEEDBACK) {
    throw new Error('feedback supabase não configurado')
  }
  const sb = makeSupabaseClient(SUPABASE_URL_FEEDBACK, SUPABASE_KEY_FEEDBACK, {
    timeoutMs: Number(env.FEEDBACK_JOB_SUPABASE_TIMEOUT_MS || 60_000),
  })
  const minAge = Number.isFinite(Number(maxAgeMinutes))
    ? Number(maxAgeMinutes)
    : Number(env.FEEDBACK_JOB_REAP_AFTER_MINUTES || 30)
  const count = await reapStaleRuns(sb, minAge)
  return { reaped: count, max_age_minutes: minAge }
}

export async function getFeedbackJobPreview(env) {
  const {
    SUPABASE_URL_FEEDBACK, SUPABASE_KEY_FEEDBACK,
    FEEDBACK_JOB_WINDOW_MINUTES = '90',
    FEEDBACK_JOB_BUFFER_MINUTES = '30',
    FEEDBACK_JOB_MAX_WINDOW_MINUTES = '0',
  } = env
  if (!SUPABASE_URL_FEEDBACK || !SUPABASE_KEY_FEEDBACK) {
    return { error: 'feedback supabase não configurado' }
  }
  const sb = makeSupabaseClient(SUPABASE_URL_FEEDBACK, SUPABASE_KEY_FEEDBACK)

  const windowInfo = await computeAdaptiveWindow(
    sb,
    Number(FEEDBACK_JOB_WINDOW_MINUTES),
    Number(FEEDBACK_JOB_BUFFER_MINUTES),
    Number(FEEDBACK_JOB_MAX_WINDOW_MINUTES) || 0,
    env,
  )

  let pendingCount = null
  try {
    // Count-only via header Prefer: count=exact (usa HEAD pra não baixar rows)
    const filter = buildMensagensWindowAndEntityFilter(windowInfo.sinceIso)
    const res = await fetch(
      `${SUPABASE_URL_FEEDBACK}/rest/v1/mensagens_atendimento_comercial` +
      `?select=id&${filter}`,
      {
        method: 'HEAD',
        headers: {
          apikey: SUPABASE_KEY_FEEDBACK,
          Authorization: `Bearer ${SUPABASE_KEY_FEEDBACK}`,
          Prefer: 'count=exact',
        },
      },
    )
    const range = res.headers.get('content-range') || ''
    const total = range.split('/')[1]
    pendingCount = total ? Number(total) : null
  } catch (e) {
    console.error('[FeedbackJob] Falha ao contar mensagens pendentes:', e.message)
  }

  // Busca o run mais recente (qualquer status) para saber se tem algo executando
  let currentRun = null
  let lastRun = null
  try {
    const rows = await sb.select(
      'feedback_job_runs',
      'select=id,started_at,finished_at,status,duration_ms,total_messages_fetched,total_segments&order=started_at.desc&limit=5',
    )
    currentRun = (rows || []).find((r) => r.status === 'running') || null
    lastRun = (rows || []).find((r) => r.status !== 'running') || null
  } catch (e) {
    console.error('[FeedbackJob] Falha ao buscar runs:', e.message)
  }

  let sourceStatus = null
  try {
    const rows = await sb.select(
      'mensagens_atendimento_comercial',
      'select=created_at&order=created_at.desc.nullslast&limit=1',
    )
    const lastIso = rows?.[0]?.created_at || null
    const gapMs = lastIso ? Date.now() - new Date(lastIso).getTime() : null
    const gapMinutes = gapMs != null ? Math.round(gapMs / 60000) : null
    const thresholdMin = Number(env.FEEDBACK_JOB_SOURCE_STALE_AFTER_MINUTES || 180)
    sourceStatus = {
      last_message_created_at: lastIso,
      gap_minutes: gapMinutes,
      stale_threshold_minutes: thresholdMin,
      is_stale: gapMinutes != null && gapMinutes > thresholdMin,
      has_data: lastIso != null,
    }
  } catch (e) {
    sourceStatus = { error: e.message }
  }

  return {
    window: windowInfo,
    pendingCount,
    currentRun,
    lastRun,
    sourceStatus,
  }
}

/* ───────────── Step 1: Fetch + Agrupar Atendimentos ───────────── */

async function fetchRecentMessages(sb, sinceIso) {
  // Supabase/PostgREST aplica um max-rows (geralmente 1000). Paginamos com
  // limit+offset até esgotar. Ordenação estável por (sent_at, created_at, id)
  // garante que não pulamos nem repetimos registros entre páginas.
  const PAGE_SIZE = 1000
  const HARD_CAP = 50000 // trava de segurança para não ficar em loop infinito
  const all = []
  let offset = 0
  let pageCount = 0

  while (offset < HARD_CAP) {
    const query = [
      'select=*',
      buildMensagensWindowAndEntityFilter(sinceIso),
      'order=sent_at.asc.nullslast,created_at.asc.nullslast,id.asc',
      `limit=${PAGE_SIZE}`,
      `offset=${offset}`,
    ].join('&')

    const page = await sb.select('mensagens_atendimento_comercial', query)
    const rows = Array.isArray(page) ? page : []
    pageCount++
    all.push(...rows)
    console.log(
      `[FeedbackJob] fetch page ${pageCount}: offset=${offset} → ${rows.length} rows (total=${all.length})`
    )

    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  console.log(`[FeedbackJob] fetch total: ${all.length} mensagens em ${pageCount} página(s)`)
  return all
}

function isUniqueViolation(err) {
  const m = String(err?.message || err || '')
  return m.includes('23505') || m.includes('duplicate key') || /unique constraint/i.test(m)
}

async function reclaimHourSlotIfPreviousFailed(sb, execId, startedAtIso, trigger) {
  try {
    const rows = await sb.select(
      'feedback_job_runs',
      `id=eq.${encodeURIComponent(execId)}&select=id,status`,
    )
    const row = rows?.[0]
    if (row?.status !== 'error') return false
    await sb.delete('feedback_job_runs', `id=eq.${encodeURIComponent(execId)}`)
    await sb.insert('feedback_job_runs', {
      id: execId,
      started_at: startedAtIso,
      status: 'running',
      trigger,
      steps: [],
    })
    console.log(`[FeedbackJob] Slot ${execId}: run anterior com erro removido; nova tentativa.`)
    return true
  } catch {
    return false
  }
}

/**
 * Marca como 'error' qualquer run anterior que ainda esteja com status
 * 'running' há mais de `maxAgeMinutes` minutos (default 90). Resolve o
 * caso clássico de "ficou Executando pra sempre" — o processo Node morreu
 * (deploy, OOM, restart) entre o INSERT inicial e o UPDATE final, deixando
 * a linha presa em 'running' indefinidamente.
 *
 * Roda na entrada de cada execução. Idempotente — se não houver runs
 * presos, retorna 0. Configurável via FEEDBACK_JOB_REAP_AFTER_MINUTES.
 */
async function reapStaleRuns(sb, maxAgeMinutes = 30) {
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) return 0
  const cutoffIso = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString()
  try {
    const stale = await sb.select(
      'feedback_job_runs',
      `select=id,started_at&status=eq.running&started_at=lt.${encodeURIComponent(cutoffIso)}&finished_at=is.null&order=started_at.asc&limit=50`,
    )
    if (!Array.isArray(stale) || stale.length === 0) return 0
    const finishedAt = new Date().toISOString()
    for (const r of stale) {
      try {
        await sb.update(
          'feedback_job_runs',
          `id=eq.${encodeURIComponent(r.id)}&status=eq.running`,
          {
            status: 'error',
            error_message: `Run abandonado: status='running' há mais de ${maxAgeMinutes} min sem finalizar (provavel crash do processo, deploy ou timeout). Marcado pelo reaper.`,
            finished_at: finishedAt,
          },
        )
      } catch (e) {
        console.warn(`[FeedbackJob] reaper: falha ao marcar ${r.id}:`, e.message)
      }
    }
    console.log(`[FeedbackJob] Reaper: ${stale.length} run(s) preso(s) marcado(s) como erro.`)
    return stale.length
  } catch (e) {
    console.warn('[FeedbackJob] reaper falhou:', e.message)
    return 0
  }
}

/**
 * Roda o reaper de runs zumbis fora do contexto de uma execução.
 * Usado pelo scheduler tick (a cada 5 min). Cria próprio cliente Supabase.
 */
export async function reapStaleRunsExternal(env) {
  const url = (env?.SUPABASE_URL_FEEDBACK || '').replace(/\/$/, '')
  const key = env?.SUPABASE_KEY_FEEDBACK || ''
  if (!url || !key) return 0
  const supabaseTimeoutMs = Number(env.FEEDBACK_JOB_SUPABASE_TIMEOUT_MS || 60_000)
  const sb = makeSupabaseClient(url, key, { timeoutMs: supabaseTimeoutMs })
  const reapAfterMin = Number(env.FEEDBACK_JOB_REAP_AFTER_MINUTES || 30)
  return await reapStaleRuns(sb, reapAfterMin)
}

// Janela em “sliding” de FEEDBACK_JOB_WINDOW_MINUTES (default 90) até agora.
// Se a última execução com sucesso terminou há mais que o intervalo esperado (ex.: 60 min),
// amplia o lookback em até FEEDBACK_JOB_MAX_LOOKBACK_EXTENSION_MINUTES (atraso / run perdido).
// bufferMinutes mantido na assinatura por compatibilidade (não entra mais no cálculo).
export async function computeAdaptiveWindow(
  sb,
  defaultWindowMinutes,
  bufferMinutes,
  maxWindowMinutes = 0,
  env = {},
) {
  void bufferMinutes
  const now = new Date()
  const windowMin = Number(defaultWindowMinutes) || 90
  const expectedInterval = Number(env.FEEDBACK_JOB_EXPECTED_INTERVAL_MINUTES ?? 60) || 60
  const maxExtension = Number(env.FEEDBACK_JOB_MAX_LOOKBACK_EXTENSION_MINUTES ?? 120) || 120

  let since = new Date(now.getTime() - windowMin * 60 * 1000)
  let basedOn = 'sliding_window'
  let extraBackMinutes = 0
  let lastSuccessFinishedAt = null

  try {
    const rows = await sb.select(
      'feedback_job_runs',
      `select=finished_at&status=eq.success&order=finished_at.desc&limit=1`,
    )
    lastSuccessFinishedAt = rows?.[0]?.finished_at || null
  } catch {
    /* ignore */
  }

  if (lastSuccessFinishedAt) {
    const gapMin = Math.round((now.getTime() - new Date(lastSuccessFinishedAt).getTime()) / 60000)
    extraBackMinutes = Math.max(0, Math.min(maxExtension, gapMin - expectedInterval))
    if (extraBackMinutes > 0) {
      since = new Date(since.getTime() - extraBackMinutes * 60 * 1000)
      basedOn = 'sliding_window_extended_missed_or_late'
    }
  }

  if (since > now) {
    since = new Date(now.getTime() - 5 * 60 * 1000)
    basedOn = `${basedOn}_since_clamped`
  }

  const minWidthMs = 2 * 60 * 1000
  if (now.getTime() - since.getTime() < minWidthMs) {
    since = new Date(now.getTime() - windowMin * 60 * 1000)
    basedOn = `${basedOn}_min_width`
  }

  if (maxWindowMinutes > 0) {
    const capSince = new Date(now.getTime() - maxWindowMinutes * 60 * 1000)
    if (since.getTime() < capSince.getTime()) {
      since = capSince
      basedOn = `${basedOn}_max_window_cap`
    }
  }

  const windowMinutes = Math.round((now.getTime() - since.getTime()) / 60000)
  return {
    sinceIso: since.toISOString(),
    untilIso: now.toISOString(),
    window_minutes: windowMinutes,
    based_on: basedOn,
    extra_minutes_over_hour: extraBackMinutes,
    last_fetch_until: null,
    last_run_started_at: lastSuccessFinishedAt,
  }
}

function groupIntoSegments(rawRows) {
  // Dedupe por message_uid (ou id).
  //
  // ATENÇÃO: NÃO descartamos mais mensagens `bot` aqui. As mensagens
  // pré-prontas do Kommo (os templates "/") chegam como sender_type='bot'
  // / origin='bot'. Elas devem entrar na avaliação — mas SÓ depois da
  // primeira mensagem do consultor (antes disso são automação/salesbot,
  // "robô mesmo"). Esse recorte é feito lá embaixo, no loop de segmentação
  // por entidade (ver reclassificação de bot → template do consultor).
  const deduped = new Map()
  for (const row of rawRows) {
    if (!row.contact_id && !row.lead_id) continue
    const key = row.message_uid ? `uid:${row.message_uid}` : `id:${row.id}`
    deduped.set(key, chooseBetterRow(deduped.get(key), row))
  }

  const messages = Array.from(deduped.values()).map((row) => {
    const entityType = row.contact_id ? 'contact' : 'lead'
    const entityId = row.contact_id ?? row.lead_id
    return {
      source_id: row.id ?? null,
      message_uid: row.message_uid ?? null,
      atendimento_id: row.atendimento_id ?? null,
      chat_id: row.chat_id ?? null,
      contact_id: row.contact_id ?? null,
      lead_id: row.lead_id ?? null,
      lead_nome: row.lead_nome ?? null,
      lead_telefone: row.lead_telefone ?? null,
      entity_type: entityType,
      entity_id: entityId,
      sequence_number: row.sequence_number ?? null,
      direction: row.direction ?? null,
      sender_type: row.sender_type ?? null,
      sender_name: row.sender_name ?? null,
      consultor_responsavel: normalizeConsultor(row.consultor_responsavel),
      message_type: row.message_type ?? null,
      message_text: row.message_text ?? null,
      media_url: row.media_url ?? null,
      content: contentFromMessage(row),
      response_time_seconds: numericOrNull(row.response_time_seconds),
      origin: row.origin ?? row.origem ?? null,
      pipeline_id: row.pipeline_id ?? null,
      status_id: row.status_id ?? null,
      // sender_type original preservado. Mensagens bot podem ser
      // reclassificadas como 'user' (template do consultor) no loop de
      // segmentação; raw_sender_type mantém a origem real pra auditoria.
      raw_sender_type: row.sender_type ?? null,
      is_template: false,
      is_context_only: false,
      // Horário já formatado em America/Sao_Paulo pro dashboard externo
      // não precisar converter (o sent_at cru continua em UTC ISO).
      sent_at: toIso(row.sent_at),
      sent_at_sp: row.sent_at ? formatInstantBrasilia(toIso(row.sent_at)) : null,
      created_at: toIso(row.created_at),
    }
  })

  messages.sort((a, b) => {
    if (a.entity_type !== b.entity_type) return a.entity_type.localeCompare(b.entity_type)
    if (String(a.entity_id) !== String(b.entity_id))
      return String(a.entity_id).localeCompare(String(b.entity_id))
    const da = parseDate(a.sent_at)?.getTime() || 0
    const db = parseDate(b.sent_at)?.getTime() || 0
    if (da !== db) return da - db
    const ca = parseDate(a.created_at)?.getTime() || 0
    const cb = parseDate(b.created_at)?.getTime() || 0
    if (ca !== cb) return ca - cb
    return Number(a.source_id || 0) - Number(b.source_id || 0)
  })

  // Agrupa por entidade e separa em segmentos (por consultor)
  const groups = new Map()
  for (const msg of messages) {
    const key = `${msg.entity_type}:${msg.entity_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(msg)
  }

  const output = []

  for (const [entityKey, list] of groups.entries()) {
    let currentSegment = null
    let pendingBeforeFirstConsultor = []
    let segmentIndex = 0
    // Marca se já vimos uma mensagem REAL do consultor (sender_type='user')
    // nesta entidade. Enquanto não vimos, qualquer bot é automação/salesbot
    // e é descartado. Depois da 1ª do consultor, bots viram template "/".
    let seenUserMsg = false

    function flushCurrent() {
      if (!currentSegment || !currentSegment.messages.length) return
      const sorted = [...currentSegment.messages].sort((a, b) => {
        const da = parseDate(a.sent_at)?.getTime() || 0
        const db = parseDate(b.sent_at)?.getTime() || 0
        if (da !== db) return da - db
        const ca = parseDate(a.created_at)?.getTime() || 0
        const cb = parseDate(b.created_at)?.getTime() || 0
        if (ca !== cb) return ca - cb
        return Number(a.source_id || 0) - Number(b.source_id || 0)
      })
      const first = sorted[0], last = sorted[sorted.length - 1]
      const contactId = sorted.find((m) => m.contact_id != null)?.contact_id ?? null
      const leadId = sorted.find((m) => m.lead_id != null)?.lead_id ?? null

      // Fase do lead = status/pipeline mais recente com valor não nulo
      // (a fase pode mudar ao longo da conversa; a última reflete onde o
      // lead está agora). Usado pra filtro no dashboard e pra baixar a
      // nota de quem foi pra "Perdido".
      let faseStatusId = null
      let fasePipelineId = null
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (faseStatusId == null && sorted[i].status_id != null) faseStatusId = sorted[i].status_id
        if (fasePipelineId == null && sorted[i].pipeline_id != null) fasePipelineId = sorted[i].pipeline_id
        if (faseStatusId != null && fasePipelineId != null) break
      }

      output.push({
        entity_key: entityKey,
        entity_type: first.entity_type,
        entity_id: first.entity_id,
        contact_id: contactId,
        lead_id: leadId,
        consultor: currentSegment.consultor,
        segment_index_for_entity: segmentIndex,
        is_first_segment_for_entity: segmentIndex === 1,
        first_sent_at: first.sent_at,
        last_sent_at: last.sent_at,
        total_messages_segment: sorted.length,
        fase_status_id: faseStatusId,
        pipeline_id: fasePipelineId,
        messages: sorted,
      })
    }

    for (const msg of list) {
      const isBot = String(msg.raw_sender_type || msg.sender_type || '').trim().toLowerCase() === 'bot'

      if (isBot) {
        // Bot ANTES da 1ª mensagem do consultor = automação/salesbot ("robô puro").
        // NÃO é avaliado nem contado (mantém sender_type='bot', então fica fora
        // de todas as contagens que filtram por contact/user), mas ENTRA como
        // CONTEXTO pra IA e o dashboard entenderem o histórico da conversa.
        if (!currentSegment || !seenUserMsg) {
          msg.is_context_only = true
          msg.is_template = false
          if (currentSegment) currentSegment.messages.push(msg)
          else pendingBeforeFirstConsultor.push(msg)
          continue
        }
        // Bot DEPOIS = template pré-pronto ("/") que o consultor disparou.
        // Reclassifica como mensagem do consultor e sinaliza que é template,
        // pra avaliação (SLA, regras, IA) tratar como fala do consultor e o
        // dashboard poder marcar visualmente que foi mensagem pronta.
        msg.is_template = true
        msg.is_context_only = false
        msg.sender_type = 'user'
        msg.consultor_responsavel = currentSegment.consultor
        if (!msg.sender_name) msg.sender_name = currentSegment.consultor
        currentSegment.messages.push(msg)
        continue
      }

      const consultor = normalizeConsultor(msg.consultor_responsavel)
      if (String(msg.sender_type || '').trim().toLowerCase() === 'user') seenUserMsg = true

      if (!currentSegment) {
        if (consultor) {
          segmentIndex += 1
          currentSegment = { consultor, messages: [...pendingBeforeFirstConsultor, msg] }
          pendingBeforeFirstConsultor = []
        } else {
          pendingBeforeFirstConsultor.push(msg)
        }
        continue
      }
      if (consultor && consultor !== currentSegment.consultor) {
        flushCurrent()
        segmentIndex += 1
        currentSegment = { consultor, messages: [msg] }
        continue
      }
      currentSegment.messages.push(msg)
    }
    flushCurrent()
  }

  return output
}

/* ───────────── Step 2: Métricas de tempo de resposta ───────────── */

function calculateResponseMetrics(messages) {
  const sorted = [...messages].sort((a, b) => {
    const da = parseDate(a.sent_at)?.getTime() || 0
    const db = parseDate(b.sent_at)?.getTime() || 0
    if (da !== db) return da - db
    const ca = parseDate(a.created_at)?.getTime() || 0
    const cb = parseDate(b.created_at)?.getTime() || 0
    if (ca !== cb) return ca - cb
    return Number(a.source_id || 0) - Number(b.source_id || 0)
  })

  const now = new Date()
  const pairs = []
  let pendingContact = null

  for (const msg of sorted) {
    const senderType = String(msg.sender_type || '').trim().toLowerCase()
    const sentAt = parseDate(msg.sent_at)
    if (!sentAt) continue

    if (senderType === 'contact') {
      if (!pendingContact) pendingContact = { sentAt, msg }
      continue
    }
    if (senderType === 'user' && pendingContact) {
      const diff = Math.max(0, Math.round((sentAt.getTime() - pendingContact.sentAt.getTime()) / 1000))
      const outOfHours = isOutOfHours(pendingContact.sentAt)
      pairs.push({
        contact_sent_at: pendingContact.sentAt.toISOString(),
        user_sent_at: sentAt.toISOString(),
        diff_seconds: diff,
        received_out_of_hours: outOfHours,
        received_on_sunday: isSundayInSaoPaulo(pendingContact.sentAt),
        counts_for_sla: !outOfHours,
      })
      pendingContact = null
    }
  }

  const pairDiffs = pairs.map((p) => p.diff_seconds)
  const avgFromPairs = average(pairDiffs)
  const fieldDiffs = sorted.map((m) => Number(m.response_time_seconds)).filter((n) => Number.isFinite(n) && n >= 0)
  const avgFromField = average(fieldDiffs)

  let pendingWaitSeconds = null
  let pendingOutOfHours = null
  let pendingOver1hBusiness = false
  let pendingReceivedOnSunday = null

  if (pendingContact) {
    pendingWaitSeconds = Math.max(0, Math.round((now.getTime() - pendingContact.sentAt.getTime()) / 1000))
    pendingOutOfHours = isOutOfHours(pendingContact.sentAt)
    pendingReceivedOnSunday = isSundayInSaoPaulo(pendingContact.sentAt)
    pendingOver1hBusiness = !pendingOutOfHours && pendingWaitSeconds > 3600
  }

  const within1hBusiness = pairs.filter((p) => p.counts_for_sla && p.diff_seconds <= 3600).length
  const above1hBusiness = pairs.filter((p) => p.counts_for_sla && p.diff_seconds > 3600).length
  const outOfHoursPairs = pairs.filter((p) => !p.counts_for_sla).length
  const longestBusinessResponse = maxOrNull(pairs.filter((p) => p.counts_for_sla).map((p) => p.diff_seconds))

  let finalAverage = 0, calculationBase = 'default_zero'
  if (avgFromPairs !== null) { finalAverage = avgFromPairs; calculationBase = 'timeline_pairs' }
  else if (avgFromField !== null) { finalAverage = avgFromField; calculationBase = 'response_time_seconds_field' }
  else if (pendingWaitSeconds !== null) {
    if (pendingOutOfHours) {
      finalAverage = 0
      calculationBase = pendingReceivedOnSunday ? 'pending_sunday_zeroed' : 'pending_out_of_hours_zeroed'
    } else { finalAverage = pendingWaitSeconds; calculationBase = 'pending_business_elapsed' }
  }

  return {
    final_average_seconds: finalAverage,
    calculation_base: calculationBase,
    total_pairs: pairs.length,
    average_from_pairs: avgFromPairs,
    average_from_field: avgFromField,
    responses_within_1h_business: within1hBusiness,
    responses_above_1h_business: above1hBusiness,
    responses_out_of_hours_not_penalized: outOfHoursPairs,
    longest_business_response_seconds: longestBusinessResponse,
    has_pending_contact: !!pendingContact,
    pending_contact_wait_seconds: pendingWaitSeconds,
    pending_contact_out_of_hours: pendingOutOfHours,
    pending_contact_received_on_sunday: pendingReceivedOnSunday,
    pending_contact_over_1h_business: pendingOver1hBusiness,
    pairs,
  }
}

/* ───────────── Step 3: Preparar gravação (merge antigas + novas) ───────────── */

async function prepareSegmentGravacao(sb, segmento) {
  const filter = segmento.entity_type === 'contact'
    ? `contact_id=eq.${segmento.entity_id}`
    : `lead_id=eq.${segmento.entity_id}`
  const rows = await sb.select(
    'comercial_feedback',
    `select=*&${filter}&order=updated_at.desc,id.desc&limit=1`,
  )
  const row = rows?.[0] || null

  const consultorAtual = normalizeConsultor(segmento.consultor)
  const consultorExistente = normalizeConsultor(row?.consultor)

  let modoGravacao = 'insert'
  if (row?.id && segmento.is_first_segment_for_entity === true && consultorExistente === consultorAtual) {
    modoGravacao = 'update'
  }

  const conversaExistente = parseJsonMaybe(row?.conversa_completa) || {}
  const mensagensAntigas = Array.isArray(conversaExistente.messages) ? conversaExistente.messages : []
  const mensagensNovas = Array.isArray(segmento.messages) ? segmento.messages : []

  // Track das mensagens "novas" (key não estava em mensagensAntigas).
  // Usado pra decidir se vale chamar a OpenAI de novo ou se nada relevante
  // mudou — evita re-avaliar atendimento por causa de 1 mensagem só, o que
  // gasta token e faz a nota oscilar.
  const oldKeys = new Set(
    mensagensAntigas.map((m) => (m.message_uid ? `uid:${m.message_uid}` : `id:${m.source_id}`)),
  )

  const mergedMap = new Map()
  for (const m of [...mensagensAntigas, ...mensagensNovas]) {
    const key = m.message_uid ? `uid:${m.message_uid}` : `id:${m.source_id}`
    mergedMap.set(key, chooseBetterRow(mergedMap.get(key), m, completenessScoreMessage))
  }

  const mergedMessages = Array.from(mergedMap.values()).sort((a, b) => {
    const da = parseDate(a.sent_at)?.getTime() || 0
    const db = parseDate(b.sent_at)?.getTime() || 0
    if (da !== db) return da - db
    const ca = parseDate(a.created_at)?.getTime() || 0
    const cb = parseDate(b.created_at)?.getTime() || 0
    if (ca !== cb) return ca - cb
    return Number(a.source_id || 0) - Number(b.source_id || 0)
  })

  const firstSentAt = conversaExistente.atendimento_inicio_em
    || mergedMessages[0]?.sent_at || segmento.first_sent_at || null
  const lastSentAt = mergedMessages[mergedMessages.length - 1]?.sent_at
    || segmento.last_sent_at || null

  const responseMetrics = calculateResponseMetrics(mergedMessages)
  const tempoMedio = responseMetrics.final_average_seconds ?? 0

  const conversationText = buildConversationText(mergedMessages, consultorAtual)

  const conversaCompleta = {
    entity_type: segmento.entity_type,
    entity_id: segmento.entity_id,
    contact_id: segmento.contact_id ?? conversaExistente.contact_id ?? null,
    lead_id: segmento.lead_id ?? conversaExistente.lead_id ?? null,
    consultor: consultorAtual,
    atendimento_inicio_em: firstSentAt,
    atendimento_fim_em: lastSentAt,
    ultimo_sent_at: lastSentAt,
    total_messages: mergedMessages.length,
    metricas_tempo_resposta: {
      tempo_medio_de_resposta_segundos: tempoMedio,
      base_calculo: responseMetrics.calculation_base,
      total_pares_resposta: responseMetrics.total_pairs,
      respostas_dentro_1h_horario_util: responseMetrics.responses_within_1h_business,
      respostas_acima_1h_horario_util: responseMetrics.responses_above_1h_business,
      respostas_fora_horario_nao_penalizar: responseMetrics.responses_out_of_hours_not_penalized,
      maior_tempo_resposta_horario_util_segundos: responseMetrics.longest_business_response_seconds,
      possui_mensagem_pendente_sem_resposta: responseMetrics.has_pending_contact,
      tempo_pendente_atual_segundos: responseMetrics.pending_contact_wait_seconds,
      mensagem_pendente_recebida_fora_horario: responseMetrics.pending_contact_out_of_hours,
      mensagem_pendente_recebida_no_domingo: responseMetrics.pending_contact_received_on_sunday,
      mensagem_pendente_ha_mais_de_1h_horario_util: responseMetrics.pending_contact_over_1h_business,
      pares_analisados: responseMetrics.pairs,
    },
    messages: mergedMessages,
    conversation_text: conversationText,
  }

  // Quantas mensagens humanas (contact/user) realmente foram adicionadas
  // depois do último feedback gravado? Se for 0, NADA novo — a re-avaliação
  // certamente seria a mesma. Se for baixo (1), a mudança é mínima e a
  // chamada à OpenAI provavelmente vai gerar saída similar à anterior.
  const newHumanMessages = mergedMessages.filter((m) => {
    const key = m.message_uid ? `uid:${m.message_uid}` : `id:${m.source_id}`
    if (oldKeys.has(key)) return false
    const t = String(m.sender_type || '').toLowerCase()
    return t === 'contact' || t === 'user'
  })

  return {
    modo_gravacao: modoGravacao,
    registro_id_alvo: row?.id ?? null,
    contact_id: segmento.contact_id ?? conversaExistente.contact_id ?? null,
    lead_id: segmento.lead_id ?? conversaExistente.lead_id ?? null,
    consultor: consultorAtual,
    // Fase do funil (resolvida com nome/categoria mais adiante no runner).
    fase_status_id: segmento.fase_status_id ?? null,
    pipeline_id: segmento.pipeline_id ?? null,
    conversa_completa: conversaCompleta,
    conversation_text_for_ai: conversationText,
    tempo_medio_de_resposta: tempoMedio,
    base_calculo_tempo_resposta: responseMetrics.calculation_base,
    total_pares_resposta: responseMetrics.total_pairs,
    respostas_dentro_1h_horario_util: responseMetrics.responses_within_1h_business,
    respostas_acima_1h_horario_util: responseMetrics.responses_above_1h_business,
    respostas_fora_horario_nao_penalizar: responseMetrics.responses_out_of_hours_not_penalized,
    maior_tempo_resposta_horario_util_segundos: responseMetrics.longest_business_response_seconds,
    possui_mensagem_pendente_sem_resposta: responseMetrics.has_pending_contact,
    tempo_pendente_atual_segundos: responseMetrics.pending_contact_wait_seconds,
    mensagem_pendente_recebida_fora_horario: responseMetrics.pending_contact_out_of_hours,
    mensagem_pendente_recebida_no_domingo: responseMetrics.pending_contact_received_on_sunday,
    mensagem_pendente_ha_mais_de_1h_horario_util: responseMetrics.pending_contact_over_1h_business,
    avaliacao: row?.avaliacao ?? null,
    nota_avaliacao: row?.nota_avaliacao ?? null,
    ponto_positivo: row?.ponto_positivo ?? null,
    ponto_negativo: row?.ponto_negativo ?? null,
    pontos_positivos: row?.pontos_positivos ?? null,
    pontos_negativos: row?.pontos_negativos ?? null,
    first_sent_at: firstSentAt,
    last_sent_at: lastSentAt,
    // Metadados pra decidir skip de re-avaliação no main runner:
    has_previous_feedback: !!(row?.id && row?.avaliacao && row?.nota_avaliacao != null),
    previous_human_messages_count: mensagensAntigas.filter((m) => {
      const t = String(m.sender_type || '').toLowerCase()
      return t === 'contact' || t === 'user'
    }).length,
    new_human_messages_count: newHumanMessages.length,
  }
}

/* ───────────── Step 4: Merge com pendente ───────────── */

async function mergeWithPendente(sb, base) {
  let filter = ''
  if (base.contact_id != null) filter = `contact_id=eq.${base.contact_id}`
  else if (base.lead_id != null) filter = `lead_id=eq.${base.lead_id}`
  else return base

  const rows = await sb.select(
    'comercial_feedback_pendente',
    `select=*&${filter}&order=updated_at.desc,id.desc&limit=1`,
  )
  const pendenteRow = rows?.[0] || null
  if (!pendenteRow) return { ...base, pendente_id: null, motivo_pendencia_anterior: null }

  const pendente = parseJsonMaybe(pendenteRow.conversa_pendente) || {}
  const mensagensPendentes = Array.isArray(pendente.messages) ? pendente.messages : []
  const mensagensAtuais = Array.isArray(base.conversa_completa?.messages) ? base.conversa_completa.messages : []

  const mergedMap = new Map()
  for (const m of [...mensagensPendentes, ...mensagensAtuais]) {
    const key = m.message_uid ? `uid:${m.message_uid}` : `id:${m.source_id}`
    mergedMap.set(key, chooseBetterRow(mergedMap.get(key), m, completenessScoreMessage))
  }
  const mergedMessages = Array.from(mergedMap.values()).sort((a, b) => {
    const da = parseDate(a.sent_at)?.getTime() || 0
    const db = parseDate(b.sent_at)?.getTime() || 0
    if (da !== db) return da - db
    const ca = parseDate(a.created_at)?.getTime() || 0
    const cb = parseDate(b.created_at)?.getTime() || 0
    if (ca !== cb) return ca - cb
    return Number(a.source_id || 0) - Number(b.source_id || 0)
  })

  const conversationText = buildConversationText(mergedMessages, base.consultor)

  return {
    ...base,
    pendente_id: pendenteRow.id ?? null,
    motivo_pendencia_anterior: pendenteRow.motivo_pendencia ?? null,
    conversa_completa: {
      ...base.conversa_completa,
      messages: mergedMessages,
      total_messages: mergedMessages.length,
      conversation_text: conversationText,
    },
    conversation_text_for_ai: conversationText,
  }
}

/* ───────────── Step 5: Validar conversa ───────────── */

/**
 * Decide se um atendimento tem material o suficiente pra ser avaliado pela
 * IA. Atendimentos curtos (lead que só pergunta "qual curso?" e some, ou
 * "já estou em outro atendimento, valeu") não devem ir pro feedback —
 * sem evidência pra penalizar, a IA dá nota alta e infla a média.
 *
 * Thresholds configuráveis via env (todos opcionais, defaults conservadores):
 *   FEEDBACK_JOB_MIN_HUMAN_MSGS  (8)   — total de mensagens humanas
 *   FEEDBACK_JOB_MIN_PAIRS        (2)   — pares contact→user (interações reais)
 *   FEEDBACK_JOB_MIN_USER_MSGS   (2)   — quantas vezes o consultor falou
 *   FEEDBACK_JOB_MIN_CONTACT_MSGS (2)   — quantas vezes o lead falou
 *   FEEDBACK_JOB_MIN_CHARS        (200) — total de caracteres da conversa
 */
function getValidacaoThresholds(env) {
  const num = (key, def) => {
    const v = Number(env?.[key])
    return Number.isFinite(v) && v >= 0 ? v : def
  }
  return {
    minHuman: num('FEEDBACK_JOB_MIN_HUMAN_MSGS', 8),
    minPairs: num('FEEDBACK_JOB_MIN_PAIRS', 2),
    minUser: num('FEEDBACK_JOB_MIN_USER_MSGS', 2),
    minContact: num('FEEDBACK_JOB_MIN_CONTACT_MSGS', 2),
    minChars: num('FEEDBACK_JOB_MIN_CHARS', 200),
  }
}

function validateConversa(base, env = {}) {
  const messages = Array.isArray(base.conversa_completa?.messages) ? base.conversa_completa.messages : []
  const humanMessages = messages.filter((m) =>
    ['contact', 'user'].includes(String(m.sender_type || '').toLowerCase()))
  const countContact = humanMessages.filter((m) => String(m.sender_type).toLowerCase() === 'contact').length
  const countUser = humanMessages.filter((m) => String(m.sender_type).toLowerCase() === 'user').length

  let totalPairs = 0, pendingContact = false
  for (const msg of humanMessages) {
    const type = String(msg.sender_type || '').toLowerCase()
    if (type === 'contact') { pendingContact = true; continue }
    if (type === 'user' && pendingContact) { totalPairs++; pendingContact = false }
  }

  const totalChars = String(base.conversation_text_for_ai || '').trim().length
  const totalHumanMessages = humanMessages.length
  const t = getValidacaoThresholds(env)

  let pronta = true, motivo = null
  if (countContact < 1) { pronta = false; motivo = 'sem_mensagem_contact' }
  else if (countUser < 1) { pronta = false; motivo = 'sem_resposta_humana' }
  else if (totalHumanMessages < t.minHuman) { pronta = false; motivo = 'poucas_mensagens' }
  else if (countContact < t.minContact) { pronta = false; motivo = 'lead_falou_pouco' }
  else if (countUser < t.minUser) { pronta = false; motivo = 'consultor_falou_pouco' }
  else if (totalPairs < t.minPairs) { pronta = false; motivo = 'poucas_interacoes' }
  else if (totalChars < t.minChars) { pronta = false; motivo = 'texto_insuficiente' }

  return {
    ...base,
    conversa_pronta_para_avaliacao: pronta,
    motivo_pendencia: pronta ? null : motivo,
    metricas_validacao: {
      total_human_messages: totalHumanMessages,
      count_contact: countContact,
      count_user: countUser,
      total_pairs: totalPairs,
      total_chars: totalChars,
      thresholds: t,
    },
  }
}

/* ───────────── Step 6: Regras comerciais ───────────── */

async function computeCommercialRules(sb, base) {
  let filter = `consultor=eq.${encodeURIComponent(base.consultor || '')}`
  if (base.contact_id != null) filter += `&contact_id=eq.${base.contact_id}`
  else if (base.lead_id != null) filter += `&lead_id=eq.${base.lead_id}`

  // Histórico: lê dos 2 (feedback e pendente) - simula UNION ALL
  const [fbRows, pendRows] = await Promise.all([
    sb.select('comercial_feedback', `select=id,contact_id,lead_id,consultor,conversa_completa,created_at,updated_at&${filter}&order=updated_at.desc,id.desc&limit=30`),
    sb.select('comercial_feedback_pendente', `select=id,contact_id,lead_id,consultor,conversa_pendente,created_at,updated_at&${filter}&order=updated_at.desc,id.desc&limit=30`),
  ])

  const allRows = [
    ...(fbRows || []).map((r) => ({ ...r, conversa_json: r.conversa_completa, origem_tabela: 'feedback' })),
    ...(pendRows || []).map((r) => ({ ...r, conversa_json: r.conversa_pendente, origem_tabela: 'pendente' })),
  ].sort((a, b) => {
    const da = parseDate(a.updated_at)?.getTime() || 0
    const db = parseDate(b.updated_at)?.getTime() || 0
    return db - da
  }).slice(0, 30)

  const historicoMessages = []
  for (const r of allRows) {
    const conv = parseJsonMaybe(r.conversa_json) || {}
    if (Array.isArray(conv.messages)) historicoMessages.push(...conv.messages)
  }

  const atuais = Array.isArray(base.conversa_completa?.messages) ? base.conversa_completa.messages : []
  const mergedMap = new Map()
  for (const m of [...historicoMessages, ...atuais]) {
    const key = m.message_uid ? `uid:${m.message_uid}` : `id:${m.source_id}`
    mergedMap.set(key, chooseBetterRow(mergedMap.get(key), m, completenessScoreMessage))
  }

  const messages = Array.from(mergedMap.values())
    .filter((m) => ['contact', 'user'].includes(String(m.sender_type || '').toLowerCase()))
    .sort((a, b) => {
      const da = parseDate(a.sent_at)?.getTime() || 0
      const db = parseDate(b.sent_at)?.getTime() || 0
      if (da !== db) return da - db
      const ca = parseDate(a.created_at)?.getTime() || 0
      const cb = parseDate(b.created_at)?.getTime() || 0
      if (ca !== cb) return ca - cb
      return Number(a.source_id || 0) - Number(b.source_id || 0)
    })

  const now = new Date()
  const totalHuman = messages.length
  const totalContact = messages.filter((m) => String(m.sender_type).toLowerCase() === 'contact').length
  const totalUser = messages.filter((m) => String(m.sender_type).toLowerCase() === 'user').length
  const lastMessage = messages[messages.length - 1] || null
  const lastMessageAt = parseDate(lastMessage?.sent_at)
  const conversationStoppedMoreThan1Day = lastMessageAt ? exceededFollowupDeadline(lastMessageAt, now) : false

  const contactMessages = messages.filter((m) => String(m.sender_type).toLowerCase() === 'contact')
  const lastContactMessage = contactMessages[contactMessages.length - 1] || null
  const lastContactAt = parseDate(lastContactMessage?.sent_at)
  const declineInfo = detectDecline(lastContactMessage?.content || lastContactMessage?.message_text || '')
  const lastContactClearlyDeclined = declineInfo.strong

  let lastContactIndex = -1
  if (lastContactMessage) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if ((m.message_uid || m.source_id) === (lastContactMessage.message_uid || lastContactMessage.source_id))
        lastContactIndex = i
    }
  }

  const userAfterLastContact = lastContactIndex >= 0
    ? messages.slice(lastContactIndex + 1).filter((m) => String(m.sender_type).toLowerCase() === 'user') : []
  const totalFollowupsAfterLastContact = userAfterLastContact.length
  const zeroFollowupAfterLastContact = conversationStoppedMoreThan1Day && !lastContactClearlyDeclined && totalFollowupsAfterLastContact === 0
  const onlyOneFollowupAfterLastContact = conversationStoppedMoreThan1Day && !lastContactClearlyDeclined && totalFollowupsAfterLastContact === 1
  const firstFollowupAfterLastContact = userAfterLastContact[0] || null
  const firstFollowupAfterLastContactAt = parseDate(firstFollowupAfterLastContact?.sent_at)
  const firstFollowupDelayHours = (lastContactAt && firstFollowupAfterLastContactAt)
    ? Number((((firstFollowupAfterLastContactAt.getTime() - lastContactAt.getTime()) / 3600000)).toFixed(2)) : null
  const minimumTwoFollowupsBroken = conversationStoppedMoreThan1Day && !lastContactClearlyDeclined && totalFollowupsAfterLastContact < 2
  const firstFollowupDelayedMoreThan1Day = conversationStoppedMoreThan1Day && !lastContactClearlyDeclined && (
    (firstFollowupAfterLastContactAt && lastContactAt && exceededFollowupDeadline(lastContactAt, firstFollowupAfterLastContactAt))
    || (!firstFollowupAfterLastContactAt && lastContactAt && exceededFollowupDeadline(lastContactAt, now))
  )

  let sameDayReplyFailures = 0, linkFollowupDelayFailures = 0, weakClosingFailures = 0

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const type = String(msg.sender_type || '').toLowerCase()
    const sentAt = parseDate(msg.sent_at)
    if (!sentAt) continue

    if (type === 'contact' && isBusinessHour(sentAt) && !isSundayInSaoPaulo(sentAt)
        && !detectDecline(msg.content || msg.message_text || '').strong) {
      const dayKey = getLocalDateKey(sentAt)
      let nextUser = null, sameDayUser = null
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j]
        if (String(next.sender_type || '').toLowerCase() !== 'user') continue
        const nextAt = parseDate(next.sent_at); if (!nextAt) continue
        if (!nextUser) nextUser = next
        if (getLocalDateKey(nextAt) === dayKey) { sameDayUser = next; break }
      }
      if (!sameDayUser && nextUser) {
        const nextAt = parseDate(nextUser.sent_at)
        if (nextAt && getLocalDateKey(nextAt) !== dayKey) sameDayReplyFailures++
      }
    }

    if (type === 'user' && hasUrl(msg.content || msg.message_text || '')) {
      const sentLinkAt = parseDate(msg.sent_at)
      let nextContact = null, nextUser = null
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j]
        const nt = String(next.sender_type || '').toLowerCase()
        if (!nextContact && nt === 'contact') nextContact = next
        if (!nextUser && nt === 'user') nextUser = next
        if (nextContact && nextUser) break
      }
      const nextContactAt = parseDate(nextContact?.sent_at)
      const nextUserAt = parseDate(nextUser?.sent_at)
      const customerRepliedBeforeFollowup = nextContactAt && (!nextUserAt || nextContactAt.getTime() < nextUserAt.getTime())
      if (!customerRepliedBeforeFollowup) {
        if (nextUserAt && exceededFollowupDeadline(sentLinkAt, nextUserAt)) linkFollowupDelayFailures++
        else if (!nextUserAt && exceededFollowupDeadline(sentLinkAt, now)) linkFollowupDelayFailures++
      }
    }
  }

  if (lastMessage && String(lastMessage.sender_type || '').toLowerCase() === 'user') {
    if (looksLikeWeakClosingWithoutNextStep(lastMessage.content || lastMessage.message_text || ''))
      weakClosingFailures++
  }

  const abandonmentEarlySignal = conversationStoppedMoreThan1Day && !lastContactClearlyDeclined
    && totalHuman <= 3 && totalFollowupsAfterLastContact < 2

  let scoreInterno = 10
  const penalidades = []
  const aplicar = (codigo, descricao, pontos) => {
    penalidades.push({ codigo, descricao, pontos_perdidos: pontos })
    scoreInterno -= pontos
  }

  const respostasAcima1h = Number(base.respostas_acima_1h_horario_util || 0)
  if (respostasAcima1h > 0) {
    const perda = clamp(Number((respostasAcima1h * 0.6).toFixed(2)), 0.6, 2.4)
    aplicar('sla_acima_1h', `Há ${respostasAcima1h} resposta(s) acima de 1 hora em horário útil.`, perda)
  }
  if (base.mensagem_pendente_ha_mais_de_1h_horario_util === true)
    aplicar('mensagem_pendente_mais_1h', 'Existe mensagem pendente sem resposta há mais de 1 hora em horário útil.', 1.2)
  if (zeroFollowupAfterLastContact)
    aplicar('zero_followup_apos_ultima_msg_cliente', 'Conversa parada há mais de 1 dia sem nenhum novo follow-up após a última mensagem do cliente.', 2.5)
  else if (onlyOneFollowupAfterLastContact)
    aplicar('apenas_um_followup_apos_ultima_msg_cliente', 'Conversa parada há mais de 1 dia com apenas 1 follow-up após a última mensagem do cliente.', 1.5)
  if (firstFollowupDelayedMoreThan1Day)
    aplicar('primeiro_followup_tardio', 'O primeiro follow-up após a última mensagem do cliente demorou mais de 1 dia.', 1.2)
  if (sameDayReplyFailures > 0) {
    const perda = clamp(Number((sameDayReplyFailures * 0.7).toFixed(2)), 0.7, 2.1)
    aplicar('nao_respondeu_mesmo_dia', `Houve ${sameDayReplyFailures} caso(s) em que o lead falou em horário útil e o consultor só retomou em outro dia.`, perda)
  }
  if (linkFollowupDelayFailures > 0) {
    const perda = clamp(Number((linkFollowupDelayFailures * 1.0).toFixed(2)), 1.0, 2.5)
    aplicar('link_sem_followup_rapido', `Houve ${linkFollowupDelayFailures} caso(s) em que foi enviado link/site e o retorno demorou mais de 1 dia.`, perda)
  }
  if (weakClosingFailures > 0)
    aplicar('fechamento_fraco', 'A conversa terminou com fechamento fraco, sem próximo passo comercial claro.', 1.1)
  if (abandonmentEarlySignal)
    aplicar('abandono_precoce', 'Há sinal de abandono precoce: conversa curta, parada e sem follow-up suficiente.', 1.4)
  if (lastContactClearlyDeclined)
    penalidades.push({ codigo: 'excecao_lead_sem_interesse', descricao: 'O lead deixou claro que não quer continuar. As regras de follow-up pesado não devem ser penalizadas nesse caso.', pontos_perdidos: 0 })

  scoreInterno = Number(clamp(Number(scoreInterno.toFixed(2)), 0, 10))
  const alertas = penalidades.filter((p) => p.pontos_perdidos > 0).map((p) => p.descricao)

  const resumoParaIA = [
    `Score interno das regras comerciais: ${scoreInterno}/10.`,
    `Conversa parada há mais de 1 dia: ${conversationStoppedMoreThan1Day ? 'sim' : 'não'}.`,
    `Lead deixou claro que não quer: ${lastContactClearlyDeclined ? 'sim' : 'não'}.`,
    `Follow-ups após a última mensagem do cliente: ${totalFollowupsAfterLastContact}.`,
    `Primeiro follow-up após a última mensagem do cliente (horas): ${firstFollowupDelayHours ?? 'n/a'}.`,
    `Respostas acima de 1h em horário útil: ${respostasAcima1h}.`,
    `Mensagem pendente >1h em horário útil: ${base.mensagem_pendente_ha_mais_de_1h_horario_util === true ? 'sim' : 'não'}.`,
    `Falhas de resposta no mesmo dia: ${sameDayReplyFailures}.`,
    `Falhas de link sem follow-up rápido: ${linkFollowupDelayFailures}.`,
    `Fechamento fraco: ${weakClosingFailures > 0 ? 'sim' : 'não'}.`,
    `Abandono precoce: ${abandonmentEarlySignal ? 'sim' : 'não'}.`,
    alertas.length ? `Alertas principais: ${alertas.join(' | ')}` : 'Sem alertas comerciais relevantes.',
  ].join('\n')

  return {
    ...base,
    regras_comerciais: {
      total_human_messages: totalHuman,
      total_contact_messages: totalContact,
      total_user_messages: totalUser,
      conversa_parada_mais_de_1_dia: conversationStoppedMoreThan1Day,
      lead_deixou_claro_que_nao_quer: lastContactClearlyDeclined,
      total_followups_apos_ultima_msg_cliente: totalFollowupsAfterLastContact,
      zero_followup_apos_ultima_msg_cliente: zeroFollowupAfterLastContact,
      apenas_um_followup_apos_ultima_msg_cliente: onlyOneFollowupAfterLastContact,
      primeiro_followup_apos_ultima_msg_cliente_em_horas: firstFollowupDelayHours,
      regra_minimo_2_followups_descumprida: minimumTwoFollowupsBroken,
      regra_primeiro_followup_em_ate_1_dia_descumprida: firstFollowupDelayedMoreThan1Day,
      falhas_resposta_no_mesmo_dia: sameDayReplyFailures,
      falhas_link_sem_followup_rapido: linkFollowupDelayFailures,
      falha_fechamento_fraco_sem_proximo_passo: weakClosingFailures > 0,
      sinal_abandono_precoce: abandonmentEarlySignal,
      score_interno_regras_comerciais: scoreInterno,
      penalidades_aplicadas: penalidades,
      resumo_regras_para_ia: resumoParaIA,
    },
    conversa_parada_mais_de_1_dia: conversationStoppedMoreThan1Day,
    lead_deixou_claro_que_nao_quer: lastContactClearlyDeclined,
    total_followups_apos_ultima_msg_cliente: totalFollowupsAfterLastContact,
    zero_followup_apos_ultima_msg_cliente: zeroFollowupAfterLastContact,
    apenas_um_followup_apos_ultima_msg_cliente: onlyOneFollowupAfterLastContact,
    primeiro_followup_apos_ultima_msg_cliente_em_horas: firstFollowupDelayHours,
    regra_minimo_2_followups_descumprida: minimumTwoFollowupsBroken,
    regra_primeiro_followup_em_ate_1_dia_descumprida: firstFollowupDelayedMoreThan1Day,
    falhas_resposta_no_mesmo_dia: sameDayReplyFailures,
    falhas_link_sem_followup_rapido: linkFollowupDelayFailures,
    falha_fechamento_fraco_sem_proximo_passo: weakClosingFailures > 0,
    sinal_abandono_precoce: abandonmentEarlySignal,
    score_interno_regras_comerciais: scoreInterno,
    penalidades_aplicadas: penalidades,
    resumo_regras_para_ia: resumoParaIA,
  }
}

/* ───────────── Step 7: Chamar OpenAI ───────────── */

function buildPrompt(base) {
  const fase = base.fase_lead_nome || 'não identificada'
  const perdido = base.lead_perdido === true
  const grounding = String(base.knowledge_grounding || '').trim()
  const baseConhecimentoBloco = grounding
    ? `\nBASE DE CONHECIMENTO OFICIAL (fonte de verdade — trechos da nossa base de cursos, SEM preços):\n${grounding}\n`
    : '\nBASE DE CONHECIMENTO OFICIAL: indisponível para este atendimento. NÃO acuse "informação errada" por falta de base — só marque contradição interna evidente na própria conversa.\n'
  return `Você avalia a qualidade de um atendimento comercial humano via WhatsApp. Seja RIGOROSO: notas altas só para atendimentos realmente bons. Na dúvida entre duas notas, escolha a menor.

Consultor: ${base.consultor}
Fase atual do lead no funil: ${fase}${perdido ? ' (VENDA PERDIDA)' : ''}

Métricas objetivas:
- tempo_medio_resposta_segundos: ${base.tempo_medio_de_resposta}
- respostas_dentro_1h_util: ${base.respostas_dentro_1h_horario_util}
- respostas_acima_1h_util: ${base.respostas_acima_1h_horario_util}
- respostas_fora_horario: ${base.respostas_fora_horario_nao_penalizar}
- msg_pendente_mais_1h_util: ${base.mensagem_pendente_ha_mais_de_1h_horario_util}
- msg_pendente_fora_horario: ${base.mensagem_pendente_recebida_fora_horario}
- msg_pendente_domingo: ${base.mensagem_pendente_recebida_no_domingo}

Regras comerciais:
- conversa_parada_mais_1_dia: ${base.conversa_parada_mais_de_1_dia}
- lead_deixou_claro_que_nao_quer: ${base.lead_deixou_claro_que_nao_quer}
- total_followups_apos_ultima_msg_cliente: ${base.total_followups_apos_ultima_msg_cliente}
- zero_followup: ${base.zero_followup_apos_ultima_msg_cliente}
- apenas_um_followup: ${base.apenas_um_followup_apos_ultima_msg_cliente}
- primeiro_followup_horas: ${base.primeiro_followup_apos_ultima_msg_cliente_em_horas}
- minimo_2_followups_descumprido: ${base.regra_minimo_2_followups_descumprida}
- primeiro_followup_tardio: ${base.regra_primeiro_followup_em_ate_1_dia_descumprida}
- falhas_resposta_mesmo_dia: ${base.falhas_resposta_no_mesmo_dia}
- falhas_link_sem_followup: ${base.falhas_link_sem_followup_rapido}
- fechamento_fraco: ${base.falha_fechamento_fraco_sem_proximo_passo}
- abandono_precoce: ${base.sinal_abandono_precoce}
- score_regras_comerciais: ${base.score_interno_regras_comerciais}
- resumo_regras: ${base.resumo_regras_para_ia}

CONTEXTO IMPORTANTE SOBRE A CONVERSA:
- Mensagens marcadas com [MSG PRONTA] são templates prontos ("/") disparados PELO CONSULTOR. Elas contam como fala do consultor e devem ser avaliadas (qualidade da apresentação, da pergunta sobre curso de interesse, das explicações, etc.). Como são textos oficiais aprovados pela empresa, podem ser usadas como referência do que é correto.
- Mensagens marcadas com [ROBÔ - CONTEXTO, NÃO AVALIAR] são automação/salesbot (disparadas pelo sistema, NÃO pelo consultor). Servem APENAS como contexto pra você entender a conversa. NÃO as avalie, NÃO as conte como mensagem do consultor e NÃO gere pontos (positivos ou negativos) a partir delas.
${baseConhecimentoBloco}

Critérios de PENALIZAÇÃO (tempo/rotina):
1. Penalize respostas acima de 1 hora em horário útil.
2. Não penalize mensagens recebidas entre 18:00 e 08:59 em America/Sao_Paulo.
3. Não penalize domingo; domingo inteiro é fora do horário útil.
4. Penalize conversa parada há mais de 1 dia sem follow-up suficiente e primeiro follow-up acima de 1 dia.
5. Penalize quando o lead falou em horário útil e o consultor só retomou em outro dia.
6. Penalize quando enviou link/site e demorou para retomar.
7. Penalize fechamento fraco, sem próximo passo comercial claro.
8. Penalize abandono precoce.
9. NÃO penalize falta de follow-up quando o lead deixou claro que não quer continuar.
- IMPORTANTE: NÃO considere negativo o CONSULTOR ENVIAR mensagens fora do horário útil (madrugada, fim de semana, domingo). O horário em que o consultor envia NÃO é problema; só avalie a DEMORA de resposta dentro do horário útil (critério 1). Nunca gere um ponto negativo do tipo "mensagens enviadas fora do horário".

Critérios de QUALIDADE — gere pontos positivos E negativos com base neles (quando houver evidência):
10. Humanidade: preocupação genuína com o cliente, criar proximidade, empatia e engajamento na conversa (positivo se presente, negativo se robótico/frio).
11. Informação divulgada de forma ERRADA = ponto negativo (severidade alta). Compare o que o consultor afirmou (modalidade, duração, área, grau, existência de estágio, existência de grade, regras) com a BASE DE CONHECIMENTO OFICIAL acima e com as mensagens [MSG PRONTA]. Só acuse erro quando houver CONTRADIÇÃO clara com essas fontes. NÃO avalie PREÇO/valor/mensalidade (a base de preços não é confiável aqui — ignore qualquer divergência de valores). Se a base não cobre o que foi dito, não invente erro.
12. Áudios longos/confusos ou mensagens confusas e mal escritas = ponto negativo.
13. Contradição entre mensagens ao longo da conversa (diz uma coisa e depois outra) = ponto negativo.
14. Satisfação/insatisfação do cliente ao longo do atendimento (sentimento tipo NPS): reconheça sinais e aponte como positivo ou negativo.
15. Insistência na venda (importante, avalie sempre que o lead recusar):
    - Se o cliente disse que NÃO tem interesse e o consultor TENTOU reverter/insistir (contornou a objeção ou tentou ao menos mais uma vez) antes de agradecer e encerrar/mandar pra Perdido = POSITIVO ("Atendente insistiu na venda"). NÃO trate o agradecimento final como erro nesse caso.
    - Se o cliente recusou UMA vez e o consultor apenas AGRADECEU e encerrou/mandou pra Perdido SEM insistir = NEGATIVO: gere o ponto negativo "Atendente não insistiu na venda" (categoria "insistencia") e coloque na "citacao" o trecho do AGRADECIMENTO/encerramento do CONSULTOR que mostra a desistência precoce.
    - Insistir de forma inconveniente/spam, ignorando recusa clara e repetida, também é negativo.
16. Reconhecer a demora e se desculpar/dar satisfação ao cliente por ter demorado = positivo; ignorar a própria demora = negativo.
17. Qualidade das mensagens prontas (apresentação, pergunta sobre curso de interesse, explicações) = positivo ou negativo conforme a qualidade.
18. Conhecimento do tema e confiança sobre o que está falando = ponto positivo.
19. Fazer perguntas ao final das falas para estimular o cliente a responder e avançar ("O que achou?", "Podemos seguir?") = positivo; encerrar sem gancho = negativo.
20. Considere também cordialidade, clareza, objetividade, profundidade e condução comercial.

Regras de NOTA:
- Use o score e o resumo das regras como evidência objetiva, sem copiar mecanicamente a nota final.
- Se o lead está em VENDA PERDIDA, a nota deve ser MENOR: o atendimento não converteu. Reduza a nota e explique na avaliação o que pode ter contribuído para a perda.
- Se o lead está GANHO (venda fechada), reconheça os acertos que levaram à conversão; o atendimento tende a merecer nota maior, sem inflar sem evidência.
- Gere VÁRIOS pontos (não apenas um de cada): liste todos os pontos positivos e negativos que encontrar com evidência.
- NÃO repita o mesmo problema em mais de um ponto. Cada ponto (positivo ou negativo) deve tratar de um problema DISTINTO. Consolide variações do mesmo problema num ÚNICO ponto — ex.: um único ponto sobre áudio confuso (nunca dois), um único sobre demora de resposta (nunca dois).
- Em CADA ponto negativo, o campo "citacao" DEVE conter um TRECHO EXATO, copiado literalmente, de uma mensagem DO ATENDENTE/CONSULTOR (a fala com remetente "user") que causou o problema — apenas o conteúdo, sem o "data | remetente |". NUNCA cite mensagem do CLIENTE (remetente "contact") nem mensagens de contexto marcadas [ROBÔ - CONTEXTO]. O trecho citado deve ser exatamente o que fez o atendente perder nota — pode ser uma informação errada, uma contradição, OU um agradecimento/encerramento em que ele DESISTIU da venda sem insistir (ver critério 15). NÃO grife elogios nem trechos que representem um ACERTO do atendente (ex.: um agradecimento após ele ter insistido é acerto, não grife). Se o problema não tiver um trecho específico do atendente (ex.: demora pra responder), use "".

Conversa:
${base.conversation_text_for_ai}

Retorne SOMENTE JSON válido no formato:
{
  "avaliacao": "texto resumindo a avaliação geral",
  "nota_avaliacao": 0,
  "pontos_positivos": [
    { "titulo": "texto curto", "categoria": "humanidade|conhecimento|insistencia|satisfacao_cliente|qualidade_mensagem|tempo_resposta|conducao_comercial|outro", "citacao": "trecho exato ou vazio" }
  ],
  "pontos_negativos": [
    { "titulo": "texto curto", "categoria": "informacao_errada|contradicao|confusao|humanidade|tempo_resposta|followup|fechamento|insistencia|satisfacao_cliente|outro", "severidade": "alta|media|baixa", "citacao": "trecho exato da fala do ATENDENTE que causou o problema, ou vazio" }
  ]
}`
}

/**
 * Chat Completions (JSON) — avaliação do feedback comercial.
 * Retry curto em 429 / 5xx.
 */
async function callOpenAIFeedback(env, base) {
  const { key, model } = getAIConfig(env)
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY não configurada (necessária para o job de feedback comercial)',
    )
  }

  const prompt = buildPrompt(base)
  const url = 'https://api.openai.com/v1/chat/completions'
  const body = {
    model,
    temperature: 0.3,
    max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Você é um avaliador de atendimento. Responda somente com um único objeto JSON válido, sem texto fora do JSON.',
      },
      { role: 'user', content: prompt },
    ],
  }

  // Timeout pra cada attempt da OpenAI. Default 90s — chat-completions
  // raramente passa de 30s mas conexões TCP penduradas existiam antes
  // do AbortController e foi uma das causas dos runs ficarem presos.
  const openaiTimeoutMs = Number(env.FEEDBACK_JOB_OPENAI_TIMEOUT_MS || 90_000)
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
        },
        openaiTimeoutMs,
      )
    } catch (e) {
      lastErr = e
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1500 + attempt * 2000))
        continue
      }
      throw e
    }
    if (res.ok) {
      const data = await res.json()
      const content = String(data?.choices?.[0]?.message?.content || '').trim()
      const u = data?.usage || {}
      const usage = {
        prompt_tokens: Number(u.prompt_tokens || 0),
        completion_tokens: Number(u.completion_tokens || 0),
        total_tokens: Number(
          u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
        ),
      }
      return { content, usage }
    }
    const errText = await res.text().catch(() => '')
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`OpenAI ${res.status}: ${errText.slice(0, 400)}`)
      await new Promise((r) => setTimeout(r, 1500 + attempt * 2000))
      continue
    }
    lastErr = new Error(`OpenAI ${res.status}: ${errText.slice(0, 400)}`)
    break
  }
  throw lastErr || new Error('OpenAI: erro desconhecido')
}

function parseAIJson(text) {
  if (!text) return null
  const raw = String(text).trim()
  try { return JSON.parse(raw) } catch {}
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

/**
 * Normaliza a saída da IA para o novo schema (arrays de pontos +/- com
 * citação/severidade), mantendo compatibilidade com o formato antigo
 * (ponto_positivo/ponto_negativo em texto). Também:
 *  - garante nota numérica 0–10;
 *  - aplica penalidade determinística quando o lead está PERDIDO (a IA já
 *    é instruída a baixar, mas aqui garantimos independente do modelo).
 */
function normalizeAIResult(parsed, base, env = {}) {
  const p = parsed || {}

  const normPoint = (item) => {
    if (item == null) return null
    if (typeof item === 'string') {
      const t = item.trim()
      return t ? { titulo: t, categoria: 'outro', citacao: '' } : null
    }
    const titulo = String(item.titulo || item.texto || item.descricao || '').trim()
    if (!titulo) return null
    return {
      titulo,
      categoria: String(item.categoria || 'outro').trim() || 'outro',
      severidade: item.severidade ? String(item.severidade).toLowerCase() : undefined,
      citacao: String(item.citacao || '').trim(),
    }
  }

  const toArray = (arr, legacyText) => {
    let list = []
    if (Array.isArray(arr)) list = arr.map(normPoint).filter(Boolean)
    if (list.length === 0 && legacyText) {
      const t = String(legacyText).trim()
      if (t) list = [{ titulo: t, categoria: 'outro', citacao: '' }]
    }
    return list
  }

  const positivos = toArray(p.pontos_positivos, p.ponto_positivo)
  const negativos = toArray(p.pontos_negativos, p.ponto_negativo)

  // Guarda de grifo: a citação de um ponto NEGATIVO só faz sentido se for um
  // trecho de uma mensagem do ATENDENTE (consultor) — nunca do cliente nem de
  // contexto. Isso evita o dashboard grifar mensagem do cliente/agradecimento.
  // Se a citação não bater com nenhuma fala do consultor, zera (o ponto
  // continua aparecendo na lista, só não grifa nada).
  const _normText = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const _msgs = Array.isArray(base?.conversa_completa?.messages) ? base.conversa_completa.messages : []
  const _consultorTexts = _msgs
    .filter((m) => String(m.sender_type || '').toLowerCase() === 'user' && m.is_context_only !== true)
    .map((m) => _normText(m.content || m.message_text || m.media_url || ''))
    .filter((t) => t.length > 0)
  const _citacaoDeConsultor = (cit) => {
    const c = _normText(cit)
    if (c.length < 4) return false
    return _consultorTexts.some((t) => t.includes(c))
  }
  for (const neg of negativos) {
    if (neg.citacao && !_citacaoDeConsultor(neg.citacao)) neg.citacao = ''
  }

  // Limpeza de pontos: (1) o consultor ENVIAR mensagens fora do horário útil
  // não é ponto negativo (só a demora de resposta em horário útil conta);
  // (2) deduplica pontos que tratam do MESMO problema, pra a IA não avaliar a
  // mesma coisa duas vezes (ex.: dois pontos de "áudio confuso" ou de "demora").
  const _SEV = { alta: 3, media: 2, baixa: 1 }
  const _STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os', 'e', 'em', 'no', 'na', 'nos', 'nas', 'com', 'que', 'um', 'uma', 'pra', 'para', 'ao', 'aos', 'sem', 'sobre', 'muito', 'muita', 'muitos', 'muitas', 'mais', 'menos'])
  const _tok = (s) => _normText(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !_STOP.has(w))
  const _overlap = (a, b) => {
    const A = new Set(_tok(a)); const B = new Set(_tok(b))
    if (!A.size || !B.size) return 0
    let inter = 0
    for (const w of A) if (B.has(w)) inter++
    return inter / Math.min(A.size, B.size)
  }
  // Categorias que podem ter VÁRIAS instâncias distintas (erros/contradições
  // diferentes). As demais são dimensões únicas: no máximo 1 ponto por categoria.
  const _MULTI = new Set(['informacao_errada', 'contradicao', 'outro'])
  const _dedupe = (list) => {
    const out = []
    for (const item of list) {
      const cat = String(item.categoria || '').toLowerCase()
      const idx = out.findIndex((o) => {
        const oc = String(o.categoria || '').toLowerCase()
        if (cat && oc === cat && !_MULTI.has(cat)) return true
        return _overlap(o.titulo, item.titulo) >= 0.5
      })
      if (idx >= 0) {
        if ((_SEV[item.severidade] || 0) > (_SEV[out[idx].severidade] || 0)) out[idx] = item
        continue
      }
      out.push(item)
    }
    return out
  }
  const _isEnvioForaHorario = (n) => {
    const t = _normText(n.titulo)
    return /(fora do horario|horario util|fora de horario|madrugada|fim de semana|final de semana|domingo)/.test(t)
      && /(envi|mandou|mensagem|mensagens)/.test(t)
  }

  const negativosLimpos = _dedupe(negativos.filter((n) => !_isEnvioForaHorario(n)))
  const positivosLimpos = _dedupe(positivos)

  // nota numérica
  let nota = Number(p.nota_avaliacao)
  if (!Number.isFinite(nota)) nota = null

  // Penalidade determinística de venda perdida.
  if (nota != null && base?.lead_perdido === true) {
    const penalty = (() => {
      const v = Number(env.FEEDBACK_JOB_LOST_PENALTY)
      return Number.isFinite(v) && v >= 0 ? v : 1.5
    })()
    const maxNota = (() => {
      const v = Number(env.FEEDBACK_JOB_LOST_MAX_NOTA)
      return Number.isFinite(v) && v >= 0 ? v : 7
    })()
    nota = clamp(Number((nota - penalty).toFixed(2)), 0, maxNota)
  }

  // Bônus determinístico de venda GANHA (espelha a penalidade do Perdido):
  // o atendimento converteu, então tende a nota maior, com piso mínimo.
  if (nota != null && String(base?.fase_lead_categoria || '').trim().toLowerCase() === 'ganho') {
    const bonus = (() => {
      const v = Number(env.FEEDBACK_JOB_WON_BONUS)
      return Number.isFinite(v) && v >= 0 ? v : 1
    })()
    const minNota = (() => {
      const v = Number(env.FEEDBACK_JOB_WON_MIN_NOTA)
      return Number.isFinite(v) && v >= 0 ? v : 6
    })()
    nota = clamp(Number(Math.max(nota + bonus, minNota).toFixed(2)), 0, 10)
  }
  if (nota != null) nota = clamp(Number(nota.toFixed(2)), 0, 10)

  // Compat: campos texto (usados pela UI atual e por consumidores antigos).
  const joinTitulos = (list) => list.map((x) => x.titulo).filter(Boolean).join(' | ') || null

  return {
    avaliacao: p.avaliacao != null ? String(p.avaliacao) : null,
    nota_avaliacao: nota,
    pontos_positivos: positivosLimpos,
    pontos_negativos: negativosLimpos,
    ponto_positivo: joinTitulos(positivosLimpos),
    ponto_negativo: joinTitulos(negativosLimpos),
  }
}

/* ───────────── Step 8: Gravar feedback ───────────── */

async function saveFeedback(sb, base, jobExecutionId) {
  const payload = {
    contact_id: base.contact_id,
    lead_id: base.lead_id,
    consultor: base.consultor,
    conversa_completa: base.conversa_completa,
    avaliacao: base.avaliacao ?? null,
    nota_avaliacao: base.nota_avaliacao ?? null,
    ponto_positivo: base.ponto_positivo ?? null,
    ponto_negativo: base.ponto_negativo ?? null,
    pontos_positivos: base.pontos_positivos ?? null,
    pontos_negativos: base.pontos_negativos ?? null,
    fase_lead_status_id: base.fase_lead_status_id ?? null,
    fase_lead_nome: base.fase_lead_nome ?? null,
    fase_lead_categoria: base.fase_lead_categoria ?? null,
    pipeline_id: base.pipeline_id ?? null,
    lead_perdido: base.lead_perdido ?? null,
    tempo_medio_de_resposta: base.tempo_medio_de_resposta ?? null,
    job_execution_id: jobExecutionId,
    updated_at: new Date().toISOString(),
  }

  if (base.modo_gravacao === 'update' && base.registro_id_alvo != null) {
    await sb.update('comercial_feedback', `id=eq.${base.registro_id_alvo}`, payload)
    return 'updated'
  } else {
    await sb.insert('comercial_feedback', { ...payload, created_at: new Date().toISOString() })
    return 'inserted'
  }
}

async function savePendente(sb, base, jobExecutionId) {
  // Tenta update primeiro
  let filter = ''
  if (base.contact_id != null) filter = `contact_id=eq.${base.contact_id}`
  else if (base.lead_id != null) filter = `lead_id=eq.${base.lead_id}`
  else return

  const existing = await sb.select('comercial_feedback_pendente',
    `select=id&${filter}&order=updated_at.desc,id.desc&limit=1`)

  const payload = {
    contact_id: base.contact_id,
    lead_id: base.lead_id,
    consultor: base.consultor,
    conversa_pendente: base.conversa_completa,
    motivo_pendencia: base.motivo_pendencia,
    job_execution_id: jobExecutionId,
    updated_at: new Date().toISOString(),
  }

  if (existing?.[0]?.id) {
    await sb.update('comercial_feedback_pendente', `id=eq.${existing[0].id}`, payload)
  } else {
    await sb.insert('comercial_feedback_pendente', { ...payload, created_at: new Date().toISOString() })
  }
}

async function deletePendente(sb, base) {
  let filter = `consultor=eq.${encodeURIComponent(base.consultor || '')}`
  if (base.contact_id != null) filter += `&contact_id=eq.${base.contact_id}`
  else if (base.lead_id != null) filter += `&lead_id=eq.${base.lead_id}`
  else return
  await sb.delete('comercial_feedback_pendente', filter)
}

/* ───────────── Main runner ───────────── */

export async function runFeedbackJob(env, trigger = 'cron') {
  const {
    SUPABASE_URL_FEEDBACK, SUPABASE_KEY_FEEDBACK,
    FEEDBACK_JOB_WINDOW_MINUTES = '90',
    FEEDBACK_JOB_BUFFER_MINUTES = '30',
    FEEDBACK_JOB_MAX_WINDOW_MINUTES = '0',
  } = env

  if (!SUPABASE_URL_FEEDBACK || !SUPABASE_KEY_FEEDBACK) {
    throw new Error('SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  }
  const { key: aiKey, model: aiModel } = getAIConfig(env)
  if (!aiKey) {
    throw new Error(
      'OPENAI_API_KEY não configurada (necessária para o job de feedback comercial)',
    )
  }

  const supabaseTimeoutMs = Number(env.FEEDBACK_JOB_SUPABASE_TIMEOUT_MS || 60_000)
  const sb = makeSupabaseClient(SUPABASE_URL_FEEDBACK, SUPABASE_KEY_FEEDBACK, {
    timeoutMs: supabaseTimeoutMs,
  })
  const startedAt = new Date()
  const useHourSlot =
    String(env.FEEDBACK_JOB_USE_HOUR_SLOT_LOCK ?? 'true').toLowerCase() !== 'false' &&
    ['cron', 'startup_catchup', 'queued'].includes(trigger)
  const execId = useHourSlot ? makeCronHourSlotExecId(startedAt) : generateJobExecutionId()
  const steps = []
  const addStep = (type, detail) => steps.push({ type, at: new Date().toISOString(), ...detail })

  // Antes de qualquer coisa: marca como erro qualquer run preso em
  // 'running' há muito tempo (provavelmente crash do processo anterior).
  // Sem isso a UI fica mostrando 'Executando...' pra sempre e o user
  // não sabe se rodou de verdade.
  const reapAfterMin = Number(env.FEEDBACK_JOB_REAP_AFTER_MINUTES || 30)
  const reapedCount = await reapStaleRuns(sb, reapAfterMin)
  if (reapedCount > 0) {
    addStep('reaper', { count: reapedCount, max_age_minutes: reapAfterMin })
  }

  const windowInfo = await computeAdaptiveWindow(
    sb,
    Number(FEEDBACK_JOB_WINDOW_MINUTES),
    Number(FEEDBACK_JOB_BUFFER_MINUTES),
    Number(FEEDBACK_JOB_MAX_WINDOW_MINUTES) || 0,
    env,
  )

  const startedAtIso = startedAt.toISOString()
  try {
    await sb.insert('feedback_job_runs', {
      id: execId,
      started_at: startedAtIso,
      status: 'running',
      trigger,
      steps: [],
    })
  } catch (e) {
    if (useHourSlot && isUniqueViolation(e)) {
      const reclaimed = await reclaimHourSlotIfPreviousFailed(sb, execId, startedAtIso, trigger)
      if (!reclaimed) {
        console.log(
          `[FeedbackJob] Ignorado: slot ${execId} já existe (outra instância ou execução nesta hora UTC).`,
        )
        return {
          skipped: true,
          id: execId,
          reason: 'duplicate_hour_slot',
          trigger,
        }
      }
    } else {
      console.error('[FeedbackJob] Falha ao criar run:', e.message)
      throw e
    }
  }

  console.log(
    `[FeedbackJob] ▶ Iniciado ${execId} (trigger: ${trigger}) | janela=${windowInfo.window_minutes}min ` +
    `(base=${windowInfo.based_on}${windowInfo.extra_minutes_over_hour ? `, extra=${windowInfo.extra_minutes_over_hour}min` : ''})`
  )

  let totalMessagesFetched = 0
  let totalSegments = 0
  let feedbacksInserted = 0
  let feedbacksUpdated = 0
  let feedbacksSkipped = 0
  let pendentesSaved = 0
  let aiCalls = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let errorMessage = null
  let status = 'success'
  let segmentErrorCount = 0

  try {
    addStep('fetch_messages', {
      window_minutes: windowInfo.window_minutes,
      since: windowInfo.sinceIso,
      since_sp: formatInstantBrasilia(windowInfo.sinceIso),
      until: windowInfo.untilIso,
      until_sp: formatInstantBrasilia(windowInfo.untilIso),
      based_on: windowInfo.based_on,
      extra_minutes_over_hour: windowInfo.extra_minutes_over_hour,
    })
    const rawRows = await fetchRecentMessages(sb, windowInfo.sinceIso)
    totalMessagesFetched = rawRows.length
    addStep('fetch_messages_done', { count: totalMessagesFetched })
    if (totalMessagesFetched === 0) {
      console.warn(
        '[FeedbackJob] 0 mensagens na janela. Intervalo (UTC): ' +
        `${windowInfo.sinceIso} → ${windowInfo.untilIso} | ` +
        `(America/Sao_Paulo: ${formatInstantBrasilia(windowInfo.sinceIso)} → ${formatInstantBrasilia(windowInfo.untilIso)}). ` +
        'Incluímos linhas com sent_at vazio se created_at cair na janela. Verifique contact_id/lead_id.',
      )
    }

    const segments = groupIntoSegments(rawRows)
    totalSegments = segments.length
    addStep('group_segments', { count: totalSegments })

    // Carrega 1x o mapa de fases do funil (nome/categoria por status_id).
    // Em produção busca do Kommo; em dev cai no mapa estático. Nunca lança.
    const statusMap = await loadKommoStatusMap(env)

    // Skip de re-avaliação: se o atendimento já tem feedback prévio e
    // poucas mensagens humanas foram adicionadas, atualiza só conversa
    // + métricas (sem chamar a OpenAI). Evita gastar token e oscilar a
    // nota a cada nova msg. Configurável via env.
    const minNewHumanForReaval = (() => {
      const v = Number(env.FEEDBACK_JOB_REAVAL_MIN_NEW_HUMAN_MESSAGES)
      return Number.isFinite(v) && v >= 0 ? v : 2
    })()

    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx]
      const segLabel = `${seg.entity_type}:${seg.entity_id} (${seg.consultor || 'sem consultor'})`
      try {
        let base = await prepareSegmentGravacao(sb, seg)
        base = await mergeWithPendente(sb, base)
        base = validateConversa(base, env)

        if (!base.conversa_pronta_para_avaliacao) {
          await savePendente(sb, base, execId)
          pendentesSaved++
          addStep('segment_pendente', {
            segment: segLabel,
            motivo: base.motivo_pendencia,
            metricas: base.metricas_validacao,
          })
          continue
        }

        base = await computeCommercialRules(sb, base)

        // Resolve a fase do funil (nome + categoria) e marca lead perdido.
        const fase = resolveFase(statusMap, base.fase_status_id)
        base.fase_lead_status_id = fase.status_id
        base.fase_lead_nome = fase.nome
        base.fase_lead_categoria = fase.categoria
        base.lead_perdido = fase.perdido

        // Decide se vale a pena chamar OpenAI de novo. Se já tinha
        // feedback antes e nada relevante foi adicionado, mantemos a
        // avaliação anterior — só atualizamos conversa_completa e
        // métricas objetivas.
        const skipReaval =
          base.modo_gravacao === 'update' &&
          base.has_previous_feedback === true &&
          base.new_human_messages_count < minNewHumanForReaval

        if (!skipReaval) {
          // Grounding: busca na base de conhecimento (RAG, sem preço) pra o
          // avaliador conseguir apontar informação divulgada errada. Falha
          // aqui não derruba o segmento — só desliga a checagem de info errada.
          base.knowledge_grounding = null
          if (String(env.FEEDBACK_JOB_GROUNDING_ENABLED ?? 'true').toLowerCase() !== 'false') {
            try {
              const g = await fetchKnowledgeGrounding(env, base.conversation_text_for_ai, {
                maxChars: Number(env.FEEDBACK_JOB_GROUNDING_MAX_CHARS) || 4000,
              })
              base.knowledge_grounding = g.block
              if (g.error) console.warn(`[FeedbackJob] grounding indisponível (${segLabel}): ${g.error}`)
            } catch (e) {
              console.warn(`[FeedbackJob] grounding falhou (${segLabel}): ${e.message}`)
            }
          }

          aiCalls++
          const { content, usage } = await callOpenAIFeedback(env, base)
          if (usage) {
            promptTokens += usage.prompt_tokens || 0
            completionTokens += usage.completion_tokens || 0
            totalTokens += usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
          }
          const parsed = parseAIJson(content) || {}
          const norm = normalizeAIResult(parsed, base, env)
          base.avaliacao = norm.avaliacao
          base.nota_avaliacao = norm.nota_avaliacao
          base.pontos_positivos = norm.pontos_positivos
          base.pontos_negativos = norm.pontos_negativos
          base.ponto_positivo = norm.ponto_positivo
          base.ponto_negativo = norm.ponto_negativo
        } else {
          feedbacksSkipped++
        }

        const result = await saveFeedback(sb, base, execId)
        if (result === 'inserted') feedbacksInserted++
        else feedbacksUpdated++
        await deletePendente(sb, base)

        addStep('segment_feedback', {
          segment: segLabel,
          action: result,
          nota: base.nota_avaliacao,
          skipped_reaval: skipReaval,
          new_human_messages_count: base.new_human_messages_count,
          previous_human_messages_count: base.previous_human_messages_count,
        })
      } catch (e) {
        segmentErrorCount++
        addStep('segment_error', { segment: segLabel, error: e.message })
        console.error(`[FeedbackJob] Erro no segmento ${segLabel}:`, e.message)
      }
    }

    addStep('done', {})
    if (
      status === 'success' &&
      segmentErrorCount > 0 &&
      feedbacksInserted === 0 &&
      feedbacksUpdated === 0 &&
      pendentesSaved === 0
    ) {
      status = 'error'
      errorMessage =
        'Nenhum feedback gravado: todos os segmentos falharam (confira erros da OpenAI nos logs e em segment_error).'
    }
  } catch (e) {
    status = 'error'
    errorMessage = e.message
    addStep('fatal_error', { error: e.message })
    console.error('[FeedbackJob] Erro fatal:', e)
  }

  const finishedAt = new Date()
  const durationMs = finishedAt.getTime() - startedAt.getTime()

  // Resumo da janela (until permite a próxima execução continuar sem re-lêr o mesmo período)
  try {
    steps.unshift({
      type: 'window_info',
      at: startedAt.toISOString(),
      since: windowInfo.sinceIso,
      until: windowInfo.untilIso,
      window_minutes: windowInfo.window_minutes,
      based_on: windowInfo.based_on,
      extra_minutes_over_hour: windowInfo.extra_minutes_over_hour,
      last_fetch_until: windowInfo.last_fetch_until,
      last_run_started_at: windowInfo.last_run_started_at,
    })
  } catch (e) {
    console.error('[FeedbackJob] Falha ao montar window_info step:', e.message)
  }

  // Atualização final do run com retry. Esse UPDATE é CRÍTICO: se ele
  // falhar a linha fica 'Executando...' pra sempre na UI. Por isso:
  //  - blindado em try/catch (qualquer throw aqui não pode propagar);
  //  - 1 retry rápido se o Supabase estiver instável;
  //  - log explícito em caso de falha total pra facilitar diagnóstico.
  const finalPatch = {
    finished_at: finishedAt.toISOString(),
    status,
    total_messages_fetched: totalMessagesFetched,
    total_segments: totalSegments,
    feedbacks_inserted: feedbacksInserted,
    feedbacks_updated: feedbacksUpdated,
    pendentes_saved: pendentesSaved,
    ai_calls: aiCalls,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    model: aiModel,
    duration_ms: durationMs,
    error_message: errorMessage,
    steps,
  }
  let finalUpdateOk = false
  for (let attempt = 0; attempt < 2 && !finalUpdateOk; attempt++) {
    try {
      await sb.update('feedback_job_runs', `id=eq.${execId}`, finalPatch)
      finalUpdateOk = true
    } catch (e) {
      console.error(
        `[FeedbackJob] Falha ao atualizar run (attempt ${attempt + 1}/2):`,
        e.message,
      )
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }
  if (!finalUpdateOk) {
    // Última tentativa minimalista — pelo menos remove o estado 'running'
    // pra a UI não ficar travada. O reaper da próxima execução vai
    // capturar runs que nem isso conseguiram.
    try {
      await sb.update('feedback_job_runs', `id=eq.${execId}`, {
        finished_at: finishedAt.toISOString(),
        status: 'error',
        error_message:
          (errorMessage ? errorMessage + ' | ' : '') +
          'Falha ao gravar resumo final do run (Supabase indisponível). Marcado como erro pelo fallback.',
        duration_ms: durationMs,
      })
      console.warn(`[FeedbackJob] Run ${execId}: gravado em modo fallback (sem steps).`)
    } catch (e2) {
      console.error(
        `[FeedbackJob] Run ${execId}: fallback também falhou (${e2.message}). Reaper fará a limpeza na próxima execução.`,
      )
    }
  }

  try {
    console.log(`[FeedbackJob] ${status === 'success' ? '✓' : '✗'} ${execId} | ${durationMs}ms | msgs=${totalMessagesFetched} seg=${totalSegments} ins=${feedbacksInserted} upd=${feedbacksUpdated} skip=${feedbacksSkipped} pend=${pendentesSaved} ai=${aiCalls} tok=${totalTokens}`)
  } catch {
    /* logging não pode derrubar o retorno */
  }

  return {
    id: execId,
    status,
    durationMs,
    totalMessagesFetched,
    totalSegments,
    feedbacksInserted,
    feedbacksUpdated,
    feedbacksSkipped,
    pendentesSaved,
    aiCalls,
    promptTokens,
    completionTokens,
    totalTokens,
    errorMessage,
  }
}
