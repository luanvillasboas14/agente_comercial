/**
 * Utilitários de concorrência para o webhook Evolution.
 *
 * - seenMessage(id): dedupe por `message.key.id` (ttl em memória).
 * - withSessionLock(sessionId, fn): serializa execuções por sessão (per-phone)
 *   para evitar duas chamadas ao agente / WhatsApp simultâneas.
 *
 * Tudo em memória do processo. Se um dia rodarmos com múltiplas instâncias do
 * servidor, isso precisa migrar para Redis/Supabase. Enquanto é single-process,
 * é o suficiente e simples.
 */

const DEDUPE_TTL_MS = 1000 * 60 * 60 * 6
const DEDUPE_MAX_ENTRIES = 20000

const seen = new Map()

function purgeExpired(now = Date.now()) {
  if (seen.size < DEDUPE_MAX_ENTRIES) return
  for (const [id, exp] of seen) {
    if (exp <= now) seen.delete(id)
  }
  if (seen.size < DEDUPE_MAX_ENTRIES) return
  const overflow = seen.size - Math.floor(DEDUPE_MAX_ENTRIES * 0.9)
  let removed = 0
  for (const id of seen.keys()) {
    seen.delete(id)
    if (++removed >= overflow) break
  }
}

/**
 * Retorna `true` se o id já foi visto (deve ignorar); `false` caso contrário
 * (já registrando como visto). Se id for vazio/null, retorna `false` (não
 * consegue deduplicar sem id, então processa normalmente).
 */
export function seenMessage(id) {
  if (!id) return false
  const key = String(id)
  const now = Date.now()
  const exp = seen.get(key)
  if (exp && exp > now) return true
  purgeExpired(now)
  seen.set(key, now + DEDUPE_TTL_MS)
  return false
}

export function resetDedupe() {
  seen.clear()
}

const locks = new Map()

/**
 * Serializa execuções por chave (ex.: sessionId do WhatsApp). A callback só
 * começa depois que a anterior terminar. Se a callback lançar, o erro é
 * propagado para o chamador atual e a fila continua.
 */
export function withSessionLock(sessionId, fn) {
  const key = String(sessionId || '').trim() || '__anon__'
  const prev = locks.get(key) || Promise.resolve()
  const next = prev.catch(() => undefined).then(() => fn())
  const tracked = next.finally(() => {
    if (locks.get(key) === tracked) locks.delete(key)
  })
  locks.set(key, tracked)
  return tracked
}

export function hasSessionLock(sessionId) {
  return locks.has(String(sessionId || ''))
}
