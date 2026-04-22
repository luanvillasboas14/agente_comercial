// Runner compartilhado entre server.js (produção) e vite.config.js (dev).
// Scheduler baseado em setInterval (mais robusto que node-cron em containers).
//
// Regras:
//  - Verifica a cada 30s; dispara no minuto :01 UTC de toda hora (1× por hora).
//  - Catch-up no startup: só se FEEDBACK_JOB_STARTUP_CATCHUP=true (default false),
//    para não duplicar com o cron ao reiniciar.
//  - Uma execução “cron” por hora UTC no cluster: runFeedbackJob usa id FB-HOURUTC-…
//    (insert único; outras instâncias ignoram).
//  - Guard contra execuções paralelas no mesmo processo + fila de 1 pendente.

import { runFeedbackJob, getFeedbackJobPreview } from './feedbackJob.js'

let jobRunning = false
let pendingTrigger = false
let currentRunStartedAt = null
let schedulerStarted = false
let scheduledEnv = null
let lastTriggeredHourKey = null
let lastHeartbeatMinute = null

export async function runOnce(env, trigger = 'manual') {
  if (jobRunning) {
    pendingTrigger = true
    console.log(`[FeedbackJob] Trigger "${trigger}" chegou com job em execução → enfileirado.`)
    return
  }
  jobRunning = true
  currentRunStartedAt = new Date()
  try {
    await runFeedbackJob(env, trigger)
  } catch (e) {
    console.error('[FeedbackJob] Execução falhou:', e.message)
  } finally {
    jobRunning = false
    currentRunStartedAt = null
    if (pendingTrigger) {
      pendingTrigger = false
      console.log('[FeedbackJob] Disparando execução enfileirada agora.')
      setImmediate(() => runOnce(env, 'queued'))
    }
  }
}

// Faz o check de minuto em minuto. Retorna true se disparou.
function tick() {
  if (!scheduledEnv) return
  const now = new Date()
  const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`
  const minute = now.getMinutes()

  // Heartbeat a cada 10 minutos pra ajudar no debug nos logs do Easypanel
  const minuteKey = `${hourKey}-${minute}`
  if (minute % 10 === 0 && minuteKey !== lastHeartbeatMinute) {
    lastHeartbeatMinute = minuteKey
    console.log(
      `[FeedbackJob] ♥ heartbeat ${now.toISOString()} | running=${jobRunning} pending=${pendingTrigger}`
    )
  }

  // Dispara no minuto :01 de cada hora, 1x por hora
  if (minute === 1 && hourKey !== lastTriggeredHourKey) {
    lastTriggeredHourKey = hourKey
    console.log(`[FeedbackJob] ⏰ tick :01 disparando cron às ${now.toISOString()}`)
    runOnce(scheduledEnv, 'cron')
  }
}

// No startup, catch-up opcional (desligado por padrão — evita triplicar com cron + réplicas).
async function catchUpOnStartup(env) {
  const allow = String(env.FEEDBACK_JOB_STARTUP_CATCHUP || '').toLowerCase() === 'true'
  if (!allow) {
    console.log('[FeedbackJob] Startup catch-up desligado (FEEDBACK_JOB_STARTUP_CATCHUP≠true).')
    return
  }
  try {
    const preview = await getFeedbackJobPreview(env)
    const lastRun = preview?.lastRun
    const lastStart = lastRun?.started_at ? new Date(lastRun.started_at) : null
    const minutesSinceLastRun = lastStart
      ? Math.round((Date.now() - lastStart.getTime()) / 60000)
      : Infinity

    if (minutesSinceLastRun > 60) {
      console.log(
        `[FeedbackJob] Último run foi há ${minutesSinceLastRun === Infinity ? 'nunca' : minutesSinceLastRun + 'min'}; ` +
        `disparando catch-up imediato.`
      )
      const now = new Date()
      lastTriggeredHourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`
      runOnce(env, 'startup_catchup')
    } else {
      console.log(
        `[FeedbackJob] Último run foi há ${minutesSinceLastRun}min; aguardando próximo :01.`
      )
    }
  } catch (e) {
    console.error('[FeedbackJob] catch-up check falhou, seguindo com scheduler normal:', e.message)
  }
}

export function startScheduler(env) {
  if (schedulerStarted) {
    console.log('[FeedbackJob] Scheduler já estava ativo; ignorando nova chamada.')
    return false
  }
  const enabled = String(env.FEEDBACK_JOB_ENABLED || 'true').toLowerCase() !== 'false'
  if (!enabled) {
    console.log('[FeedbackJob] cron DESABILITADO via FEEDBACK_JOB_ENABLED=false.')
    return false
  }
  scheduledEnv = env
  schedulerStarted = true

  // Interval de 30s pra não depender de precisão fina
  setInterval(tick, 30 * 1000)
  // Primeiro tick rápido pra ver o heartbeat nos logs
  setTimeout(tick, 2000)

  console.log('[FeedbackJob] Scheduler iniciado (setInterval 30s, dispara no minuto :01 de cada hora)')

  // Catch-up não-bloqueante
  setImmediate(() => catchUpOnStartup(env))

  return true
}

export function isCronEnabled(env) {
  return String(env.FEEDBACK_JOB_ENABLED || 'true').toLowerCase() !== 'false'
}

function getNextCronRun() {
  const now = new Date()
  const next = new Date(now)
  next.setSeconds(0, 0)
  next.setMinutes(1)
  if (next <= now) next.setHours(next.getHours() + 1)
  return next
}

export async function getStatus(env) {
  const cronEnabled = isCronEnabled(env)
  const preview = await getFeedbackJobPreview(env)
  return {
    cronEnabled,
    schedulerStarted,
    isRunning: jobRunning,
    hasPending: pendingTrigger,
    currentRunStartedAt: currentRunStartedAt?.toISOString() || null,
    nextRunAt: cronEnabled ? getNextCronRun().toISOString() : null,
    cronExpression: '1 * * * *',
    ...preview,
    serverNow: new Date().toISOString(),
  }
}
