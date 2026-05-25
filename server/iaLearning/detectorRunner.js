// Scheduler do job detector de leads convertidos.
// Dispara 1× por dia no minuto :01 da hora IA_LEARNING_DETECTOR_CRON_HOUR_UTC (default 11 = 08:01 SP).
// Sem reaper externo (volume baixo: 1 run/dia; watchdog de 30min é suficiente).
//
// Chave de deduplicação: YYYY-MM-DD-HH (garante 1 disparo por hora-alvo por processo).

import { runDetectorJob } from './detectorJob.js'

let jobRunning = false
let pendingTrigger = false
let currentRunStartedAt = null
let currentTrigger = null
let schedulerStarted = false
let scheduledEnv = null
let lastTriggeredDayKey = null
let lastHeartbeatHourKey = null
let lastResult = null // { finishedAt, trigger, ok, novos, skipJaDetectado, errosCaptura, totalEventos, durationMs, error? }

export function getDetectorRunnerStatus() {
  return {
    running: jobRunning,
    pendingTrigger,
    startedAt: currentRunStartedAt ? currentRunStartedAt.toISOString() : null,
    trigger: currentTrigger,
    lastResult,
  }
}

export async function runOnce(env, trigger = 'manual') {
  if (jobRunning) {
    pendingTrigger = true
    console.log(`[IaLearning] Detector trigger "${trigger}" chegou com job em execução → enfileirado.`)
    return
  }
  jobRunning = true
  currentRunStartedAt = new Date()
  currentTrigger = trigger

  const watchdogMin = 30
  let watchdogFired = false
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true
    console.warn(
      `[IaLearning] ⚠ WATCHDOG: detector trigger=${trigger} excedeu ${watchdogMin}min sem retornar. ` +
      `Liberando lock local.`,
    )
    lastResult = {
      finishedAt: new Date().toISOString(),
      trigger,
      ok: false,
      error: `watchdog_${watchdogMin}min`,
      durationMs: watchdogMin * 60 * 1000,
    }
    jobRunning = false
    currentRunStartedAt = null
    currentTrigger = null
    if (pendingTrigger) {
      pendingTrigger = false
      setImmediate(() => runOnce(env, 'queued_after_watchdog'))
    }
  }, watchdogMin * 60 * 1000)

  const startMs = Date.now()
  let result = null
  let runErr = null
  try {
    result = await runDetectorJob(env, { trigger })
  } catch (e) {
    runErr = e
    console.error('[IaLearning] Detector execução falhou:', e.message)
  } finally {
    clearTimeout(watchdogTimer)
    if (!watchdogFired) {
      lastResult = {
        finishedAt: new Date().toISOString(),
        trigger,
        ok: !runErr && (result?.ok !== false),
        novos: result?.novos ?? 0,
        skipJaDetectado: result?.skipJaDetectado ?? 0,
        errosCaptura: result?.errosCaptura ?? 0,
        totalEventos: result?.totalEventos ?? 0,
        durationMs: Date.now() - startMs,
        ...(runErr ? { error: runErr.message } : (result?.reason ? { error: result.reason } : {})),
      }
      jobRunning = false
      currentRunStartedAt = null
      currentTrigger = null
      if (pendingTrigger) {
        pendingTrigger = false
        console.log('[IaLearning] Detector: disparando execução enfileirada agora.')
        setImmediate(() => runOnce(env, 'queued'))
      }
    } else {
      console.log('[IaLearning] Detector finalmente retornou após watchdog (descartando estado).')
    }
  }
}

function tick() {
  if (!scheduledEnv) return
  const now = new Date()
  const cronHour = Math.max(0, Math.min(23, Number(scheduledEnv.IA_LEARNING_DETECTOR_CRON_HOUR_UTC || 11)))
  const hour = now.getUTCHours()
  const minute = now.getUTCMinutes()

  // Heartbeat a cada 60 minutos
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${hour}`
  if (minute === 0 && hourKey !== lastHeartbeatHourKey) {
    lastHeartbeatHourKey = hourKey
    console.log(
      `[IaLearning] ♥ detector heartbeat ${now.toISOString()} | running=${jobRunning} pending=${pendingTrigger}`,
    )
  }

  // Dispara no minuto :01 da hora-alvo, 1× por dia
  const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${cronHour}`
  if (hour === cronHour && minute === 1 && dayKey !== lastTriggeredDayKey) {
    lastTriggeredDayKey = dayKey
    console.log(`[IaLearning] ⏰ detector tick :01 disparando cron às ${now.toISOString()}`)
    runOnce(scheduledEnv, 'cron')
  }
}

export function startDetectorScheduler(env) {
  if (schedulerStarted) {
    console.log('[IaLearning] Detector scheduler já estava ativo; ignorando nova chamada.')
    return false
  }

  const enabled = String(env.IA_LEARNING_ENABLED || 'true').toLowerCase() !== 'false'
  if (!enabled) {
    console.log('[IaLearning] Detector scheduler DESABILITADO via IA_LEARNING_ENABLED=false.')
    return false
  }

  scheduledEnv = env
  schedulerStarted = true

  setInterval(tick, 30 * 1000)
  setTimeout(tick, 2000)

  const cronHour = Math.max(0, Math.min(23, Number(env.IA_LEARNING_DETECTOR_CRON_HOUR_UTC || 11)))
  console.log(`[IaLearning] Detector scheduler iniciado (setInterval 30s, dispara no minuto :01 da hora ${cronHour} UTC)`)

  return true
}
