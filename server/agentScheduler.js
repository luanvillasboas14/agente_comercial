/**
 * Agent Scheduler — substitui o gate por-mensagem.
 *
 * Em vez de checar Kommo a cada mensagem que chega no webhook (caro e
 * sensível ao delay do Kommo pra movimentar leads de fase), a gente roda
 * um loop a cada KOMMO_SCHEDULER_INTERVAL_SEC segundos:
 *
 *   1. Lista leads no pipeline + status configurados (1 chamada paginada).
 *   2. Bulk-fetch dos contatos pra extrair telefone (1 chamada).
 *   3. Pra cada lead nesse funil:
 *        - lê o buffer de mensagens dessa sessão.
 *        - se tem mensagem E última mensagem é mais antiga que o debounce
 *          (KOMMO_SCHEDULER_DEBOUNCE_SEC), processa via flushSession passando
 *          o leadId já conhecido (evita re-chamar findLeadByPhone).
 *
 * Vantagens:
 *   • 1 call no Kommo a cada 30s, não importa quantas mensagens cheguem.
 *   • Tolerante a delay: se o lead foi movido pro funil DEPOIS de mandar
 *     mensagem, próximo tick pega ele com a mensagem ainda no buffer.
 *   • Mensagens de leads que nunca entram no funil expiram via TTL do Redis
 *     (default 10 min, MESSAGE_BUFFER_TTL_SEC).
 *
 * Envs:
 *   KOMMO_AGENT_PIPELINE_ID            (obrig.) ex: 11685120
 *   KOMMO_AGENT_STATUS_ID              (obrig.) ex: 89820300
 *   KOMMO_SCHEDULER_INTERVAL_SEC=30    intervalo entre ticks
 *   KOMMO_SCHEDULER_DEBOUNCE_SEC=15    silêncio mínimo após última mensagem
 *   KOMMO_SCHEDULER_ENABLED=true       chave geral pra ligar/desligar
 *   KOMMO_INBOUND_POLL_ENABLED=true     opcional: preenche buffer a partir do Kommo
 *                                       (eventos v4 de chat antes das notas quando
 *                                       KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS está ligado).
 *   KOMMO_INBOUND_POLL_MODE=notes        notes | both | events | dispatcher | amojo
 *   KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS  com mode=notes, false = só GET …/notes (sem events)
 *   KOMMO_INBOUND_POLL_ALSO_POLL_EVENTS  com mode=both, true = também poll de eventos v4
 *   KOMMO_INBOUND_POLL_NOTES_TAIL_SEED_ON_WARMUP  default true — evita buffer vazio quando
 *                                       o maior id de nota é do agente acima da última msg do cliente.
 *   KOMMO_INBOUND_POLL_NOTE_TYPES=…     tipos de nota considerados inbound (default inclui common)
 *   KOMMO_CHANNEL_SECRET / SCOPE_ID    só p/ mode=amojo (histórico Chats)
 *   KOMMO_LEAD_CHAT_MAP={"19884275":"uuid-chat"}  opcional — chat_id por lead
 *   KOMMO_AGENT_TEST_LEAD_IDS          (opcional) whitelist CSV de lead ids em teste
 *   KOMMO_SCHEDULER_VERBOSE=true       loga URLs longas do poll quando buffer vazio
 *                                      (senão só 1 linha resumida por lead).
 */

import { listLeadsByStatus, bulkGetContactsByIds, extractContactPhone } from './kommoClient.js'
import { detectExits } from './iaFeedbackQueue.js'
import { enqueueLeadForEvaluation } from './iaFeedbackRunner.js'
import { phoneToWhatsAppSessionId } from './phoneWhatsApp.js'
import { getMessages, getLastTouchedAt } from './evolution/messageBuffer.js'
import { flushSession } from './evolution/webhookEvolution.js'
import {
  syncKommoInboundToBuffer,
  isKommoInboundPollEnabled,
  normalizeKommoInboundPollMode,
  isKommoInboundPollDebugLead,
} from './kommoInboundPoll.js'
import {
  formatPollDiagLine,
  formatEventsDiagLine,
  formatDispatcherDiagLine,
} from './kommoInboundDiagnostics.js'

function isIaFeedbackEnabled(env) {
  return String(env.IA_FEEDBACK_ENABLED || 'true').toLowerCase() !== 'false'
}

// Defaults agressivos pra reduzir latência ponta-a-ponta.
// - Interval: a cada 10s o scheduler verifica se há leads c/ msgs prontas.
// - Debounce: 5s de silêncio é suficiente pra agrupar mensagens
//   "soltas" do mesmo lead e evitar processar a meio. Se a operação
//   precisar de janelas maiores (ex.: leads que digitam devagar),
//   ajustar via env KOMMO_SCHEDULER_DEBOUNCE_SEC.
const DEFAULT_INTERVAL_SEC = 10
const DEFAULT_DEBOUNCE_SEC = 5

