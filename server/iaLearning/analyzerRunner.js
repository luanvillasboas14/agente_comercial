/**
 * Runner do batchAnalyzer com estado in-memory.
 * Mesmo padrão do detectorRunner: dispara em background, expõe status
 * pra UI fazer polling sem bloquear a request HTTP (que pode estourar
 * timeout do proxy quando o batch é grande).
 */

import { runBatchAnalysis } from './batchAnalyzer.js'

let jobRunning = false
let currentStartedAt = null
let currentTrigger = null
let lastResult = null // { finishedAt, trigger, durationMs, ok, ...result }

export function getAnalyzerRunnerStatus() {
  return {
    running: jobRunning,
    startedAt: currentStartedAt ? currentStartedAt.toISOString() : null,
    trigger: currentTrigger,
    lastResult,
  }
}

export async function runAnalyzerOnce(env, trigger = 'manual') {
  if (jobRunning) {
    console.log(`[IaLearning] Analyzer trigger "${trigger}" chegou com job em execução → ignorado.`)
    return { skipped: true, reason: 'already_running' }
  }
  jobRunning = true
  currentStartedAt = new Date()
  currentTrigger = trigger
  const startMs = Date.now()

  // Watchdog: o3-mini pode demorar minutos pra batches grandes; 20min é margem confortável.
  const watchdogMin = 20
  let watchdogFired = false
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true
    console.warn(`[IaLearning] ⚠ WATCHDOG: analyzer trigger=${trigger} excedeu ${watchdogMin}min. Liberando lock.`)
    lastResult = {
      finishedAt: new Date().toISOString(),
      trigger,
      ok: false,
      error: `watchdog_${watchdogMin}min`,
      durationMs: watchdogMin * 60 * 1000,
    }
    jobRunning = false
    currentStartedAt = null
    currentTrigger = null
  }, watchdogMin * 60 * 1000)

  let result = null
  let runErr = null
  try {
    result = await runBatchAnalysis(env, { trigger })
  } catch (e) {
    runErr = e
    console.error('[IaLearning] Analyzer execução falhou:', e.message)
  } finally {
    clearTimeout(watchdogTimer)
    if (!watchdogFired) {
      lastResult = {
        finishedAt: new Date().toISOString(),
        trigger,
        durationMs: Date.now() - startMs,
        ok: !runErr && (result?.ok !== false),
        ...(result || {}),
        ...(runErr ? { error: runErr.message } : {}),
      }
      jobRunning = false
      currentStartedAt = null
      currentTrigger = null
    } else {
      console.log('[IaLearning] Analyzer retornou após watchdog (descartando estado).')
    }
  }
}
