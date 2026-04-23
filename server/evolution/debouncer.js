/**
 * Debounce por sessão (telefone/JID), equivalente ao node "Wait" do n8n.
 *
 * Cada mensagem recebida chama scheduleFlush(); o timer da sessão é reiniciado
 * a cada nova mensagem. Quando o tempo acaba sem novidades, o callback dispara
 * — nesse ponto você deve ler o buffer do Redis, juntar as mensagens e limpar.
 */

const timers = new Map()
const pendingFlushes = new Map()

export function getDebounceMs(env) {
  const raw = env.MESSAGE_DEBOUNCE_SECONDS ?? env.MESSAGE_DEBOUNCE_MS
  let ms
  if (env.MESSAGE_DEBOUNCE_MS && !env.MESSAGE_DEBOUNCE_SECONDS) {
    ms = Number(env.MESSAGE_DEBOUNCE_MS)
  } else {
    const seconds = Number(raw)
    ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15000
  }
  if (!Number.isFinite(ms) || ms <= 0) ms = 15000
  return ms
}

export function scheduleFlush(sessionId, flushFn, env) {
  if (!sessionId || typeof flushFn !== 'function') return

  const delay = getDebounceMs(env)

  const existing = timers.get(sessionId)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(async () => {
    timers.delete(sessionId)
    if (pendingFlushes.get(sessionId)) return
    pendingFlushes.set(sessionId, true)
    try {
      await flushFn(sessionId)
    } catch (err) {
      console.error(`[Debouncer] flush error (${sessionId}):`, err.message)
    } finally {
      pendingFlushes.delete(sessionId)
    }
  }, delay)

  timers.set(sessionId, timer)
}

export function cancelFlush(sessionId) {
  const t = timers.get(sessionId)
  if (t) {
    clearTimeout(t)
    timers.delete(sessionId)
  }
}

export function hasPendingFlush(sessionId) {
  return timers.has(sessionId) || pendingFlushes.has(sessionId)
}