// Janela noturna (horário de Brasília): das 22h às 6h o scheduler roda mais
// devagar pra aliviar as requisições ao Kommo (evita bloqueio por excesso).
// O timer de base continua igual; a gente só "pula" ticks pra espaçar as
// rodadas durante a janela. Tudo configurável por env.
const DEFAULT_NIGHT_START_HOUR_BRT = 22
const DEFAULT_NIGHT_END_HOUR_BRT = 6
const DEFAULT_NIGHT_INTERVAL_SEC = 30

let intervalHandle = null
let running = false
let lastRunMs = 0

/** Evita flood: aviso de funil vazio no máx. 1x / 90s. */
let lastEmptyFunnelWarnMs = 0

function isSchedulerVerbose(env) {
  return ['true', '1', 'yes'].includes(String(env.KOMMO_SCHEDULER_VERBOSE || '').trim().toLowerCase())
}

function getIntervalMs(env) {
  const v = Number(env.KOMMO_SCHEDULER_INTERVAL_SEC)
  const sec = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_INTERVAL_SEC
  return sec * 1000
}

function getDebounceMs(env) {
  const v = Number(env.KOMMO_SCHEDULER_DEBOUNCE_SEC)
  const sec = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_DEBOUNCE_SEC
  return sec * 1000
}

/** Config da janela noturna (horário de Brasília). */
function getNightThrottle(env) {
  const hour = (k, def) => {
    const v = Number(env[k])
    return Number.isFinite(v) && v >= 0 && v <= 23 ? Math.floor(v) : def
  }
  const iv = Number(env.KOMMO_SCHEDULER_NIGHT_INTERVAL_SEC)
  const intervalSec = Number.isFinite(iv) && iv > 0 ? Math.floor(iv) : DEFAULT_NIGHT_INTERVAL_SEC
  return {
    enabled: String(env.KOMMO_SCHEDULER_NIGHT_THROTTLE_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    startHour: hour('KOMMO_SCHEDULER_NIGHT_START_HOUR_BRT', DEFAULT_NIGHT_START_HOUR_BRT),
    endHour: hour('KOMMO_SCHEDULER_NIGHT_END_HOUR_BRT', DEFAULT_NIGHT_END_HOUR_BRT),
    intervalMs: intervalSec * 1000,
  }
}

/** Hora atual (0-23) no fuso America/Sao_Paulo, com fallback pra hora local. */
function saoPauloHourNow() {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
    }).format(new Date())
    let h = parseInt(s, 10)
    if (h === 24) h = 0
    return Number.isFinite(h) ? h : new Date().getHours()
  } catch {
    return new Date().getHours()
  }
}

/** Janela pode cruzar a meia-noite (ex.: 22h → 6h). */
function inNightWindow(hour, start, end) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** Retorna { throttle, intervalMs } indicando se estamos na janela noturna. */
function isNightThrottled(env) {
  const cfg = getNightThrottle(env)
  if (!cfg.enabled) return { throttle: false, intervalMs: 0 }
  return { throttle: inNightWindow(saoPauloHourNow(), cfg.startHour, cfg.endHour), intervalMs: cfg.intervalMs }
}

function isEnabled(env) {
  const flag = String(env.KOMMO_SCHEDULER_ENABLED || '').trim().toLowerCase()
  if (flag === 'false' || flag === '0' || flag === 'no') return false
  // Sem pipeline/status configurados não tem como filtrar — desabilita.
  if (!env.KOMMO_AGENT_PIPELINE_ID || !env.KOMMO_AGENT_STATUS_ID) return false
  if (!env.KOMMO_BASE_URL || !env.KOMMO_ACCESS_TOKEN) return false
  return true
}

function buildSessionId(phone) {
  return phoneToWhatsAppSessionId(phone)
}

function getTestLeadWhitelist(env) {
  const raw = String(env.KOMMO_AGENT_TEST_LEAD_IDS || '').trim()
  if (!raw) return null
  const ids = raw
    .split(/[,\s;]+/)
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return ids.length > 0 ? new Set(ids) : null
}

/**
 * Executa um único tick do scheduler.
 *
 * @returns {Promise<{leadsInFunnel:number, processed:number, skippedDebounce:number, skippedNoMessages:number, errors:number}>}
 */
