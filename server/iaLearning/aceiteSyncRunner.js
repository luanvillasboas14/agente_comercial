// Scheduler do job de sync de eventos de aceite (sem filtro por consultor).
// Dispara 1× por dia no minuto :02 da hora IA_LEARNING_ACEITE_SYNC_CRON_HOUR_UTC (default 6 UTC = 03:02 BRT, 1h após o Kommo Events).
// Watchdog de 15min. Sem reaper externo (1 run/dia, volume baixo).
//
// Chave de deduplicação: YYYY-MM-DD-HH (garante 1 disparo por hora-alvo por processo).

import { runAceiteSyncJob } from './aceiteSyncJob.js'

let jobRunning = false
let currentStartedAt = null
let currentTrigger = null
let schedulerStarted = false
let scheduledEnv = null
let lastTriggeredDayKey = null
let lastHeartbeatHourKey = null
let lastResult = null // { finishedAt, trigger, ok, totalEventos, totalAceites, totalInseridos, totalPaginas, durationMs, error? }

export function getAceiteSyncStatus() {
  return {
    running: jobRunning,
    startedAt: currentStartedAt ? currentStartedAt.toISOString() : null,
    trigger: currentTrigger,
    lastResult,
  }
}

export async function runOnce(env, trigger = 'manual') {
  if (jobRunning) {
    console.log(`[IaLearning/aceiteSync] trigger "${trigger}" chegou com job em execução — ignorando.`)
    return
  }
  jobRunning = true
  currentStartedAt = new Date()
  currentTrigger = trigger

  const WATCHDOG_MIN = Math.max(5, Number(env.IA_LEARNING_ACEITE_SYNC_WATCHDOG_MIN || 30))
  let watchdogFired = false
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true
    console.warn(
      `[IaLearning/aceiteSync] ⚠ WATCHDOG: trigger=${trigger} excedeu ${WATCHDOG_MIN}min sem retornar. Liberando lock.`,
    )
    lastResult = {
      finishedAt: new Date().toISOString(),
      trigger,
      ok: false,
      error: `watchdog_${WATCHDOG_MIN}min`,
      durationMs: WATCHDOG_MIN * 60 * 1000,
    }
    jobRunning = false
    currentStartedAt = null
    currentTrigger = null
  }, WATCHDOG_MIN * 60 * 1000)

  const startMs = Date.now()
  let result = null
  let runErr = null

  try {
    result = await runAceiteSyncJob(env, { trigger })
  } catch (e) {
    runErr = e
    console.error('[IaLearning/aceiteSync] execução falhou:', e.message)
  } finally {
    clearTimeout(watchdogTimer)
    if (!watchdogFired) {
      let errorMsg = null
      if (runErr) errorMsg = runErr.message
      else if (result?.reason) errorMsg = result.error ? `${result.reason}: ${result.error}` : result.reason

      lastResult = {
        finishedAt: new Date().toISOString(),
        trigger,
        ok: !runErr && (result?.ok !== false),
        totalEventos: result?.totalEventos ?? 0,
        totalAceites: result?.totalAceites ?? 0,
        totalInseridos: result?.totalInseridos ?? 0,
        totalPaginas: result?.totalPaginas ?? 0,
        durationMs: Date.now() - startMs,
        ...(errorMsg ? { error: errorMsg } : {}),
      }
      jobRunning = false
      currentStartedAt = null
      currentTrigger = null
    } else {
      console.log('[IaLearning/aceiteSync] retornou após watchdog — descartando estado.')
    }
  }
}

function tick() {
  if (!scheduledEnv) return
  const now = new Date()
  const cronHour = Math.max(0, Math.min(23, Number(scheduledEnv.IA_LEARNING_ACEITE_SYNC_CRON_HOUR_UTC || 6)))
  const hour = now.getUTCHours()
  const minute = now.getUTCMinutes()

  // Heartbeat a cada 60 minutos
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${hour}`
  if (minute === 0 && hourKey !== lastHeartbeatHourKey) {
    lastHeartbeatHourKey = hourKey
    console.log(
      `[IaLearning/aceiteSync] ♥ heartbeat ${now.toISOString()} | running=${jobRunning}`,
    )
  }

  // Dispara no minuto :02 da hora-alvo, 1× por dia
  const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${cronHour}`
  if (hour === cronHour && minute === 2 && dayKey !== lastTriggeredDayKey) {
    lastTriggeredDayKey = dayKey
    console.log(`[IaLearning/aceiteSync] ⏰ tick :02 disparando cron às ${now.toISOString()}`)
    runOnce(scheduledEnv, 'cron')
  }
}

export function startAceiteSyncScheduler(env) {
  if (schedulerStarted) {
    console.log('[IaLearning/aceiteSync] Scheduler já estava ativo; ignorando nova chamada.')
    return false
  }

  const enabled = String(env.IA_LEARNING_ACEITE_SYNC_ENABLED || 'true').toLowerCase() !== 'false'
  if (!enabled) {
    console.log('[IaLearning/aceiteSync] Scheduler DESABILITADO via IA_LEARNING_ACEITE_SYNC_ENABLED=false.')
    return false
  }

  scheduledEnv = env
  schedulerStarted = true

  setInterval(tick, 30 * 1000)
  setTimeout(tick, 2000)

  const cronHour = Math.max(0, Math.min(23, Number(env.IA_LEARNING_ACEITE_SYNC_CRON_HOUR_UTC || 6)))
  console.log(
    `[IaLearning/aceiteSync] Scheduler iniciado (setInterval 30s, dispara no minuto :02 da hora ${cronHour} UTC)`,
  )

  return true
}
