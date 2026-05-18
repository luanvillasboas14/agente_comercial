/**
 * Gerenciamento do snapshot diff para detecção de saída de leads.
 *
 * Mantém um snapshot dos leads presentes em KOMMO_AGENT_STATUS_ID.
 * A cada tick do agentScheduler, compara o snapshot anterior com a lista
 * atual: quem sumiu → enfileira avaliação de IA.
 *
 * Backend: Redis (mesma config de messageBuffer.js) com fallback em memória.
 * Primeira execução com snapshot vazio não retorna ninguém como "saída"
 * (evita falso positivo de 100 leads na ativação).
 */

import Redis from 'ioredis'

const SNAPSHOT_KEY_PREFIX = 'ia_feedback:snapshot:status:'

// Fallback em memória por statusId → Set<number>
const memorySnapshots = new Map()

// Singleton do cliente Redis
let redisClient = null
let redisAvailable = false
let redisInitAttempted = false

function buildRedisClient(env) {
  const commonOpts = {
    lazyConnect: true,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => {
      if (times > 3) return null
      return Math.min(times * 200, 2000)
    },
    connectTimeout: 3000,
    enableOfflineQueue: false,
  }
  if (env.REDIS_URL) return new Redis(env.REDIS_URL, commonOpts)
  if (!env.REDIS_HOST) return null
  return new Redis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    db: Number(env.REDIS_DB || 0),
    tls: String(env.REDIS_TLS || '').toLowerCase() === 'true' ? {} : undefined,
    ...commonOpts,
  })
}

async function getRedis(env) {
  if (redisAvailable && redisClient) return redisClient
  if (redisInitAttempted) return null

  if (!env.REDIS_URL && !env.REDIS_HOST) {
    redisInitAttempted = true
    return null
  }

  redisInitAttempted = true
  try {
    const client = buildRedisClient(env)
    if (!client) return null

    client.on('error', (err) => {
      if (redisAvailable) {
        console.warn('[iaFeedbackQueue] Redis error:', err.message)
      }
      redisAvailable = false
    })

    await Promise.race([
      (async () => { await client.connect(); await client.ping() })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connect timeout')), 3500),
      ),
    ])

    redisClient = client
    redisAvailable = true
    console.log('[iaFeedbackQueue] Redis conectado para snapshots de ia_feedback.')
    return client
  } catch (err) {
    console.warn('[iaFeedbackQueue] Redis indisponível — usando fallback em memória:', err.message)
    redisAvailable = false
    return null
  }
}

/**
 * Lê o snapshot anterior para um statusId.
 * Retorna Set<number> com os leadIds do snapshot anterior.
 * Retorna null se não houver snapshot gravado (primeira execução).
 */
export async function getLastSnapshot(env, statusId) {
  const redis = await getRedis(env)
  if (redis && redisAvailable) {
    try {
      const key = `${SNAPSHOT_KEY_PREFIX}${statusId}`
      const raw = await redis.get(key)
      if (raw == null) return null
      const arr = JSON.parse(raw)
      return new Set(Array.isArray(arr) ? arr.map(Number) : [])
    } catch (err) {
      console.warn('[iaFeedbackQueue] Falha ao ler snapshot do Redis, caindo para memória:', err.message)
    }
  }

  // Fallback memória
  const mem = memorySnapshots.get(statusId)
  return mem !== undefined ? new Set(mem) : null
}

/**
 * Grava o snapshot atual no Redis (ou memória como fallback).
 */
export async function saveSnapshot(env, statusId, leadIds) {
  const arr = Array.from(leadIds).map(Number)
  const redis = await getRedis(env)
  if (redis && redisAvailable) {
    try {
      const key = `${SNAPSHOT_KEY_PREFIX}${statusId}`
      await redis.set(key, JSON.stringify(arr))
      return
    } catch (err) {
      console.warn('[iaFeedbackQueue] Falha ao salvar snapshot no Redis, usando memória:', err.message)
    }
  }

  // Fallback memória
  memorySnapshots.set(statusId, arr)
}

/**
 * Detecta saídas: lê snapshot anterior, compara com lista atual.
 * Salva novo snapshot no final.
 *
 * IMPORTANTE: Na primeira execução (snapshot == null), NÃO retorna ninguém
 * como "saída" — apenas popula o snapshot. Evita falso positivo ao ativar
 * a feature com 100 leads já no funil.
 *
 * @param {object} env
 * @param {number[]} currentLeadIds — IDs de leads atualmente no statusId
 * @param {number} statusId
 * @returns {Promise<number[]>} IDs que saíram desde o último snapshot
 */
export async function detectExits(env, currentLeadIds, statusId) {
  const current = new Set(currentLeadIds.map(Number).filter(Number.isFinite))
  const previous = await getLastSnapshot(env, statusId)

  // Sempre salva o snapshot atual antes de retornar
  await saveSnapshot(env, statusId, current)

  // Primeira execução: snapshot vazio → não disparar falsos positivos
  if (previous === null) {
    console.log(`[iaFeedbackQueue] Primeiro snapshot para status ${statusId}: ${current.size} lead(s) registrados. Sem exits neste tick.`)
    return []
  }

  const exited = []
  for (const id of previous) {
    if (!current.has(id)) {
      exited.push(id)
    }
  }

  return exited
}