export async function runSchedulerTick(env) {
  const stats = { leadsInFunnel: 0, processed: 0, skippedDebounce: 0, skippedNoMessages: 0, skippedNotInWhitelist: 0, errors: 0 }
  if (!isEnabled(env)) return stats

  const pipelineId = Number(env.KOMMO_AGENT_PIPELINE_ID)
  const statusId = Number(env.KOMMO_AGENT_STATUS_ID)
  const debounceMs = getDebounceMs(env)
  const whitelist = getTestLeadWhitelist(env)

  // 1) Listar leads no funil/status
  const listing = await listLeadsByStatus(env, { pipelineId, statusId })
  if (!listing.ok) {
    console.error('[scheduler] kommo list falhou:', listing.error || listing.status)
    return stats
  }
  const leadsAll = listing.leads || []
  stats.leadsInFunnel = leadsAll.length

  // ── Feedback IA: detecção de saídas ──────────────────────────────────────
  if (isIaFeedbackEnabled(env)) {
    try {
      const currentIds = leadsAll.map((l) => Number(l.id)).filter(Number.isFinite)
      const exited = await detectExits(env, currentIds, Number(env.KOMMO_AGENT_STATUS_ID))
      for (const leadId of exited) {
        enqueueLeadForEvaluation({
          leadId,
          statusIdFrom: Number(env.KOMMO_AGENT_STATUS_ID),
          pipelineIdFrom: Number(env.KOMMO_AGENT_PIPELINE_ID),
          detectedAt: new Date(),
        })
      }
      if (exited.length > 0) {
        console.log(`[scheduler] ia_feedback enfileirou ${exited.length} lead(s) que sairam do status`)
      }
    } catch (err) {
      console.error('[scheduler] ia_feedback diff falhou:', err.message)
    }
  }

  // Whitelist de teste: descarta leads fora da lista ANTES do bulk de
  // contatos, evitando 1 chamada Kommo extra à toa.
  let leads = leadsAll
  if (whitelist) {
    leads = leadsAll.filter((l) => whitelist.has(Number(l.id)))
    stats.skippedNotInWhitelist = leadsAll.length - leads.length
    if (stats.skippedNotInWhitelist > 0) {
      console.log(`[scheduler] whitelist ativa — ${leads.length}/${leadsAll.length} leads passaram (ids permitidos: ${[...whitelist].join(',')})`)
    }
  }
  if (!leads.length) {
    const now = Date.now()
    if (now - lastEmptyFunnelWarnMs > 90_000) {
      lastEmptyFunnelWarnMs = now
      console.warn(
        `[scheduler] nenhum lead em pipeline_id=${pipelineId} status_id=${statusId}. ` +
          'O poll de notas/eventos NAO roda para leads fora dessa etapa. ' +
          'Confira no Kommo se o lead esta exatamente neste status (automacoes "TI Movido para..." podem tirar o lead da etapa que a IA escuta). ' +
          'Ajuste KOMMO_AGENT_PIPELINE_ID / KOMMO_AGENT_STATUS_ID ou realoque o lead.',
      )
    }
    return stats
  }

  // 2) Coletar contact IDs e bulk-fetch
  const contactIds = []
  for (const lead of leads) {
    const cs = lead?._embedded?.contacts || []
    for (const c of cs) {
      if (Number.isFinite(Number(c.id))) contactIds.push(Number(c.id))
    }
  }
  const contactById = new Map()
  if (contactIds.length > 0) {
    const bulk = await bulkGetContactsByIds(env, contactIds)
    if (bulk.ok) {
      for (const c of bulk.contacts) contactById.set(Number(c.id), c)
    } else {
      console.warn('[scheduler] bulkGetContactsByIds falhou:', bulk.error || bulk.status)
    }
  }

  // 3) Pra cada lead, achar telefone, ver buffer, processar se tiver fila
  // pronta. Processamos em paralelo mas com lock por sessão (no flushSession).
  const tasks = leads.map(async (lead) => {
    try {
      const cs = lead?._embedded?.contacts || []
      let phone = null
      /** Contato cujo telefone bate com a sessão — usado no poll de eventos entity=contact. */
      let contactIdForPoll = null
      for (const c of cs) {
        const detail = contactById.get(Number(c.id))
        if (!detail) continue
        const p = extractContactPhone(detail)
        if (p) {
          phone = p
          contactIdForPoll = Number(c.id)
          break
        }
      }
      if (!phone) return
      const sessionId = buildSessionId(phone)
      if (!sessionId) return

      const syncRes = await syncKommoInboundToBuffer(env, {
        leadId: Number(lead.id),
        sessionId,
        phone,
        contactId:
          contactIdForPoll != null && Number.isFinite(contactIdForPoll) && contactIdForPoll > 0
            ? contactIdForPoll
            : null,
      })
      if (isKommoInboundPollDebugLead(env, Number(lead.id))) {
        console.log(
          `[scheduler][debug] pós-sync lead=${lead.id} session=${sessionId} pushed=${syncRes.pushed} byMode=${JSON.stringify(syncRes.byMode)}`,
        )
      }

      // Lê messages e o lastTouchedAt em paralelo — são entradas
      // separadas no buffer (Redis/Supabase) e independentes.
      const [messages, last] = await Promise.all([
        getMessages(env, sessionId),
        getLastTouchedAt(env, sessionId),
      ])
      if (!messages || messages.length === 0) {
        stats.skippedNoMessages += 1
        const pollOn = isKommoInboundPollEnabled(env)
        const mode = normalizeKommoInboundPollMode(env.KOMMO_INBOUND_POLL_MODE)
        const showDetail = Boolean(whitelist) || isSchedulerVerbose(env)
        // Antes o diag só rodava com KOMMO_AGENT_TEST_LEAD_IDS — em produção
        // ficava silencioso e parecia que "nada executava". Sempre logamos 1
        // linha; URLs longas só com whitelist ou KOMMO_SCHEDULER_VERBOSE=true.
        console.log(
          `[scheduler] buffer vazio session=${sessionId} lead=${lead.id} mode=${pollOn ? mode : 'webhook'} — sem inbound novo neste tick.`,
        )
        if (pollOn && showDetail) {
          if (mode === 'dispatcher') {
            console.log(formatDispatcherDiagLine(lead.id))
          } else if (mode === 'events') {
            console.log(formatEventsDiagLine(lead.id))
          } else if (mode === 'both') {
            console.log(formatPollDiagLine(lead.id))
            console.log(formatEventsDiagLine(lead.id))
          } else if (mode === 'all') {
            console.log(formatPollDiagLine(lead.id))
            console.log(formatEventsDiagLine(lead.id))
            console.log(formatDispatcherDiagLine(lead.id))
          } else if (mode === 'amojo') {
            console.log(`[poll-kommo][diag] lead=${lead.id} mode=amojo — verifique KOMMO_CHANNEL_SECRET / SCOPE_ID / chat_id`)
          } else {
            console.log(formatPollDiagLine(lead.id))
          }
        }
        return
      }
      const ageMs = last ? Date.now() - last.getTime() : Infinity
      if (ageMs < debounceMs) {
        stats.skippedDebounce += 1
        return
      }

      console.log(`[scheduler] flush ${sessionId} lead=${lead.id} (${messages.length} msgs, idade=${Math.round(ageMs / 1000)}s)`)
      await flushSession(env, sessionId, { leadIdHint: lead.id })
      stats.processed += 1
    } catch (err) {
      stats.errors += 1
      console.error('[scheduler] erro processando lead', lead?.id, err.message)
    }
  })

  await Promise.all(tasks)
  return stats
}

