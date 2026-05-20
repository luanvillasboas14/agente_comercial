// Scheduler do job de auditoria diária de eventos Kommo.
// Dispara 1× por dia no minuto :01 da hora KOMMO_EVENTS_CRON_HOUR_UTC (default 5 = 05:01 UTC).
// Sem reaper externo (volume baixo: 1 run/dia; watchdog de 60min é suficiente).
//
// Chave de deduplicação: YYYY-MM-DD-HH (garante 1 disparo por hora-alvo, mesmo com N réplicas
// que não compartilhem banco — lock suficiente pra 1 processo).

import { runKommoEventsJob, getRecentRuns } from './kommoEventsJob.js'

let jobRunning = false
let pendingTrigger = false
let currentRunStartedAt = null
let schedulerStarted = false
let scheduledEnv = null
let lastTriggeredDayKey = null
let lastHeartbeatHourKey = null

export async function runOnce(env, trigger = 'manual') {
  if (jobRunning) {
    pendingTrigger = true
    console.log(`[KommoEvents] Trigger "${trigger}" chegou com job em execução → enfileirado.`)
    return
  }
  jobRunning = true
  currentRunStartedAt = new Date()

  const watchdogMin = Math.max(5, Number(env.KOMMO_EVENTS_WATCHDOG_MINUTES || 60))
  let watchdogFired = false
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true
    console.warn(
      `[KommoEvents] ⚠ WATCHDOG: job ${trigger} excedeu ${watchdogMin} min sem retornar. ` +
      `Liberando lock local. O Promise continua rodando — quando terminar, vai ignorar. ` +
      `Verifique logs do Easypanel pra ver onde travou.`,
    )
    jobRunning = false
    currentRunStartedAt = null
    if (pendingTrigger) {
      pendingTrigger = false
      setImmediate(() => runOnce(env, 'queued_after_watchdog'))
    }
  }, watchdogMin * 60 * 1000)

  try {
    await runKommoEventsJob(env, { trigger })
  } catch (e) {
    console.error('[KommoEvents] Execução falhou:', e.message)
  } finally {
    clearTimeout(watchdogTimer)
    if (!watchdogFired) {
      jobRunning = false
      currentRunStartedAt = null
      if (pendingTrigger) {
        pendingTrigger = false
        console.log('[KommoEvents] Disparando execução enfileirada agora.')
        setImmediate(() => runOnce(env, 'queued'))
      }
    } else {
      console.log('[KommoEvents] Job finalmente retornou após watchdog (descartando estado).')
    }
  }
}

function tick() {
  if (!scheduledEnv) return
  const now = new Date()
  const cronHour = Math.max(0, Math.min(23, Number(scheduledEnv.KOMMO_EVENTS_CRON_HOUR_UTC || 5)))
  const hour = now.getUTCHours()
  const minute = now.getUTCMinutes()

  // Heartbeat a cada 60 minutos (job é raro; não precisa de heartbeat frequente)
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${hour}`
  if (minute === 0 && hourKey !== lastHeartbeatHourKey) {
    lastHeartbeatHourKey = hourKey
    console.log(
      `[KommoEvents] ♥ heartbeat ${now.toISOString()} | running=${jobRunning} pending=${pendingTrigger}`,
    )
  }

  // Dispara no minuto :01 da hora-alvo, 1× por dia (chave inclui data + hora-alvo)
  const dayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${cronHour}`
  if (hour === cronHour && minute === 1 && dayKey !== lastTriggeredDayKey) {
    lastTriggeredDayKey = dayKey
    console.log(`[KommoEvents] ⏰ tick :01 disparando cron às ${now.toISOString()}`)
    runOnce(scheduledEnv, 'cron')
  }
}

async function catchUpOnStartup(env) {
  const allow = String(env.KOMMO_EVENTS_STARTUP_CATCHUP || 'false').toLowerCase() === 'true'
  if (!allow) {
    console.log('[KommoEvents] Startup catch-up desligado (KOMMO_EVENTS_STARTUP_CATCHUP≠true).')
    return
  }
  try {
    const runs = await getRecentRuns(env, 1)
    const lastRun = runs[0]
    const lastStart = lastRun?.started_at ? new Date(lastRun.started_at) : null
    const hoursSinceLastRun = lastStart
      ? (Date.now() - lastStart.getTime()) / 3_600_000
      : Infinity

    if (hoursSinceLastRun > 25) {
      console.log(
        `[KommoEvents] Último run foi há ${hoursSinceLastRun === Infinity ? 'nunca' : Math.round(hoursSinceLastRun) + 'h'}; ` +
        `disparando catch-up imediato.`,
      )
      const now = new Date()
      const cronHour = Math.max(0, Math.min(23, Number(env.KOMMO_EVENTS_CRON_HOUR_UTC || 5)))
      lastTriggeredDayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${cronHour}`
      runOnce(env, 'startup_catchup')
    } else {
      console.log(`[KommoEvents] Último run foi há ${Math.round(hoursSinceLastRun)}h; aguardando próximo :01.`)
    }
  } catch (e) {
    console.error('[KommoEvents] catch-up check falhou, seguindo com scheduler normal:', e.message)
  }
}

export function startKommoEventsScheduler(env) {
  if (schedulerStarted) {
    console.log('[KommoEvents] Scheduler já estava ativo; ignorando nova chamada.')
    return false
  }
  const enabled = String(env.KOMMO_EVENTS_ENABLED || 'true').toLowerCase() !== 'false'
  if (!enabled) {
    console.log('[KommoEvents] cron DESABILITADO via KOMMO_EVENTS_ENABLED=false.')
    return false
  }
  scheduledEnv = env
  schedulerStarted = true

  setInterval(tick, 30 * 1000)
  setTimeout(tick, 2000)

  const cronHour = Math.max(0, Math.min(23, Number(env.KOMMO_EVENTS_CRON_HOUR_UTC || 5)))
  console.log(`[KommoEvents] Scheduler iniciado (setInterval 30s, dispara no minuto :01 da hora ${cronHour} UTC)`)

  setImmediate(() => catchUpOnStartup(env))

  return true
}

export function isKommoEventsCronEnabled(env) {
  return String(env.KOMMO_EVENTS_ENABLED || 'true').toLowerCase() !== 'false'
}

export function getKommoEventsStatus(env) {
  const cronEnabled = isKommoEventsCronEnabled(env)
  const cronHour = Math.max(0, Math.min(23, Number((env || scheduledEnv || {}).KOMMO_EVENTS_CRON_HOUR_UTC || 5)))
  return {
    cronEnabled,
    schedulerStarted,
    isRunning: jobRunning,
    hasPending: pendingTrigger,
    currentRunStartedAt: currentRunStartedAt?.toISOString() || null,
    cronExpression: `1 ${cronHour} * * *`,
    serverNow: new Date().toISOString(),
  }
}
