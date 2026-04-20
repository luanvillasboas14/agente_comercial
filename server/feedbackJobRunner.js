// Runner compartilhado entre server.js (produção) e vite.config.js (dev).
// Contém:
//  - Scheduler com node-cron
//  - Queue de 1 execução pendente (nunca descarta cron disparado)
//  - Guard em memória contra execuções paralelas no mesmo processo
//  - Endpoint-ready: getStatus() para alimentar a UI

import cron from 'node-cron'
import { runFeedbackJob, getFeedbackJobPreview } from './feedbackJob.js'

let jobRunning = false
let pendingTrigger = false
let currentRunStartedAt = null
let schedulerStarted = false
let scheduledEnv = null

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
  // Minuto 1 de cada hora (ex: 00:01, 01:01, 02:01...)
  cron.schedule('1 * * * *', () => runOnce(scheduledEnv, 'cron'))
  schedulerStarted = true
  console.log('[FeedbackJob] Cron agendado: 1 * * * * (toda hora no minuto 1)')
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