/**
 * Inicia o loop. Idempotente — chama várias vezes não cria múltiplos timers.
 */
export function startAgentScheduler(env) {
  if (intervalHandle) return { started: false, reason: 'already_running' }
  if (!isEnabled(env)) {
    return { started: false, reason: 'disabled (faltam KOMMO_AGENT_PIPELINE_ID / KOMMO_AGENT_STATUS_ID / token)' }
  }
  const intervalMs = getIntervalMs(env)
  const tick = () => {
    if (running) return // skip se o tick anterior ainda tá rodando
    // Na janela noturna, espaça as rodadas (ex.: 30s) pra aliviar o Kommo.
    const night = isNightThrottled(env)
    if (night.throttle && Date.now() - lastRunMs < night.intervalMs) return
    running = true
    lastRunMs = Date.now()
    runSchedulerTick(env)
      .then((stats) => {
        if (stats.processed > 0 || stats.errors > 0) {
          const wl = stats.skippedNotInWhitelist ? `, ${stats.skippedNotInWhitelist} fora da whitelist` : ''
          console.log(
            `[scheduler] tick: ${stats.leadsInFunnel} no funil, ${stats.processed} processados, ${stats.skippedDebounce} aguardando debounce, ${stats.skippedNoMessages} sem msg${wl}, ${stats.errors} erros`,
          )
        }
      })
      .catch((err) => console.error('[scheduler] tick exception:', err.message))
      .finally(() => { running = false })
  }
  intervalHandle = setInterval(tick, intervalMs)
  // Roda um tick depois de 5s pra não competir com o boot.
  setTimeout(tick, 5000)
  const nightCfg = getNightThrottle(env)
  const nightLog = nightCfg.enabled
    ? `, noturno ${nightCfg.startHour}h-${nightCfg.endHour}h BRT=${Math.round(nightCfg.intervalMs / 1000)}s`
    : ''
  console.log(`[scheduler] iniciado (intervalo=${Math.round(intervalMs / 1000)}s, debounce=${Math.round(getDebounceMs(env) / 1000)}s${nightLog})`)
  return { started: true, intervalMs }
}

export function stopAgentScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  running = false
}

export function isSchedulerRunning() {
  return Boolean(intervalHandle)
}
