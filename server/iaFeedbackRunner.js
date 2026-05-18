/**
 * Fila e worker do Feedback IA.
 *
 * Não usa setInterval — é puramente event-driven:
 *   1. enqueueLeadForEvaluation() adiciona à fila.
 *   2. setImmediate processa em série (1 item por vez).
 *
 * Cada item processado:
 *   - Cria job_execution_id (UUID v4 via crypto.randomUUID).
 *   - Grava ia_feedback_job_runs com status='running'.
 *   - Chama evaluateLead.
 *   - Atualiza run com status='success'|'error' e contadores.
 */

import crypto from 'crypto'
import { evaluateLead } from './iaFeedbackJob.js'

let storedEnv = null
let queue = []
let running = false
let currentLeadId = null

// ─── Supabase helpers (independentes) ────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
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

function makeRunsClient(env) {
  const url = (env.SUPABASE_URL_FEEDBACK || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY_FEEDBACK || ''
  if (!url || !key) return null

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  }

  async function req(method, path, body, extra = {}) {
    const res = await fetchWithTimeout(
      `${url}${path}`,
      { method, headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined },
      30_000,
    )
    const text = await res.text()
    if (!res.ok) throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }

  return {
    insertRun: (row) => req('POST', '/rest/v1/ia_feedback_job_runs', row, { Prefer: 'return=representation' }),
    updateRun: (id, patch) =>
      req('PATCH', `/rest/v1/ia_feedback_job_runs?id=eq.${id}`, patch, { Prefer: 'return=minimal' }),
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

async function processNext() {
  if (running || queue.length === 0) return
  if (!storedEnv) {
    console.warn('[iaFeedbackRunner] processNext chamado antes de startIaFeedbackRunner.')
    return
  }

  running = true
  const item = queue.shift()
  currentLeadId = item.leadId

  const jobExecutionId = crypto.randomUUID()
  const startedAt = new Date()
  const db = makeRunsClient(storedEnv)

  // Grava linha de run inicial e captura o ID gerado
  let runDbId = null
  if (db) {
    try {
      const inserted = await db.insertRun({
        started_at: startedAt.toISOString(),
        status: 'running',
        trigger: 'scheduler_diff',
        leads_detectados: 1,
        steps: [{ type: 'start', at: startedAt.toISOString(), lead_id: item.leadId }],
      })
      runDbId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id
    } catch (err) {
      console.warn('[iaFeedbackRunner] Falha ao criar run:', err.message)
    }
  }

  let status = 'success'
  let errorMsg = null
  let avaliacoesInseridas = 0
  let aiCalls = 0
  let errorsCount = 0
  const steps = [{ type: 'start', at: startedAt.toISOString(), lead_id: item.leadId }]

  try {
    const result = await evaluateLead(storedEnv, {
      leadId: item.leadId,
      telefone: item.telefone,
      statusIdFrom: item.statusIdFrom,
      pipelineIdFrom: item.pipelineIdFrom,
      detectedAt: item.detectedAt,
      jobExecutionId,
    })

    if (result.action === 'avaliado') {
      avaliacoesInseridas = 1
      aiCalls = 1
      steps.push({ type: 'avaliado', lead_id: item.leadId, nota: result.nota, veredito: result.veredito })
    } else if (result.action === 'erro') {
      avaliacoesInseridas = 1
      errorsCount = 1
      steps.push({ type: 'erro', lead_id: item.leadId, motivo: result.motivo })
    } else if (result.action === 'skipped') {
      steps.push({ type: 'skipped', lead_id: item.leadId, motivo: result.motivo })
    }

    if (!result.ok && result.action !== 'erro') {
      errorsCount = 1
    }
  } catch (err) {
    status = 'error'
    errorMsg = err.message
    errorsCount = 1
    steps.push({ type: 'error', lead_id: item.leadId, error: err.message })
    console.error(`[iaFeedbackRunner] Erro ao avaliar lead=${item.leadId}:`, err.message)
  }

  const finishedAt = new Date()
  const durationMs = finishedAt.getTime() - startedAt.getTime()

  // Atualiza run com resultado final (com retry)
  if (db && runDbId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await db.updateRun(runDbId, {
          finished_at: finishedAt.toISOString(),
          status,
          duration_ms: durationMs,
          avaliacoes_inseridas: avaliacoesInseridas,
          ai_calls: aiCalls,
          errors_count: errorsCount,
          steps,
        })
        break
      } catch (err) {
        console.warn(`[iaFeedbackRunner] Falha ao atualizar run (attempt ${attempt + 1}/2):`, err.message)
        if (attempt < 1) await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }

  running = false
  currentLeadId = null

  // Processa próximo item da fila, se houver
  if (queue.length > 0) {
    setImmediate(processNext)
  }
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Inicia o runner. Idempotente — pode ser chamado várias vezes.
 */
export function startIaFeedbackRunner(env) {
  if (storedEnv) {
    console.log('[iaFeedbackRunner] Runner já iniciado; ignorando nova chamada.')
    return
  }
  storedEnv = env
  console.log('[iaFeedbackRunner] Runner iniciado (event-driven, aguarda enqueue).')
}

/**
 * Adiciona um lead à fila de avaliação.
 */
export function enqueueLeadForEvaluation({ leadId, telefone, statusIdFrom, pipelineIdFrom, detectedAt }) {
  queue.push({ leadId, telefone, statusIdFrom, pipelineIdFrom, detectedAt: detectedAt || new Date() })
  setImmediate(processNext)
}

/**
 * Retorna status atual do runner.
 */
export function getIaFeedbackRunnerStatus() {
  return {
    queueSize: queue.length,
    running,
    currentLeadId: currentLeadId ?? null,
  }
}
